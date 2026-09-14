#!/usr/bin/env node
/**
 * voice プロセス: Discord のボイスチャンネルへの入退室を担当する常駐プロセス。
 *
 * `@discordjs/voice` は Bun で動かないので、Bun で動く channel サーバーとは別の Node プロセスに分けている。
 * このプロセスは Gateway 接続を持たない（= トークンも持たない）。Gateway は channel サーバーが張っている
 * 1 本だけを使い、その入口と出口を Unix ドメインソケット越しに借りる形にしてある。
 *
 *   channel サーバー ──(Gateway)── Discord
 *          │
 *     voice.sock（改行区切り JSON）
 *          │
 *   voice プロセス ──(音声の UDP/WebSocket)── Discord
 *
 * プロトコルの定義は Issue #61 のコメントにある。
 *
 * ログは標準出力にだけ出す。channel サーバーが spawn するときに stdout/stderr を
 * `~/.claude/discord-bot/voice.log` へリダイレクトするので、ここで同じファイルに書くと二重になる。
 * 手で起動するときは自分でリダイレクトする（docs/development.md 参照）。
 *
 * 環境変数
 *   DISCORD_BOT_STATE_DIR  状態ファイルの置き場（既定 ~/.claude/discord-bot）
 */
import net from 'node:net'
import { lstatSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import {
  joinVoiceChannel,
  entersState,
  VoiceConnectionStatus,
} from '@discordjs/voice'
import { VoiceReceiver } from './receiver.js'
import { loadVoiceConfig } from './config.js'
import * as whisper from './transcriber.js'

const STATE_DIR = process.env.DISCORD_BOT_STATE_DIR ?? join(homedir(), '.claude', 'discord-bot')
const SOCKET_PATH = join(STATE_DIR, 'voice.sock')

// Ready への到達を待つ上限。Gateway の中継を挟むぶん、直結より少し余裕を見てある。
const READY_TIMEOUT_MS = 20_000

// 1 行の上限。まともなメッセージはせいぜい数百バイトなので、これを超えるのは壊れた送信側とみなす。
const MAX_LINE_BYTES = 64 * 1024

// 終了時の後始末に使う上限。これを超えたら諦めて抜ける。
const SHUTDOWN_TIMEOUT_MS = 3_000

// 置き換えた古いクライアントに superseded を書き終えるのを待つ上限。
const SUPERSEDE_TIMEOUT_MS = 1_000

mkdirSync(STATE_DIR, { recursive: true })

function log(...parts) {
  console.log(`[${new Date().toISOString()}] ${parts.join(' ')}`)
}

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isId(value) {
  return typeof value === 'string' && value.length > 0
}

// ---------------------------------------------------------------------------
// ソケットのクライアント管理
// ---------------------------------------------------------------------------

const clients = new Set()

/**
 * 最新のクライアント。要求と gateway イベントはこのソケットから来たものだけを受け付ける。
 * /restart で channel サーバーが入れ替わるとき、新旧が一瞬重なっても混線しないようにするため。
 */
let activeClient = null

// 終了時に「退室の op 4 を書き終えてから抜ける」ために、書き込み中の本数を数えておく。
let pendingWrites = 0
const writeWaiters = []

function flushWrites() {
  if (pendingWrites === 0) return Promise.resolve()
  return new Promise(resolve => writeWaiters.push(resolve))
}

/**
 * 1 メッセージ = 1 行の JSON。送り先が使えなければ false を返す。
 * `onWritten` を渡すと、その 1 行を書き終えた時点で呼ばれる。
 */
function sendTo(socket, message, onWritten) {
  if (!socket || socket.destroyed || !socket.writable) {
    log('warn: 送信先のクライアントが使えないので破棄しました:', JSON.stringify(message).slice(0, 200))
    return false
  }
  pendingWrites++
  socket.write(`${JSON.stringify(message)}\n`, () => {
    pendingWrites--
    if (pendingWrites === 0) for (const resolve of writeWaiters.splice(0)) resolve()
    onWritten?.()
  })
  return true
}

/**
 * 置き換えられた古いクライアントに `superseded` を知らせてから閉じる。
 * 黙って閉じると channel 側が切断とみなして繋ぎ直すので、channel サーバーが 2 本立ったときに
 * 互いを追い出し合い続けてしまう。これを受けた側は自動再接続をやめる約束にしてある。
 */
function supersede(socket) {
  let closed = false
  const close = () => {
    if (closed) return
    closed = true
    clearTimeout(timer)
    socket.end()
  }
  // 書き終えたら閉じるが、相手が読まずに詰まったまま居座らないよう上限を設ける。
  const timer = setTimeout(close, SUPERSEDE_TIMEOUT_MS)
  if (!sendTo(socket, { t: 'superseded' }, close)) close()
}

/** 要求に紐づかない送信（sendPayload、#63 以降の transcript）は最新のクライアント宛て。 */
function sendToActive(message) {
  return sendTo(activeClient, message)
}

function sendError(origin, requestId, message) {
  log('error:', message)
  sendTo(origin, { t: 'error', requestId, message })
}

// ---------------------------------------------------------------------------
// Gateway アダプタ（DiscordGatewayAdapterCreator の自前実装）
// ---------------------------------------------------------------------------

/**
 * `@discordjs/voice` は本来 discord.js の Client から Gateway を借りる。
 * ここでは Client の代わりにソケットの向こう側（channel サーバー）に op 4 の送信を代行してもらい、
 * 逆に Gateway から届いた 2 つのイベントを受け取って `@discordjs/voice` へ渡す。
 */
let adapterMethods = null

function adapterCreator(methods) {
  adapterMethods = methods
  return {
    // op 4（Voice State Update）の送信。自分では Gateway を持たないので中継してもらう。
    // 送り先が居ないときに false を返すと、`@discordjs/voice` 側が接続を Disconnected
    // （reason: AdapterUnavailable）にしてくれるので、20 秒待たずに失敗が分かる。
    sendPayload: payload => sendToActive({ t: 'sendPayload', d: payload }),
    destroy: () => {
      if (adapterMethods === methods) adapterMethods = null
    },
  }
}

function handleGatewayEvent(msg) {
  const { event, d } = msg
  if (!isObject(d)) {
    log('warn: gateway イベントの d が不正なので無視しました')
    return
  }
  if (event !== 'VOICE_STATE_UPDATE' && event !== 'VOICE_SERVER_UPDATE') {
    log('warn: 未知の gateway イベントです:', String(event))
    return
  }
  if (!adapterMethods) {
    // 退室した直後にも自分の VOICE_STATE_UPDATE が届く。異常ではないので無視してよい。
    log(`${event} を受け取りましたが、待っている接続がないので無視します`)
    return
  }
  // 入室中のギルド以外のイベントを渡すと、別のギルドの情報で接続を壊してしまう。
  if (!joinedAs || d.guild_id !== joinedAs.guildId) {
    log(`${event} を受け取りましたが、入室中のギルドのものではないので無視します`)
    return
  }
  if (event === 'VOICE_STATE_UPDATE') adapterMethods.onVoiceStateUpdate(d)
  else adapterMethods.onVoiceServerUpdate(d)
}

// ---------------------------------------------------------------------------
// 入室状態
// ---------------------------------------------------------------------------

/** @type {import('@discordjs/voice').VoiceConnection | null} */
let connection = null

/**
 * 発話区間の検出（Issue #63）。join 成功時に作り、leave / idle で破棄する。
 * @type {VoiceReceiver | null}
 */
let receiver = null

/**
 * 入退室のたびに 1 つ進む世代番号。utterance を受け取った時点のこの値を捕まえておき、
 * 文字起こしが完了した時点で変わっていたら（その間に leave → 別 VC への join があったら）
 * 送信をやめる。捕まえておかないと、旧チャンネル分の発話が新チャンネル宛てに送られてしまう。
 */
let sessionGeneration = 0

/** utterance イベントごとの処理。debug 保存のあと whisper-server に投げて transcript を送る（#64）。 */
async function handleUtterance(utt) {
  const seconds = (utt.durationMs / 1000).toFixed(1)
  log(`発話を検出しました: user=${utt.userId} ${seconds}秒`)
  const { debug } = loadVoiceConfig()
  if (debug.saveWav) {
    try {
      const dir = join(STATE_DIR, 'recordings')
      mkdirSync(dir, { recursive: true })
      const stamp = utt.startedAt.toISOString().replace(/[:.]/g, '-')
      const file = join(dir, `${stamp}_${utt.userId}.wav`)
      writeFileSync(file, utt.wav)
      log(`WAV を保存しました: ${file}`)
    } catch (err) {
      log('warn: WAV の保存に失敗しました:', err?.message ?? err)
    }
  }

  if (whisper.status() !== 'ready') {
    log(`文字起こしをスキップしました（whisper-server が ${whisper.status()} です）`)
    return
  }

  // 発話を受け取った時点のセッション情報を捕まえておく（下のコメント参照）。
  const generationAtUtterance = sessionGeneration
  const guildIdAtUtterance = joinedAs?.guildId
  const channelIdAtUtterance = joinedAs?.channelId

  let text
  try {
    text = await whisper.transcribe(utt.wav)
  } catch (err) {
    log('warn: 文字起こしに失敗しました:', err?.message ?? err)
    return
  }
  if (!text) return
  if (generationAtUtterance !== sessionGeneration || !guildIdAtUtterance || !channelIdAtUtterance) {
    log('warn: 文字起こしが得られましたが、その間に退室/再入室していたので送信をやめました')
    return
  }
  sendToActive({
    t: 'transcript',
    guildId: guildIdAtUtterance,
    channelId: channelIdAtUtterance,
    userId: utt.userId,
    text,
    startedAt: utt.startedAt.toISOString(),
    endedAt: utt.endedAt.toISOString(),
  })
}

/** 入室中の receiver を止める。resetToIdle と、接続が破棄されたときの両方から呼ぶ。 */
function stopReceiver(reason) {
  if (!receiver) return
  const current = receiver
  receiver = null
  current.destroy().catch(err => log(`warn: receiver の破棄に失敗しました（${reason}）:`, err?.message ?? err))
}

/**
 * 処理待ち・処理中の join の本数。status は入退室の列に並ばないので、
 * 「列に入れた時点」で数えておかないと Ready 待ちの間に idle と答えてしまう。
 */
let pendingJoins = 0

/** @returns {'idle' | 'joining' | 'joined'} */
function currentState() {
  if (pendingJoins > 0) return 'joining'
  return connection ? 'joined' : 'idle'
}

/**
 * 入室中の情報。`userIds` は文字起こしの対象にしてよいユーザー（#63 で使う）で、
 * この Issue の範囲では join で受け取って保持するだけ。
 * @type {{ guildId: string, channelId: string, userIds: string[] } | null}
 */
let joinedAs = null

/**
 * 入室状態を畳む。
 * @param {string} reason ログに残す理由
 * @param {boolean} adapterAvailable false にすると退室の op 4 を送らずに畳む。
 *   送り先のクライアントが居ないと分かっているときに使う（書けずに warn が出るのを避けるため）。
 */
function resetToIdle(reason, adapterAvailable = true) {
  if (!connection) return
  const current = connection
  connection = null
  joinedAs = null
  sessionGeneration++
  whisper.clearQueue(`退室（${reason}）により待機中の発話を破棄しました`)
  stopReceiver(reason)
  if (current && current.state.status !== VoiceConnectionStatus.Destroyed) {
    try {
      current.destroy(adapterAvailable)
    } catch (err) {
      // destroy が二重に走ると例外になる。状態を idle に戻すのが目的なので握りつぶしてよい。
      log('warn: 接続の破棄に失敗しました:', err?.message ?? err)
    }
  }
  log(`状態を idle に戻しました（${reason}）`)
}

function watchConnection(conn) {
  // Gateway 側の都合で通話から外された場合。Discord は Gateway セッションが切れると Bot を通話から外す。
  // 自動再入室はしない（Issue #62 の範囲外）。手で /voice join を打ち直す運用。
  conn.on(VoiceConnectionStatus.Disconnected, (_old, next) => {
    if (connection !== conn) return
    log(`通話から切断されました（reason: ${next?.reason}）。自動再入室はしません`)
    resetToIdle('disconnected')
  })
  conn.on(VoiceConnectionStatus.Destroyed, () => {
    if (connection !== conn) return
    connection = null
    joinedAs = null
    sessionGeneration++
    whisper.clearQueue('退室（destroyed）により待機中の発話を破棄しました')
    stopReceiver('destroyed')
    log('接続が破棄されました')
  })
  conn.on('error', err => log('voice connection error:', err?.message ?? err))
}

// ---------------------------------------------------------------------------
// 入退室の直列化
// ---------------------------------------------------------------------------

/**
 * join と leave は 1 本ずつ順番に処理する。
 * Ready を待っている最中に 2 回目の join が来ると、新旧の接続がお互いを破棄し合って
 * どちらも消えてしまうため。status は今の状態をすぐ返したいので、この列には並ばせない。
 * 待っている join がある間の leave は、その join が終わってから実行される。
 */
let workQueue = Promise.resolve()

function enqueue(task) {
  const next = workQueue.then(task)
  // 失敗しても後続を止めない
  workQueue = next.then(
    () => undefined,
    err => log('warn: 処理中に例外が発生しました:', err?.message ?? err),
  )
  return next
}

// ---------------------------------------------------------------------------
// メッセージのハンドラ
// ---------------------------------------------------------------------------

async function handleJoin(msg, origin) {
  const { requestId, guildId, channelId } = msg
  if (!isId(guildId) || !isId(channelId)) {
    sendError(origin, requestId, 'join には文字列の guildId と channelId が必要です')
    return
  }
  if (!activeClient || activeClient.destroyed) {
    sendError(origin, requestId, 'Gateway を中継するクライアントが接続していません')
    return
  }

  if (connection) {
    log('既に入室しているので、いったん退室してから入り直します')
    resetToIdle('rejoin')
  }

  const userIds = Array.isArray(msg.userIds) ? msg.userIds.filter(isId) : []
  log(`入室します: guild=${guildId} channel=${channelId} 対象ユーザー=${userIds.length} 人`)

  // whisper-server が down のままなら、この join を機に起動を試みる（ready/starting なら何もしない）。
  // 通話への入退室自体は whisper の状態に関わらず進める。
  void whisper.start()

  let conn
  try {
    conn = joinVoiceChannel({
      channelId,
      guildId,
      // 受信するので deaf は必ず解く。こちらからは喋らないので mute のままにしておく。
      selfDeaf: false,
      selfMute: true,
      adapterCreator,
    })
  } catch (err) {
    sendError(origin, requestId, `入室の開始に失敗しました: ${err?.message ?? err}`)
    return
  }

  connection = conn
  joinedAs = { guildId, channelId, userIds }
  watchConnection(conn)

  // Ready 待ちは「Ready になる」「破棄される」「時間切れ」の 3 つで終わる。
  // どれで終わってもタイマーとリスナを残さないように、AbortController と finally で片付ける。
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, READY_TIMEOUT_MS)
  let onDestroyed = null

  try {
    await Promise.race([
      entersState(conn, VoiceConnectionStatus.Ready, controller.signal),
      new Promise((_resolve, reject) => {
        onDestroyed = () => reject(new Error('接続が破棄されました'))
        conn.once(VoiceConnectionStatus.Destroyed, onDestroyed)
      }),
    ])
  } catch (err) {
    // 自分が作った接続がまだ現役のときだけ畳む。別の join に置き換わっていたら触らない。
    if (connection === conn) resetToIdle('join 失敗')
    const detail = timedOut ? `${READY_TIMEOUT_MS / 1000} 秒以内に Ready になりませんでした` : (err?.message ?? String(err))
    sendError(origin, requestId, `ボイスチャンネルへの接続に失敗しました: ${detail}`)
    return
  } finally {
    clearTimeout(timer)
    controller.abort()
    if (onDestroyed) conn.off(VoiceConnectionStatus.Destroyed, onDestroyed)
  }

  if (connection !== conn) {
    sendError(origin, requestId, '入室中に別の要求で接続が置き換わりました')
    return
  }

  log(`入室しました: guild=${guildId} channel=${channelId}`)

  // 発話区間の検出を開始する（Issue #63）。対象は userIds に含まれる話者だけ。
  const { vad } = loadVoiceConfig()
  receiver = new VoiceReceiver(conn, joinedAs, vad)
  // handleUtterance は async 関数なので、素の関数参照のままだと reject が拾えず
  // 未処理 rejection で落ちかねない（Node は未処理 rejection でプロセスを終了させる）。
  receiver.on('utterance', utt => handleUtterance(utt).catch(err => log('warn: handleUtterance で例外が発生しました:', err?.message ?? err)))
  receiver.on('warning', message => log('warn: voice receiver:', message))
  receiver.on('error', err => log('warn: voice receiver でエラーが発生しました:', err?.message ?? err))

  sendTo(origin, { t: 'joined', requestId, guildId, channelId })
}

