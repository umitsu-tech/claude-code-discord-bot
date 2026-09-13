#!/usr/bin/env node
/**
 * 開発用: channel サーバー（Issue #65）の代わりに Gateway の中継だけを行うスクリプト。
 *
 * voice プロセス（../index.js）を単体で検証するためのもの。discord.js で Gateway を 1 本張り、
 * voice.sock 越しに次の 3 つを橋渡しする。
 *
 *   voice → Gateway   sendPayload（op 4）を該当ギルドの shard へ流す
 *   Gateway → voice   VOICE_STATE_UPDATE（Bot 自身のものだけ）と VOICE_SERVER_UPDATE を流す
 *
 * そのうえで join → Ready 確認 → 一定時間待つ → leave、までを自動で行って終了する。
 * 本番の経路ではないので、devDependencies の discord.js にしか依存していない。
 *
 * 使い方
 *   node dev/fake-gateway.js <ギルドID> <ボイスチャンネルID> [滞在秒数]
 *   DISCORD_GUILD_ID=... DISCORD_VOICE_CHANNEL_ID=... node dev/fake-gateway.js
 *
 * トークンは channel サーバーと同じ ~/.claude/channels/discord/.env の DISCORD_BOT_TOKEN を読む。
 */
import net from 'node:net'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { Client, GatewayIntentBits, GatewayDispatchEvents } from 'discord.js'

const STATE_DIR = process.env.DISCORD_BOT_STATE_DIR ?? join(homedir(), '.claude', 'discord-bot')
const SOCKET_PATH = join(STATE_DIR, 'voice.sock')

const guildId = process.argv[2] ?? process.env.DISCORD_GUILD_ID
const channelId = process.argv[3] ?? process.env.DISCORD_VOICE_CHANNEL_ID
const holdSeconds = Number(process.argv[4] ?? process.env.VOICE_HOLD_SECONDS ?? 10)

if (!guildId || !channelId) {
  console.error('使い方: node dev/fake-gateway.js <ギルドID> <ボイスチャンネルID> [滞在秒数]')
  console.error('（DISCORD_GUILD_ID / DISCORD_VOICE_CHANNEL_ID の環境変数でも渡せます）')
  process.exit(1)
}

/** トークンは直書きせず channel サーバーと同じファイルから読む。 */
function loadToken() {
  const envFile = join(homedir(), '.claude', 'channels', 'discord', '.env')
  const text = readFileSync(envFile, 'utf8')
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*DISCORD_BOT_TOKEN\s*=\s*(.*)$/)
    if (m) return m[1].trim().replace(/^["']|["']$/g, '')
  }
  throw new Error(`DISCORD_BOT_TOKEN が ${envFile} に見つかりません`)
}

function log(...parts) {
  console.log(`[fake-gateway ${new Date().toISOString()}]`, ...parts)
}

// テキスト系のインテントは持たせない。常駐セッションと同じトークンで Gateway が一時的に 2 本になるが、
// メッセージを受け取らないので二重返信は起きない（実験1で確認済み）。
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
})

let socket = null
/** requestId ごとの待ち合わせ。voice からの応答を Promise で受け取る。 */
const pending = new Map()
let requestSeq = 0

function sendToVoice(message) {
  socket.write(`${JSON.stringify(message)}\n`)
}

/** 要求を投げて、同じ requestId の応答が返るまで待つ。 */
function request(message, timeoutMs = 30_000) {
  const requestId = `fake-${++requestSeq}`
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(requestId)
      reject(new Error(`${message.t} の応答が ${timeoutMs}ms 以内に返りませんでした`))
    }, timeoutMs)
    pending.set(requestId, { resolve, reject, timer })
    sendToVoice({ ...message, requestId })
  })
}

