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
 * 環境変数
 *   DISCORD_BOT_STATE_DIR  状態ファイルの置き場（既定 ~/.claude/discord-bot）
 */
import net from 'node:net'
import { createWriteStream, existsSync, mkdirSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  joinVoiceChannel,
  entersState,
  VoiceConnectionStatus,
} from '@discordjs/voice'

const STATE_DIR = process.env.DISCORD_BOT_STATE_DIR ?? join(homedir(), '.claude', 'discord-bot')
const SOCKET_PATH = join(STATE_DIR, 'voice.sock')
const LOG_PATH = join(STATE_DIR, 'voice.log')

// Ready への到達を待つ上限。Gateway の中継を挟むぶん、直結より少し余裕を見てある。
const READY_TIMEOUT_MS = 20_000

mkdirSync(STATE_DIR, { recursive: true })

// ログはファイルに追記しつつ標準出力にも出す。前面で起動したときにそのまま読めるようにするため。
const logStream = createWriteStream(LOG_PATH, { flags: 'a' })

function log(...parts) {
  const line = `[${new Date().toISOString()}] ${parts.join(' ')}`
  logStream.write(`${line}\n`)
  console.log(line)
}

// ---------------------------------------------------------------------------
// ソケットのクライアント管理
// ---------------------------------------------------------------------------

const clients = new Set()

/**
 * 応答の送り先。複数繋がったら最後に繋いだものを使う。
 * /restart で channel サーバーが入れ替わったとき、新しいほうへ自然に切り替わるようにするため。
 */
let activeClient = null

/** 1 メッセージ = 1 行の JSON。送り先が居なければ false を返す。 */
function send(message) {
  const target = activeClient
  if (!target || target.destroyed) {
    log('warn: 送信先のクライアントが居ないので破棄しました:', JSON.stringify(message).slice(0, 200))
    return false
  }
  target.write(`${JSON.stringify(message)}\n`)
  return true
}

function sendError(requestId, message) {
  log('error:', message)
  send({ t: 'error', requestId, message })
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
    sendPayload: payload => send({ t: 'sendPayload', d: payload }),
    destroy: () => {
      if (adapterMethods === methods) adapterMethods = null
    },
  }
}

function handleGatewayEvent(event, d) {
  if (!adapterMethods) {
    // 退室した直後にも自分の VOICE_STATE_UPDATE が届く。異常ではないので無視してよい。
    log(`${event} を受け取りましたが、待っている接続がないので無視します`)
    return
  }
  if (event === 'VOICE_STATE_UPDATE') adapterMethods.onVoiceStateUpdate(d)
  else if (event === 'VOICE_SERVER_UPDATE') adapterMethods.onVoiceServerUpdate(d)
  else log(`warn: 未知の gateway イベントです: ${event}`)
}

// ---------------------------------------------------------------------------
// 入室状態
// ---------------------------------------------------------------------------

/** @type {import('@discordjs/voice').VoiceConnection | null} */
let connection = null

/**
 * 入室中の情報。`userIds` は文字起こしの対象にしてよいユーザー（#63 で使う）で、
 * この Issue の範囲では join で受け取って保持するだけ。
 * @type {{ guildId: string, channelId: string, userIds: string[] } | null}
 */
let joinedAs = null

function resetToIdle(reason) {
  if (!connection && !joinedAs) return
  const current = connection
  connection = null
  joinedAs = null
  if (current && current.state.status !== VoiceConnectionStatus.Destroyed) {
    try {
      current.destroy()
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
    log('接続が破棄されました')
  })
  conn.on('error', err => log('voice connection error:', err?.message ?? err))
}

// ---------------------------------------------------------------------------
// メッセージのハンドラ
// ---------------------------------------------------------------------------

