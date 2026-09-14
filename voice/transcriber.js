/**
 * voice/transcriber.js — whisper-server の起動管理と /inference 呼び出し（Issue #64）
 *
 * 役割は 2 つ。
 *
 *   起動管理  voice プロセス起動時（listen 後）に指定ポートへ疎通を試み、応答が無ければ
 *             `child_process.spawn` で whisper-server を起動する。既に動いていたものは
 *             「自分のものではない」扱いにして、voice プロセス終了時にも止めない。
 *             落ちたら（child の exit）1 回だけ再起動を試み、それでも駄目なら `down` のまま
 *             次の `join` を待つ（index.js が join のたびに start() を呼び直す）。
 *
 *   文字起こし  発話ごとの WAV を `POST /inference` に投げて `text` を trim して返す。
 *             whisper-server は同時リクエストを捌けない前提なので、到着順に 1 本ずつ
 *             直列に処理する内部キューを持つ。処理待ちが上限を超えたら古いものから捨てる。
 *
 * 状態は 'down' | 'starting' | 'ready' の 3 値。index.js の `status` 応答にそのまま使う。
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { loadVoiceConfig } from './config.js'

// whisper-server への疎通確認（health check）のタイムアウト。
const HEALTH_TIMEOUT_MS = 2_000
// 起動してからポートが応答するまで待つ上限。モデル読み込みぶんの余裕を見てある。
const START_TIMEOUT_MS = 20_000
const START_POLL_INTERVAL_MS = 300
// /inference 呼び出しのタイムアウト。実測は 1 発話あたり約 2.5 秒（#61 の実験結果）。
const TRANSCRIBE_TIMEOUT_MS = 30_000
// 文字起こしの処理待ちがこれを超えたら、古いものから捨てる。
const MAX_QUEUE = 5

function log(...parts) {
  console.log(`[${new Date().toISOString()}] whisper: ${parts.join(' ')}`)
}

function expandHome(path) {
  if (typeof path !== 'string' || path.length === 0) return path
  if (path === '~') return homedir()
  if (path.startsWith('~/')) return join(homedir(), path.slice(2))
  return path
}

// ---------------------------------------------------------------------------
// 起動管理
// ---------------------------------------------------------------------------

/** @type {'down' | 'starting' | 'ready'} */
let state = 'down'
let baseUrl = null
/** 自分で spawn した whisper-server。既に動いていたものを見つけただけのときは null のまま。 */
let ownedProcess = null
/** shutdown 中は child の exit を再起動のトリガーにしない。 */
let stopping = false
/** 1 回の起動ライフサイクルで再起動を試したか。start() のたびにリセットする。 */
let restartUsed = false
/** start() の多重起動防止。進行中の起動があれば同じ Promise を返す。 */
let startPromise = null

export function status() {
  return state
}

async function checkHealth(url) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS)
  try {
    await fetch(url, { signal: controller.signal })
    return true
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

async function waitForReady(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await checkHealth(url)) return true
    await sleep(START_POLL_INTERVAL_MS)
  }
  return false
}

function buildArgs(cfg, modelPath, vadPath) {
  const extra = Array.isArray(cfg.extraArgs) ? cfg.extraArgs : []
  return ['-m', modelPath, '-l', cfg.language, '--vad', '-vm', vadPath, '--port', String(cfg.port), '--host', '127.0.0.1', ...extra]
}

async function spawnAndWait(cfg) {
  const modelPath = expandHome(cfg.model)
  const vadPath = expandHome(cfg.vadModel)

  if (!modelPath || !existsSync(modelPath)) {
    log(`warn: モデルファイルが見つからないため起動しません: ${modelPath || '(未設定)'}（scripts/setup-voice.sh を実行してください）`)
    state = 'down'
    return
  }
  if (!vadPath || !existsSync(vadPath)) {
    log(`warn: VAD モデルファイルが見つからないため起動しません: ${vadPath || '(未設定)'}（scripts/setup-voice.sh を実行してください）`)
    state = 'down'
    return
  }

  state = 'starting'
  const args = buildArgs(cfg, modelPath, vadPath)
  log(`起動します: ${cfg.binary} ${args.join(' ')}`)

  let child
  try {
    // stdout/stderr は voice 自身の fd にそのまま流す（inherit）。標準出力への集約は
    // spawn 側（channel、または手動起動時のリダイレクト）に任せる決まりのため。
    child = spawn(cfg.binary, args, { stdio: ['ignore', 'inherit', 'inherit'] })
  } catch (err) {
    log(`warn: 起動コマンドの実行に失敗しました: ${err?.message ?? err}`)
    state = 'down'
    return
  }

  ownedProcess = child
  let failedToLaunch = false

  child.once('error', err => {
    // ENOENT（binary が無い）などはここに来る。
    log(`warn: 起動に失敗しました（${err?.code ?? err?.message ?? err}）`)
    if (ownedProcess === child) ownedProcess = null
    failedToLaunch = true
    state = 'down'
  })

  child.once('exit', (code, signal) => {
    if (ownedProcess !== child) return // 既に置き換わっている（起動失敗後の再起動など）
    ownedProcess = null
    if (stopping) return // shutdown による意図的な終了
    log(`終了しました（code=${code ?? '-'} signal=${signal ?? '-'}）`)
    attemptRestart(cfg)
  })

  const ready = await waitForReady(`${baseUrl}/`, START_TIMEOUT_MS)
  if (failedToLaunch) return
  if (ready) {
    state = 'ready'
    log('準備ができました')
  } else {
    log(`warn: ${START_TIMEOUT_MS / 1000} 秒以内に起動しませんでした`)
    state = 'down'
  }
}

