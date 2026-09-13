/**
 * voice-control.ts — channel サーバー（Bun）と voice プロセス（Node、#62）を Unix ドメインソケットで
 * つなぐ中継。Gateway のボイス関連イベントを voice へ転送し、voice からの応答・文字起こしを取り次ぐ。
 *
 * プロトコル（改行区切り JSON、詳細は #61 の最後のコメントと、レビューを受けた補足コメント）
 *   channel -> voice: { t: 'join' | 'leave' | 'status', requestId, ... } / { t: 'gateway', event, d }
 *   voice -> channel: { t: 'sendPayload', d } / { t: 'joined' | 'left' | 'status' | 'error', requestId, ... } / { t: 'transcript', ... }
 * voice 側がソケットを listen し、channel 側が繋ぎに行く。requestId は channel 側が採番し、
 * join/leave/status の応答はそれで突き合わせる。transcript と sendPayload は要求に紐づかない。
 * status の state は 'idle' | 'joining' | 'joined' の3値、channelId は未入室のとき null。
 *
 * 接続まわりの方針
 *   - voice プロセスの起動（node <plugin root>/voice/index.js を detached + unref）は join() が
 *     呼ばれたときだけ行う。channel サーバー起動時には何もしない
 *   - ソケットが無い/繋がらない場合、join() 済み（voiceRequested）であれば再接続のたびに起動を試みる
 *     （SPAWN_COOLDOWN_MS 未満の間隔では二重起動しない）。ただし連続 MAX_SPAWN_ATTEMPTS 回まで —
 *     voice が起動直後に落ち続けるケースで spawn が暴走しないようにする。接続に成功したら数え直す。
 *     上限に達したら、その時点の join を reject して以後の自動 spawn を止める（次の join() で仕切り直す）
 *   - 接続が切れたら 1s → 2s → ... → 最大 30s の指数バックオフで再接続を続ける
 *   - leave() が成功したら voiceRequested を false に戻す。voice を手で止めたときに channel が
 *     勝手に再起動しないようにするため
 *
 * 要求のタイムアウトについて
 *   voice の起動待ち（cold start）を計測に含めると、起動に時間がかかるだけで join が失敗してしまう。
 *   そのためタイマーは「ソケットに書き込めた時点」（sock.write のコールバック）から起こす。
 *   join は 30 秒、leave/status は 20 秒。ただし voiceRequested が false（誰も接続を試みていない）
 *   状態で要求を投げた場合は、繋がる見込みが薄いので従来どおり要求時点からタイマーを起こす
 *
 * 再接続後の状態同期
 *   close で activeChannelId_ を null にしたあと、再接続（2 回目以降の connect）に成功したら
 *   status を送り、state が 'joined' なら activeChannelId_ を復元する
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
 *   ものだけを転送する。gateway イベントは未接続時に溜めても再送する意味が無いので、キューには入れず
 *   接続していないときはそのまま捨てる
 *
 * voice からの sendPayload はローカルの信頼できるプロセスとはいえ、Gateway へ任意のコマンドを
 * 流す口を無条件に開けたくないので op === 4（Voice State Update）だけ転送する
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
const JOIN_TIMEOUT_MS = 30_000
const REQUEST_TIMEOUT_MS = 20_000
/** この間隔より短い周期で voice プロセスを再起動しない（起動待ちの間の二重起動防止） */
const SPAWN_COOLDOWN_MS = 5_000
/** 連続 spawn の上限。落ち続ける voice を無限に起動し直さない */
const MAX_SPAWN_ATTEMPTS = 3
/** 未接続時に溜めておく送信キューの上限（張り付いた古い要求を無限に溜めない） */
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
  state: 'idle' | 'joining' | 'joined'
  channelId: string | null
  whisper: 'ready' | 'starting' | 'down'
}

type PendingKind = 'join' | 'leave' | 'status'
type PendingEntry = {
  resolve: (v: any) => void
  reject: (e: Error) => void
  timer: ReturnType<typeof setTimeout> | null
  kind: PendingKind
}
type QueuedRequest = { requestId: string; line: string; timeoutMs: number }