async function handleJoin(msg) {
  const { requestId, guildId, channelId } = msg
  if (!guildId || !channelId) {
    sendError(requestId, 'join には guildId と channelId が必要です')
    return
  }
  if (!activeClient || activeClient.destroyed) {
    sendError(requestId, 'Gateway を中継するクライアントが接続していません')
    return
  }

  if (connection) {
    log('既に入室しているので、いったん退室してから入り直します')
    resetToIdle('rejoin')
  }

  const userIds = Array.isArray(msg.userIds) ? msg.userIds : []
  log(`入室します: guild=${guildId} channel=${channelId} 対象ユーザー=${userIds.length} 人`)

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
    sendError(requestId, `入室の開始に失敗しました: ${err?.message ?? err}`)
    return
  }

  connection = conn
  joinedAs = { guildId, channelId, userIds }
  watchConnection(conn)

  try {
    // Destroyed と競争させる。切断で破棄されたときに 20 秒待たずに失敗を返すため。
    await Promise.race([
      entersState(conn, VoiceConnectionStatus.Ready, READY_TIMEOUT_MS),
      new Promise((_resolve, reject) => {
        conn.once(VoiceConnectionStatus.Destroyed, () => reject(new Error('接続が破棄されました')))
      }),
    ])
  } catch (err) {
    resetToIdle('join 失敗')
    sendError(requestId, `ボイスチャンネルへの接続に失敗しました: ${err?.message ?? err}`)
    return
  }

  log(`入室しました: guild=${guildId} channel=${channelId}`)
  send({ t: 'joined', requestId, guildId, channelId })
}

function handleLeave(msg) {
  if (!connection) {
    log('退室の要求を受けましたが、既に idle です')
  } else {
    log('退室します')
    resetToIdle('leave')
  }
  send({ t: 'left', requestId: msg.requestId })
}

function handleStatus(msg) {
  send({
    t: 'status',
    requestId: msg.requestId,
    state: connection ? 'joined' : 'idle',
    channelId: joinedAs?.channelId ?? null,
    // whisper-server の起動管理は #64 の担当。ここでは固定値を返す。
    whisper: 'down',
  })
}

function handleMessage(raw) {
  let msg
  try {
    msg = JSON.parse(raw)
  } catch {
    log('warn: JSON として読めない行を無視しました:', raw.slice(0, 200))
    return
  }
  switch (msg.t) {
    case 'join':
      handleJoin(msg).catch(err => sendError(msg.requestId, `join の処理で例外: ${err?.message ?? err}`))
      break
    case 'leave':
      handleLeave(msg)
      break
    case 'status':
      handleStatus(msg)
      break
    case 'gateway':
      handleGatewayEvent(msg.event, msg.d)
      break
    default:
      log('warn: 未知のメッセージ種別です:', String(msg.t))
  }
}

// ---------------------------------------------------------------------------
// サーバー
// ---------------------------------------------------------------------------

function onConnection(socket) {
  clients.add(socket)
  activeClient = socket
  log(`クライアントが接続しました（現在 ${clients.size} 本）`)

  // TCP と同じでソケットはバイト列なので、改行までを 1 メッセージとして自分で区切る。
  let buffer = ''
  socket.setEncoding('utf8')
  socket.on('data', chunk => {
    buffer += chunk
    let index
    while ((index = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, index).trim()
      buffer = buffer.slice(index + 1)
      if (line) handleMessage(line)
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
    if (clients.size === 0 && connection) resetToIdle('クライアントが全て切断')
  }
  socket.on('close', drop)
  socket.on('error', err => {
    log('warn: クライアントのソケットでエラー:', err?.message ?? err)
    drop()
  })
}

/**
 * 前回の異常終了でソケットファイルが残っていることがある。
 * 繋いでみて応答が無ければ死んでいるので消す。応答があれば二重起動なので止める。
 */
async function clearStaleSocket() {
  if (!existsSync(SOCKET_PATH)) return
  await new Promise(resolve => {
    const probe = net.connect(SOCKET_PATH)
    probe.on('connect', () => {
      probe.destroy()
      log(`既に voice プロセスが動いています（${SOCKET_PATH}）。起動を中止します`)
      process.exit(1)
    })
    probe.on('error', () => {
      try {
        unlinkSync(SOCKET_PATH)
        log('残っていたソケットファイルを消しました')
      } catch (err) {
        log('warn: ソケットファイルを消せませんでした:', err?.message ?? err)
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

function shutdown(signal) {
  if (shuttingDown) return
  shuttingDown = true
  log(`${signal} を受け取りました。終了します`)
  resetToIdle('shutdown')
  server.close()
  try {
    if (existsSync(SOCKET_PATH)) unlinkSync(SOCKET_PATH)
  } catch {
    // 消せなくても次回の起動時に掃除されるので無視してよい
  }
  // ログの書き出しを待ってから抜ける
  logStream.end(() => process.exit(0))
}

process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))

await clearStaleSocket()

server.listen(SOCKET_PATH, () => {
  log(`voice プロセスを起動しました: ${SOCKET_PATH}`)
})
