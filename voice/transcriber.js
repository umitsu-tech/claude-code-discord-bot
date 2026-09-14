/**
 * voice/transcriber.js — whisper-server の起動管理と /inference 呼び出し（Issue #64）
 *
 * 役割は 2 つ。
 *
 *   起動管理  voice プロセス起動時（listen 後）に指定ポートへ疎通を試み（GET /health）、応答が無ければ
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
 *
 * 起動系の設計メモ（レビュー指摘を反映、2026-09-14）
 *
 * - start() と、child が落ちたときの自動再起動（attemptRestart）は同じ `startPromise`（単一の
 *   進行中 Promise）を共有する。再起動中に join が来て start() が呼ばれても、進行中の
 *   Promise をそのまま返すだけで新しく spawn しない（さもないと whisper-server が二重に立ち、
 *   先発の child が孤児になる）
 * - spawn するたびに `generation` を 1 つ進め、その世代番号を `ownedGeneration` に持たせる。
 *   child の 'exit' はこの世代が一致するときだけ処理する。タイムアウトで自分から kill した
 *   child の exit や、既に置き換わった古い child の exit を再起動のトリガーにしないため
 * - 起動タイムアウト（既定 60 秒、`voice.json` の `whisper.startTimeoutS` で変更可）を超えたら、
 *   居座られると次の join の疎通確認で「既存のもの」と誤認され、shutdown 時に止められなくなるので、
 *   child を明示的に SIGTERM で止める
 * - child の 'error'（ENOENT など）が来たら Promise.race で起動待ちを即座に打ち切る
 * - restartUsed（クラッシュへの自動再起動を使い切ったかのフラグ）は、再起動した whisper-server が
 *   ready に到達した時点でリセットする。「クラッシュ 1 回につき自動再起動 1 回」を、
 *   何度クラッシュしても保つため
 * - 既存の whisper-server を利用しているケース（自分で spawn していない）では child の exit を
 *   監視できない。/inference の呼び出しが接続エラー（ECONNREFUSED 等、HTTP エラーではなく
 *   ネットワーク層の失敗）で落ちたときに state を down にするのが、このケースの唯一の検知手段になる
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { loadVoiceConfig } from './config.js'

// whisper-server への疎通確認（health check）のタイムアウト。
const HEALTH_TIMEOUT_MS = 2_000
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
/** ownedProcess が指す child の世代番号。ownedProcess が自分のものでなくなったら -1 に戻す。 */
let ownedGeneration = -1
/** spawn するたびに 1 つ進む。child の exit ハンドラが「自分より新しい世代に置き換わっていないか」を見るのに使う。 */
let generation = 0
/** shutdown 中は child の exit を再起動のトリガーにしない。 */
let stopping = false
/** 1 回の失敗ストリークで再起動を試したか。ready に到達するたびにリセットする。 */
let restartUsed = false
/** start() と attemptRestart() が共有する、進行中の起動 Promise。多重 spawn を防ぐ単一のゲート。 */
let startPromise = null

export function status() {
  return state
}