function log(msg: string): void {
  process.stderr.write(`discord channel: voice-control: ${msg}\n`)
}

let sock: Socket | null = null
let connecting = false
let everConnected = false
let recvBuffer = ''
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let backoffMs = RECONNECT_MIN_MS
let writeQueue: QueuedRequest[] = []
/** join() が一度でも呼ばれたか。true の間だけ再接続時に voice プロセスの起動を試みる */
let voiceRequested = false
let lastSpawnAt = 0
let spawnFailures = 0
let spawnExhausted = false
let requestSeq = 0
let activeChannelId_: string | null = null

const pending = new Map<string, PendingEntry>()

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
  spawnFailures = 0
  spawnExhausted = false
  const res = await sendRequest('join', { guildId, channelId, userIds }, JOIN_TIMEOUT_MS)
  return { guildId: res.guildId, channelId: res.channelId }
}

export async function leave(): Promise<void> {
  await sendRequest('leave', {}, REQUEST_TIMEOUT_MS)
  voiceRequested = false // 手で止めたときに再接続のたびに再起動しないように
}

export async function status(): Promise<StatusResult> {
  const res = await sendRequest('status', {}, REQUEST_TIMEOUT_MS)
  return { state: res.state, channelId: res.channelId ?? null, whisper: res.whisper }
}

// --- リクエスト/応答 -------------------------------------------------------

function sendRequest(t: PendingKind, extra: Record<string, unknown>, timeoutMs: number): Promise<any> {
  const requestId = `${Date.now()}-${++requestSeq}`
  return new Promise((resolve, reject) => {
    pending.set(requestId, { resolve, reject, timer: null, kind: t })
    enqueueRequest(requestId, JSON.stringify({ t, requestId, ...extra }), timeoutMs)
  })
}

/** pending からエントリを取り除き、タイマーがあれば止める。呼び出し元が resolve/reject する */
function takePending(requestId: string): PendingEntry | undefined {
  const entry = pending.get(requestId)
  if (!entry) return undefined
  pending.delete(requestId)
  if (entry.timer) clearTimeout(entry.timer)
  return entry
}

function startTimeout(requestId: string, timeoutMs: number): void {
  const entry = pending.get(requestId)
  if (!entry || entry.timer) return // 応答済み、または既にタイマー起動済み
  entry.timer = setTimeout(() => {
    const e = takePending(requestId)
    e?.reject(new Error(`voice プロセスからの応答が ${timeoutMs / 1000} 秒以内に届かなかったよ`))
  }, timeoutMs)
}

function enqueueRequest(requestId: string, line: string, timeoutMs: number): void {
  if (sock && !sock.destroyed) {
    sock.write(line + '\n', () => startTimeout(requestId, timeoutMs))
    return
  }
  writeQueue.push({ requestId, line, timeoutMs })
  if (writeQueue.length > MAX_QUEUE) {
    const evicted = writeQueue.shift()!
    const entry = takePending(evicted.requestId)
    entry?.reject(new Error('voice への要求が多すぎて破棄されたよ'))
  }
  tryConnect()
  // 誰も voice を起動しようとしていない（join 未実行）ときは、繋がる見込みが薄いので
  // 書き込めるまで待たず、従来どおり要求時点からタイムアウトを起こす
  if (!voiceRequested) startTimeout(requestId, timeoutMs)
}

function sendGatewayEvent(event: string, d: unknown): void {
  // 未接続なら捨てる。古い VOICE_SERVER_UPDATE を後から再送しても意味が無いのでキューには入れない
  if (!sock || sock.destroyed) return
  sock.write(JSON.stringify({ t: 'gateway', event, d }) + '\n')
}

function rejectAllPending(err: Error): void {
  for (const requestId of [...pending.keys()]) {
    const entry = takePending(requestId)
    entry?.reject(err)
  }
  writeQueue = []
}

// --- 接続の確立と再接続 -----------------------------------------------------

