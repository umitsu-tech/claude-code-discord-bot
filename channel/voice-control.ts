/**
 * voice-control.ts — channel サーバー（Bun）と voice プロセス（Node、#62）を Unix ドメインソケットで
 * つなぐ中継。Gateway のボイス関連イベントを voice へ転送し、voice からの応答・文字起こしを取り次ぐ。
 *
 * プロトコル（改行区切り JSON、詳細は #61 の最後のコメント）
 *   channel -> voice: { t: 'join' | 'leave' | 'status', requestId, ... } / { t: 'gateway', event, d }
 *   voice -> channel: { t: 'sendPayload', d } / { t: 'joined' | 'left' | 'status' | 'error', requestId, ... } / { t: 'transcript', ... }
 * voice 側がソケットを listen し、channel 側が繋ぎに行く。requestId は channel 側が採番し、
 * join/leave/status の応答はそれで突き合わせる。transcript と sendPayload は要求に紐づかない。
 *
 * 接続まわりの方針
 *   - voice プロセスの起動（node <plugin root>/voice/index.js を detached + unref）は join() が
 *     呼ばれたときだけ行う。channel サーバー起動時には何もしない
 *   - ソケットが無い/繋がらない場合、join() 済み（voiceRequested）であれば再接続のたびに起動を試みる
 *     （SPAWN_COOLDOWN_MS 未満の間隔では二重起動しない）
 *   - 接続が切れたら 1s → 2s → ... → 最大 30s の指数バックオフで再接続を続ける
 *
 * Gateway 中継について
 *   discord.js 14.27 の WebSocketManager#attachEvents（node_modules/discord.js/src/client/websocket/
 *   WebSocketManager.js:232-234）は、ws から Dispatch パケットが来るたびに
 *     client.emit(Events.Raw, data, shardId)   // data = { t, s, op, d } そのまま
 *     this.emit(data.t, data.d, shardId)       // client.ws.on(data.t, ...) で同じものを d だけ受け取れる
 *   の順で発火する。挙動としてはどちらも使えるが、後者は GatewayDispatchEvents（discord-api-types。
 *   channel/package.json の直接依存ではなく discord.js 経由の間接依存）を追加 import する必要がある。
 *   client.on('raw', ...) は discord.js 自身が Events.Raw として公開している安定 API で追加 import が
 *   要らないため、こちらを採用する。VOICE_STATE_UPDATE は Bot 自身（data.d.user_id === client.user.id）の
 *   ものだけを転送する。
 *
 * 環境変数
 *   DISCORD_BOT_STATE_DIR   状態ファイルの置き場（既定 ~/.claude/discord-bot）。ソケットは
 *                           <STATE_DIR>/voice.sock、voice プロセスのログは <STATE_DIR>/voice.log
 */
import type { Client } from 'discord.js'
import { createConnection, type Socket } from 'node:net'
import { existsSync, mkdirSync, openSync } from 'fs'
import { homedir } from 'os'
// join() は voice への入室リクエストを表す公開関数名として使うため、パス結合は別名で import する
import { join as joinPath } from 'path'

const STATE_DIR = process.env.DISCORD_BOT_STATE_DIR ?? joinPath(homedir(), '.claude', 'discord-bot')
const SOCK_PATH = joinPath(STATE_DIR, 'voice.sock')
const VOICE_LOG_FILE = joinPath(STATE_DIR, 'voice.log')

const RECONNECT_MIN_MS = 1_000
const RECONNECT_MAX_MS = 30_000
const REQUEST_TIMEOUT_MS = 20_000
/** この間隔より短い周期で voice プロセスを再起動しない（起動待ちの間の二重起動防止） */
const SPAWN_COOLDOWN_MS = 5_000
/** 未接続時に溜めておく送信キューの上限（張り付いた古いイベントを無限に溜めない） */
const MAX_QUEUE = 100

export type TranscriptEvent = {
  guildId: string
  channelId: string
  userId: string
  username: string
  text: string
  startedAt: string
  endedAt: string
}

export type StatusResult = {
  state: 'idle' | 'joined'
  channelId?: string
  whisper: 'ready' | 'starting' | 'down'
}