function attemptRestart(cfg) {
  state = 'down'
  if (restartUsed) {
    log('warn: 再起動にも失敗しました。次の join まで再試行しません')
    return
  }
  restartUsed = true
  log('再起動を試みます')
  spawnAndWait(cfg).catch(err => log(`warn: 再起動処理で例外が発生しました: ${err?.message ?? err}`))
}

async function doStart(cfg) {
  baseUrl = `http://127.0.0.1:${cfg.port}`
  state = 'starting'
  const reachable = await checkHealth(`${baseUrl}/`)
  if (reachable) {
    // 既に動いているものは自分のものではないので、shutdown 時に止めない。
    ownedProcess = null
    state = 'ready'
    log(`既に起動している whisper-server を利用します: ${baseUrl}`)
    return
  }
  restartUsed = false
  await spawnAndWait(cfg)
}

/**
 * whisper-server への疎通を確認し、必要なら起動する。voice プロセス起動時（listen 後）と、
 * 各 join のたびに（down のままなら再試行するために）呼ぶ。既に ready/starting なら何もしない。
 */
export function start() {
  if (startPromise) return startPromise
  if (state === 'ready') return Promise.resolve()
  const cfg = loadVoiceConfig().whisper
  startPromise = doStart(cfg)
    .catch(err => log(`warn: 起動処理で例外が発生しました: ${err?.message ?? err}`))
    .finally(() => {
      startPromise = null
    })
  return startPromise
}

/** voice プロセスの shutdown から呼ぶ。自分で起動した whisper-server だけ SIGTERM で止める。 */
export function stop() {
  if (!ownedProcess) return
  stopping = true
  log('自分で起動した whisper-server を停止します')
  try {
    ownedProcess.kill('SIGTERM')
  } catch (err) {
    log(`warn: 停止に失敗しました: ${err?.message ?? err}`)
  }
}

// ---------------------------------------------------------------------------
// 文字起こし（直列キュー）
// ---------------------------------------------------------------------------

/** @type {{ wav: Buffer, resolve: (text: string) => void, reject: (err: Error) => void }[]} */
const queue = []
let draining = false

async function callInference(wav) {
  const cfg = loadVoiceConfig().whisper
  const form = new FormData()
  form.append('file', new Blob([wav], { type: 'audio/wav' }), 'utterance.wav')
  form.append('response_format', 'json')
  form.append('language', cfg.language)

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TRANSCRIBE_TIMEOUT_MS)
  try {
    const res = await fetch(`http://127.0.0.1:${cfg.port}/inference`, {
      method: 'POST',
      body: form,
      signal: controller.signal,
    })
    if (!res.ok) throw new Error(`whisper-server が ${res.status} を返しました`)
    const data = await res.json()
    return typeof data?.text === 'string' ? data.text.trim() : ''
  } finally {
    clearTimeout(timer)
  }
}

async function drain() {
  if (draining) return
  draining = true
  try {
    while (queue.length > 0) {
      const job = queue.shift()
      try {
        job.resolve(await callInference(job.wav))
      } catch (err) {
        job.reject(err instanceof Error ? err : new Error(String(err)))
      }
    }
  } finally {
    draining = false
  }
}

/**
 * 発話 1 件を文字起こしする。到着順に 1 本ずつ直列で処理する。
 * 処理待ちが {@link MAX_QUEUE} 本を超えたら、古いものから捨てて警告ログを出す
 * （捨てられた発話の Promise は reject される）。
 * @param {Buffer} wav
 * @returns {Promise<string>} trim 済みのテキスト（空文字なら発話なしとして扱ってよい）
 */
export function transcribe(wav) {
  return new Promise((resolve, reject) => {
    if (queue.length >= MAX_QUEUE) {
      const dropped = queue.shift()
      log(`warn: 文字起こしの処理待ちが上限（${MAX_QUEUE}）を超えたので、古い発話を1件破棄しました`)
      dropped.reject(new Error('処理待ちが多すぎたため破棄されました'))
    }
    queue.push({ wav, resolve, reject })
    void drain()
  })
}