function handleFromVoice(msg) {
  if (msg.t === 'sendPayload') {
    // voice プロセスが組み立てた op 4 をそのまま Gateway へ流す。これが中継の片道。
    const guild = client.guilds.cache.get(msg.d?.d?.guild_id ?? guildId)
    if (!guild) {
      log('warn: ギルドがキャッシュに無いので sendPayload を流せません')
      return
    }
    log('sendPayload を shard へ流します:', JSON.stringify(msg.d))
    guild.shard.send(msg.d)
    return
  }
  if (msg.requestId && pending.has(msg.requestId)) {
    const waiter = pending.get(msg.requestId)
    pending.delete(msg.requestId)
    clearTimeout(waiter.timer)
    if (msg.t === 'error') waiter.reject(new Error(msg.message))
    else waiter.resolve(msg)
    return
  }
  log('応答に紐づかないメッセージ:', JSON.stringify(msg))
}

function connectSocket() {
  return new Promise((resolve, reject) => {
    const s = net.connect(SOCKET_PATH)
    s.setEncoding('utf8')
    s.once('connect', () => {
      log(`voice プロセスに接続しました: ${SOCKET_PATH}`)
      resolve(s)
    })
    s.once('error', reject)
    let buffer = ''
    s.on('data', chunk => {
      buffer += chunk
      let index
      while ((index = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, index).trim()
        buffer = buffer.slice(index + 1)
        if (!line) continue
        try {
          handleFromVoice(JSON.parse(line))
        } catch (err) {
          log('warn: 受信した行を処理できませんでした:', line.slice(0, 200), err?.message ?? err)
        }
      }
    })
    socket = s
  })
}

/**
 * 生の dispatch の取り方。
 * discord.js 14.27 の WebSocketManager は dispatch を受けるたびに
 * `client.emit('raw', data, shardId)` と `this.emit(data.t, data.d, shardId)` の両方を出しているので
 * （src/client/websocket/WebSocketManager.js の attachEvents）、`client.on('raw', ...)` と
 * `client.ws.on(GatewayDispatchEvents.X, ...)` のどちらでも取れる。実機で両方に届くことを確認したうえで、
 * イベント名で直接受けられる後者を使っている（raw だと全 dispatch が流れてきて自分で t を見分けることになる）。
 * DEBUG_RAW=1 を付けると raw 側にも同じ dispatch が来ていることを目で確認できる。
 */
function relayGatewayEvents() {
  if (process.env.DEBUG_RAW) {
    client.on('raw', packet => {
      if (packet.t === 'VOICE_STATE_UPDATE' || packet.t === 'VOICE_SERVER_UPDATE') {
        log(`raw でも ${packet.t} を受信しました`)
      }
    })
  }
  client.ws.on(GatewayDispatchEvents.VoiceStateUpdate, d => {
    // Bot 自身の状態だけを送る。他人の入退室は voice プロセスには不要（#63 で別途扱う）。
    if (d.user_id !== client.user.id) return
    log('VOICE_STATE_UPDATE を voice へ中継します')
    sendToVoice({ t: 'gateway', event: 'VOICE_STATE_UPDATE', d })
  })
  client.ws.on(GatewayDispatchEvents.VoiceServerUpdate, d => {
    log('VOICE_SERVER_UPDATE を voice へ中継します')
    sendToVoice({ t: 'gateway', event: 'VOICE_SERVER_UPDATE', d })
  })
}

async function main() {
  await client.login(loadToken())
  await new Promise(resolve => client.once('clientReady', resolve))
  log(`ログインしました: ${client.user.tag}`)

  await connectSocket()
  relayGatewayEvents()

  log(`join を送ります: guild=${guildId} channel=${channelId}`)
  const joined = await request({ t: 'join', guildId, channelId, userIds: [] })
  log('joined:', JSON.stringify(joined))

  const status = await request({ t: 'status' })
  log('status:', JSON.stringify(status))

  log(`${holdSeconds} 秒待ってから退室します`)
  await sleep(holdSeconds * 1000)

  const left = await request({ t: 'leave' })
  log('left:', JSON.stringify(left))

  // 退室の op 4（channel_id: null）を voice が送ってくるので、shard へ流し終えるまで少し待つ。
  await sleep(1000)
}

let exitCode = 0
try {
  await main()
  log('一連の確認が終わりました')
} catch (err) {
  exitCode = 1
  console.error('[fake-gateway] 失敗しました:', err?.message ?? err)
} finally {
  socket?.destroy()
  await client.destroy()
  process.exit(exitCode)
}