function handleLeave(msg, origin) {
  if (!connection) {
    log('退室の要求を受けましたが、既に idle です')
  } else {
    log('退室します')
    resetToIdle('leave')
  }
  sendTo(origin, { t: 'left', requestId: msg.requestId })
}

function handleStatus(msg, origin) {
  sendTo(origin, {
    t: 'status',
    requestId: msg.requestId,
    state: currentState(),
    channelId: joinedAs?.channelId ?? null,
    whisper: whisper.status(),
  })
}

function handleMessage(raw, origin) {
  try {
    let msg
    try {
      msg = JSON.parse(raw)
    } catch {
      log('warn: JSON として読めない行を無視しました:', raw.slice(0, 200))
      return
    }
    // JSON.parse は null や数値、配列も返す。オブジェクトでなければ相手にしない。
    if (!isObject(msg) || typeof msg.t !== 'string') {
      log('warn: 形式が違う行を無視しました:', raw.slice(0, 200))
      return
    }
    // 最新でないクライアント（置き換え中の古い channel など）からの指示は受け付けない。
    if (origin !== activeClient) {
      log('warn: 最新でないクライアントからのメッセージを無視しました:', msg.t)
      return
    }
    if (msg.requestId !== undefined && typeof msg.requestId !== 'string') {
      log('warn: requestId が文字列でないので無視しました:', msg.t)
      return
    }

    switch (msg.t) {
      case 'join':
        // 列に入れた時点で数える。status は列に並ばないので、ここで数えておかないと
        // Ready を待っている間に idle と答えてしまう。
        pendingJoins++
        enqueue(() => handleJoin(msg, origin))
          .catch(err => sendError(origin, msg.requestId, `join の処理で例外: ${err?.message ?? err}`))
          .finally(() => {
            pendingJoins--
          })
        break
      case 'leave':
        enqueue(() => handleLeave(msg, origin)).catch(err =>
          sendError(origin, msg.requestId, `leave の処理で例外: ${err?.message ?? err}`),
        )
        break
      case 'status':
        handleStatus(msg, origin)
        break
      case 'gateway':
        handleGatewayEvent(msg)
        break
      default:
        log('warn: 未知のメッセージ種別です:', msg.t)
    }
  } catch (err) {
    // 壊れた入力でプロセスごと落ちないようにする。voice が死ぬと通話も切れるため。
    log('warn: メッセージの処理で例外が発生しました:', err?.stack ?? err)
  }
}