function log(msg: string): void {
  process.stderr.write(`discord channel: voice-control: ${msg}\n`)
}

let sock: Socket | null = null
let connecting = false
let recvBuffer = ''
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let backoffMs = RECONNECT_MIN_MS
let writeQueue: string[] = []
/** join() が一度でも呼ばれたか。true の間だけ再接続時に voice プロセスの起動を試みる */
let voiceRequested = false
let lastSpawnAt = 0
let requestSeq = 0
let activeChannelId_: string | null = null

const pending = new Map<string, { resolve: (v: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>()

let client_: Client | null = null
let onTranscript_: ((t: TranscriptEvent) => void) | null = null

/** server.ts から一度だけ呼ぶ。Gateway 中継の listener 登録と sendPayload / transcript の宛先を設定する */
export function initVoiceControl(client: Client, onTranscript: (t: TranscriptEvent) => void): void {
  client_ = client
  onTranscript_ = onTranscript
  client.on('raw', (data: { t?: string; d?: any }) => {
    if (data.t === 'VOICE_STATE_UPDATE') {
      if (!client.user || data.d?.user_id !== client.user.id) return // Bot 自身の状態更新だけ中継する
      sendGatewayEvent('VOICE_STATE_UPDATE', data.d)
    } else if (data.t === 'VOICE_SERVER_UPDATE') {
      sendGatewayEvent('VOICE_SERVER_UPDATE', data.d)
    }
  })
}

/** Bot が入室中のボイスチャンネル ID。未入室なら null。fetchAllowedChannel() の一時許可に使う */
export function activeChannelId(): string | null {
  return activeChannelId_
}

/** voice に通話参加を依頼する。userIds は access.allowFrom（文字起こしの対象を絞る） */
export async function join(guildId: string, channelId: string, userIds: string[]): Promise<{ guildId: string; channelId: string }> {
  voiceRequested = true
  const res = await sendRequest('join', { guildId, channelId, userIds })
  return { guildId: res.guildId, channelId: res.channelId }
}

export async function leave(): Promise<void> {
  await sendRequest('leave', {})
}

export async function status(): Promise<StatusResult> {
  const res = await sendRequest('status', {})
  return { state: res.state, channelId: res.channelId, whisper: res.whisper }
}

// --- リクエスト/応答 -------------------------------------------------------

function sendRequest(t: string, extra: Record<string, unknown>): Promise<any> {
  const requestId = `${Date.now()}-${++requestSeq}`
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(requestId)
      reject(new Error(`voice プロセスへの ${t} が ${REQUEST_TIMEOUT_MS / 1000} 秒以内に応答しなかったよ`))
    }, REQUEST_TIMEOUT_MS)
    pending.set(requestId, { resolve, reject, timer })
    trySend(JSON.stringify({ t, requestId, ...extra }))
  })
}

function sendGatewayEvent(event: string, d: unknown): void {
  trySend(JSON.stringify({ t: 'gateway', event, d }))
}

function trySend(line: string): void {
  if (sock && !sock.destroyed) {
    sock.write(line + '\n')
    return
  }
  writeQueue.push(line)
  if (writeQueue.length > MAX_QUEUE) writeQueue.shift()
  tryConnect()
}

// --- 接続の確立と再接続 -----------------------------------------------------

function tryConnect(): void {
  if (sock || connecting) return
  connecting = true
  const s = createConnection(SOCK_PATH)

  s.once('connect', () => {
    connecting = false
    backoffMs = RECONNECT_MIN_MS
    sock = s
    log('voice プロセスに接続したよ')
    for (const line of writeQueue.splice(0)) s.write(line + '\n')
  })

  s.on('data', (chunk: Buffer) => {
    recvBuffer += chunk.toString('utf8')
    let idx: number
    while ((idx = recvBuffer.indexOf('\n')) !== -1) {
      const line = recvBuffer.slice(0, idx)
      recvBuffer = recvBuffer.slice(idx + 1)
      if (line.trim()) handleLine(line)
    }
  })

  s.once('error', err => {
    connecting = false
    const code = (err as NodeJS.ErrnoException).code
    // ソケットが無い（voice が起きていない）/ 繋がらない（起動直後でまだ listen していない）
    // ときは、join() 済みなら voice プロセスを起動し直す。クールダウン中は起動待ちとみなして待つ
    if (voiceRequested && (code === 'ENOENT' || code === 'ECONNREFUSED') && Date.now() - lastSpawnAt > SPAWN_COOLDOWN_MS) {
      spawnVoiceProcess()
    }
  })

  s.once('close', () => {
    connecting = false
    if (sock === s) sock = null
    activeChannelId_ = null // voice との接続が切れた = 通話にも居られない
    scheduleReconnect()
  })
}