function tryConnect(): void {
  if (sock || connecting) return
  connecting = true
  const s = createConnection(SOCK_PATH)

  s.once('connect', () => {
    connecting = false
    backoffMs = RECONNECT_MIN_MS
    spawnFailures = 0
    spawnExhausted = false
    const isReconnect = everConnected
    everConnected = true
    sock = s
    log('voice プロセスに接続したよ')
    for (const item of writeQueue.splice(0)) {
      // 応答を待つのをすでに諦めた古い要求（join のタイムアウト後など）は送らない。
      // 再接続した先の voice に古い join がそのまま届いて勝手に入室してしまうのを防ぐ
      if (!pending.has(item.requestId)) continue
      s.write(item.line + '\n', () => startTimeout(item.requestId, item.timeoutMs))
    }
    if (isReconnect) void resyncAfterReconnect()
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
    if (!voiceRequested || (code !== 'ENOENT' && code !== 'ECONNREFUSED')) return
    // ソケットが無い（voice が起きていない）/ 繋がらない（起動直後でまだ listen していない）
    if (spawnExhausted) return
    if (spawnFailures >= MAX_SPAWN_ATTEMPTS) {
      spawnExhausted = true
      const message = `voice プロセスの起動を ${MAX_SPAWN_ATTEMPTS} 回試したけど繋がらなかったよ。${VOICE_LOG_FILE} を確認してね`
      log(message)
      rejectAllPending(new Error(message))
      return
    }
    // クールダウン中は前の起動がまだ立ち上がり待ちとみなし、起動し直さない
    if (Date.now() - lastSpawnAt > SPAWN_COOLDOWN_MS) {
      spawnFailures++
      spawnVoiceProcess()
    }
  })

  s.once('close', () => {
    connecting = false
    if (sock === s) sock = null
    activeChannelId_ = null // voice との接続が切れた = 通話にも居られない（再接続後に resync で復元する）
    scheduleReconnect()
  })
}

/** 再接続後、voice の実際の状態を確認して activeChannelId_ を復元する */
async function resyncAfterReconnect(): Promise<void> {
  try {
    const res = await status()
    if (res.state === 'joined' && res.channelId) {
      activeChannelId_ = res.channelId
      log(`再接続後に入室状態を復元したよ（channelId=${res.channelId}）`)
    }
  } catch (e) {
    log(`再接続後の status 確認に失敗したよ: ${e}`)
  }
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
    log(`voice process started: pid=${proc.pid} log=${VOICE_LOG_FILE} (attempt ${spawnFailures}/${MAX_SPAWN_ATTEMPTS})`)
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

  const requestId = msg.requestId
  const peeked = requestId ? pending.get(requestId) : undefined

  if (t === 'joined') activeChannelId_ = msg.channelId ?? null
  else if (t === 'left') activeChannelId_ = null
  else if (t === 'error' && peeked && (peeked.kind === 'join' || peeked.kind === 'leave')) {
    // status の失敗では入室状態の前提を崩さない。join/leave の失敗だけ、入室していない扱いに戻す
    activeChannelId_ = null
  }

  if (!requestId) return
  const entry = takePending(requestId)
  if (!entry) return
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

/** voice からの sendPayload（Gateway コマンド）を該当ギルドの shard へ流す。
 *  ローカルの信頼できるプロセスとはいえ、Gateway へ任意のコマンドを流す口を無条件に開けたくないので
 *  op === 4（Voice State Update）以外は捨てる */
async function forwardSendPayload(payload: { op: number; d: any } | undefined): Promise<void> {
  if (!client_ || !payload) return
  if (payload.op !== 4) {
    log(`sendPayload を無視したよ（op=${payload.op} は Voice State Update 以外）`)
    return
  }
  const guildId = payload.d?.guild_id
  const shard = (guildId ? client_.guilds.cache.get(guildId)?.shard : undefined) ?? client_.ws.shards.first()
  if (!shard) {
    log(`sendPayload を送れなかったよ（shard が見つからない, guildId=${guildId ?? '-'}）`)
    return
  }
  shard.send(payload)
}