async function checkHealth(url) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS)
  try {
    const res = await fetch(url, { signal: controller.signal })
    return res.ok
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

/** @param {{ cancelled: boolean }} cancelToken error イベントが先に来たら即座に抜けるためのフラグ */
async function waitForReady(url, timeoutMs, cancelToken) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (cancelToken.cancelled) return false
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

  generation++
  const myGen = generation
  ownedProcess = child
  ownedGeneration = myGen

  const cancelToken = { cancelled: false }
  const errorPromise = new Promise((_resolve, reject) => {
    child.once('error', err => {
      // ENOENT（binary が無い）などはここに来る。
      const isEnoent = err?.code === 'ENOENT'
      const hint = isEnoent
        ? ` PATH に ${cfg.binary} が見つかりません。voice.json の whisper.binary に絶対パス` +
          `（例: /opt/homebrew/bin/whisper-server）を書いてください。`
        : ''
      log(`warn: 起動に失敗しました（${err?.code ?? err?.message ?? err}）。${hint}`)
      if (ownedGeneration === myGen) {
        ownedProcess = null
        ownedGeneration = -1
      }
      state = 'down'
      cancelToken.cancelled = true
      reject(err)
    })
  })

  child.once('exit', (code, signal) => {
    if (ownedGeneration !== myGen) return // 古い世代（タイムアウトで止めた等）の exit は無視
    ownedProcess = null
    ownedGeneration = -1
    if (stopping) return // shutdown による意図的な終了
    log(`終了しました（code=${code ?? '-'} signal=${signal ?? '-'}）`)
    attemptRestart(cfg)
  })

  const timeoutMs = (cfg.startTimeoutS ?? 60) * 1000
  let ready
  try {
    ready = await Promise.race([waitForReady(`${baseUrl}/health`, timeoutMs, cancelToken), errorPromise])
  } catch {
    return // error イベント側で state / ログは処理済み
  }

  if (ready) {
    state = 'ready'
    restartUsed = false // 復帰できたので、次にクラッシュしてもまた1回リトライできるようにする
    log('準備ができました')
    return
  }

  log(`warn: ${timeoutMs / 1000} 秒以内に起動しなかったので停止します`)
  state = 'down'
  if (ownedGeneration === myGen) {
    ownedProcess = null
    ownedGeneration = -1
    try {
      child.kill('SIGTERM')
    } catch (err) {
      log(`warn: タイムアウトしたプロセスの停止に失敗しました: ${err?.message ?? err}`)
    }
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
  // start() と同じ single-flight（startPromise）を通す。再起動中に join が来て start() が
  // 呼ばれても、この Promise をそのまま返すだけで別の whisper-server を spawn しないようにする。
  startPromise = spawnAndWait(cfg)
    .catch(err => log(`warn: 再起動処理で例外が発生しました: ${err?.message ?? err}`))
    .finally(() => {
      startPromise = null
    })
}

async function doStart(cfg) {
  baseUrl = `http://127.0.0.1:${cfg.port}`
  state = 'starting'
  const reachable = await checkHealth(`${baseUrl}/health`)
  if (reachable) {
    // 既に動いているものは自分のものではないので、shutdown 時に止めない。
    ownedProcess = null
    ownedGeneration = -1
    state = 'ready'
    log(`既に起動している whisper-server を利用します: ${baseUrl}`)
    return
  }
  restartUsed = false
  await spawnAndWait(cfg)
}

/**
 * whisper-server への疎通を確認し、必要なら起動する。voice プロセス起動時（listen 後）と、
 * 各 join のたびに（down のままなら再試行するために）呼ぶ。
 * 既に ready なら何もしない。starting 中（起動中の spawn、または再起動処理の最中）なら、
 * その進行中の Promise をそのまま返す（二重に spawn しないため）。
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
  let res
  try {
    res = await fetch(`http://127.0.0.1:${cfg.port}/inference`, {
      method: 'POST',
      body: form,
      signal: controller.signal,
    })
  } catch (err) {
    if (!controller.signal.aborted) {
      // タイムアウト（こちらの都合の abort）ではなく、接続そのものに失敗した
      // （ECONNREFUSED 等）= whisper-server が落ちている可能性が高い。既存の
      // whisper-server を使っているケース（ownedProcess が null）では child の exit を
      // 監視できないので、これが唯一の検知手段になる。次の join の start() で復帰する。
      log(`warn: whisper-server に接続できませんでした（${err?.cause?.code ?? err?.message ?? err}）。down にします`)
      state = 'down'
    }
    throw err
  } finally {
    clearTimeout(timer)
  }
  if (!res.ok) throw new Error(`whisper-server が ${res.status} を返しました`)
  const data = await res.json()
  return typeof data?.text === 'string' ? data.text.trim() : ''
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

/**
 * 待機中（未処理）のジョブを全部 reject して空にする。処理中の 1 件（既にキューから
 * 取り出されて await callInference() 中のもの）は対象外——leave 直後に届く応答は
 * index.js 側がセッションの世代番号で判定して捨てる。
 * @param {string} [reason] reject するエラーメッセージ
 */
export function clearQueue(reason) {
  const message = reason || '発話のキューがクリアされました'
  while (queue.length > 0) {
    const job = queue.shift()
    job.reject(new Error(message))
  }
}