function scheduleReconnect(): void {
  if (reconnectTimer) return
  const wait = backoffMs
  backoffMs = Math.min(backoffMs * 2, RECONNECT_MAX_MS)
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    tryConnect()
  }, wait)
  reconnectTimer.unref()
}

/** session-control.ts の spawnRestartHelper() と同じ要領（detached + unref、ログは追記） */
function spawnVoiceProcess(): void {
  const pluginRoot = joinPath(import.meta.dir, '..')
  const entry = joinPath(pluginRoot, 'voice', 'index.js')
  if (!existsSync(entry)) {
    log(`voice プロセスが見つからないよ（${entry}）`)
    return
  }
  try {
    mkdirSync(STATE_DIR, { recursive: true })
    const fd = openSync(VOICE_LOG_FILE, 'a')
    const proc = Bun.spawn(['node', entry], {
      cwd: pluginRoot,
      env: { ...process.env, DISCORD_BOT_STATE_DIR: STATE_DIR },
      stdin: 'ignore',
      stdout: fd,
      stderr: fd,
      detached: true,
    })
    proc.unref()
    lastSpawnAt = Date.now()
    log(`voice process started: pid=${proc.pid} log=${VOICE_LOG_FILE}`)
  } catch (e) {
    log(`voice プロセスを起動できなかったよ: ${e}`)
  }
}

// --- 受信メッセージの振り分け -------------------------------------------------

function handleLine(line: string): void {
  let msg: any
  try {
    msg = JSON.parse(line)
  } catch {
    log(`不正な JSON を受信したよ: ${line.slice(0, 200)}`)
    return
  }

  const t = msg.t
  if (t === 'transcript') {
    handleTranscript(msg)
    return
  }
  if (t === 'sendPayload') {
    void forwardSendPayload(msg.d)
    return
  }
  if (t === 'joined') activeChannelId_ = msg.channelId ?? null
  else if (t === 'left') activeChannelId_ = null
  else if (t === 'error') activeChannelId_ = null // どの要求のエラーか問わず、入室中の前提を安全側に倒す

  const requestId = msg.requestId
  if (!requestId) return
  const entry = pending.get(requestId)
  if (!entry) return
  pending.delete(requestId)
  clearTimeout(entry.timer)
  if (t === 'error') entry.reject(new Error(msg.message ?? 'voice プロセスがエラーを返したよ'))
  else entry.resolve(msg)
}

function handleTranscript(msg: any): void {
  if (!onTranscript_) return
  const { guildId, channelId, userId, username, text, startedAt, endedAt } = msg
  if (!channelId || !userId || typeof text !== 'string') {
    log(`transcript の形が不正だよ: ${JSON.stringify(msg).slice(0, 200)}`)
    return
  }
  onTranscript_({ guildId, channelId, userId, username, text, startedAt, endedAt })
}

/** voice からの sendPayload（Gateway コマンド）を該当ギルドの shard へ流す */
async function forwardSendPayload(payload: { op: number; d: any } | undefined): Promise<void> {
  if (!client_ || !payload) return
  const guildId = payload.d?.guild_id
  const shard = (guildId ? client_.guilds.cache.get(guildId)?.shard : undefined) ?? client_.ws.shards.first()
  if (!shard) {
    log(`sendPayload を送れなかったよ（shard が見つからない, guildId=${guildId ?? '-'}）`)
    return
  }
  shard.send(payload)
}