// ---------------------------------------------------------------------------
// サーバー
// ---------------------------------------------------------------------------

function onConnection(socket) {
  const previous = [...clients]
  clients.add(socket)
  activeClient = socket
  log(`クライアントが接続しました（現在 ${clients.size} 本）`)

  // 新しい channel が繋いできたら古いほうは明示的に閉じる。/restart で新旧が重なる期間に
  // 両方から指示が飛んでくると、どちらの Gateway を借りているのか分からなくなるため。
  for (const old of previous) {
    log('新しい接続に置き換えるので、古いクライアントに superseded を送って閉じます')
    supersede(old)
  }

  // TCP と同じでソケットはバイト列なので、改行までを 1 メッセージとして自分で区切る。
  let buffer = ''
  socket.setEncoding('utf8')

  const disconnectTooLong = why => {
    log(`warn: ${why}（上限 ${MAX_LINE_BYTES} バイト）。このクライアントを切断します`)
    buffer = ''
    socket.destroy()
  }

  socket.on('data', chunk => {
    buffer += chunk
    let index
    while ((index = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, index).trim()
      buffer = buffer.slice(index + 1)
      if (!line) continue
      if (Buffer.byteLength(line) > MAX_LINE_BYTES) {
        disconnectTooLong('1 行が長すぎます')
        return
      }
      handleMessage(line, socket)
    }
    if (Buffer.byteLength(buffer) > MAX_LINE_BYTES) {
      disconnectTooLong('改行が来ないまま長くなりました')
    }
  })

  const drop = () => {
    if (!clients.delete(socket)) return
    if (activeClient === socket) {
      // 残っているクライアントがあればそれを使う。無ければ送り先なしに戻す。
      activeClient = clients.size > 0 ? [...clients][clients.size - 1] : null
    }
    // channel サーバーが /restart で落ちてもこのプロセスは生かしたままにする。
    // ただし Gateway が切れると Discord 側が Bot を通話から外すので、状態は idle に戻す。
    log(`クライアントが切断しました（残り ${clients.size} 本）`)
    // 退室の op 4 を送る先が無いので、adapterAvailable = false で畳む。
    if (clients.size === 0 && connection) resetToIdle('クライアントが全て切断', false)
  }
  socket.on('close', drop)
  socket.on('error', err => {
    log('warn: クライアントのソケットでエラー:', err?.message ?? err)
    drop()
  })
}

/**
 * 前回の異常終了でソケットファイルが残っていることがある。
 * 繋いでみて ECONNREFUSED なら死んでいるので消す。応答があれば二重起動なので止める。
 * それ以外のエラー（権限など）では消さない。消してよいと判断できないものを消すと危ないため。
 */
async function clearStaleSocket() {
  let stat
  try {
    stat = lstatSync(SOCKET_PATH)
  } catch (err) {
    if (err?.code === 'ENOENT') return
    log(`${SOCKET_PATH} を調べられませんでした（${err?.code ?? err}）。起動を中止します`)
    process.exit(1)
  }
  if (!stat.isSocket()) {
    log(`${SOCKET_PATH} はソケットではありません。中身を確認してから消してください`)
    process.exit(1)
  }
  await new Promise(resolve => {
    const probe = net.connect(SOCKET_PATH)
    probe.once('connect', () => {
      probe.destroy()
      log(`既に voice プロセスが動いています（${SOCKET_PATH}）。起動を中止します`)
      process.exit(1)
    })
    probe.once('error', err => {
      if (err?.code !== 'ECONNREFUSED') {
        log(`ソケットに繋げませんでした（${err?.code ?? err}）。消さずに起動を中止します`)
        process.exit(1)
      }
      try {
        unlinkSync(SOCKET_PATH)
        log('残っていたソケットファイルを消しました')
      } catch (unlinkErr) {
        log(`ソケットファイルを消せませんでした（${unlinkErr?.code ?? unlinkErr}）。起動を中止します`)
        process.exit(1)
      }
      resolve()
    })
  })
}

const server = net.createServer(onConnection)

server.on('error', err => {
  log('サーバーでエラーが発生しました:', err?.message ?? err)
  process.exit(1)
})

let shuttingDown = false

/** 退室の op 4 を書き終える → 接続を閉じる、までを順番に待つ。 */
async function finishShutdown() {
  resetToIdle('shutdown')
  whisper.stop()
  await flushWrites()
  for (const socket of clients) socket.end()
  await new Promise(resolve => server.close(() => resolve()))
}

async function shutdown(signal) {
  if (shuttingDown) return
  shuttingDown = true
  log(`${signal} を受け取りました。終了します`)

  const done = finishShutdown().catch(err => log('warn: 後始末で例外:', err?.message ?? err))
  const timeout = sleep(SHUTDOWN_TIMEOUT_MS, 'timeout')
  if ((await Promise.race([done.then(() => 'done'), timeout])) === 'timeout') {
    log(`warn: 後始末が ${SHUTDOWN_TIMEOUT_MS / 1000} 秒で終わらなかったので打ち切ります`)
  }

  try {
    if (lstatSync(SOCKET_PATH).isSocket()) unlinkSync(SOCKET_PATH)
  } catch {
    // 残っても次回の起動時に掃除されるので無視してよい
  }
  process.exit(0)
}

process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))

await clearStaleSocket()

server.listen(SOCKET_PATH, () => {
  log(`voice プロセスを起動しました: ${SOCKET_PATH}`)
  // whisper-server への疎通確認・起動はソケットの受け付けをブロックしない。
  void whisper.start()
})
