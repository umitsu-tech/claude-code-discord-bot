/**
 * voice-control.ts — channel サーバー（Bun）と voice プロセス（Node、#62）を Unix ドメインソケットで
 * つなぐ中継。Gateway のボイス関連イベントを voice へ転送し、voice からの応答・文字起こしを取り次ぐ。
 *
 * プロトコル（改行区切り JSON、詳細は #61 の最後のコメントと、レビューを受けた補足コメント）
 *   channel -> voice: { t: 'join' | 'leave' | 'status', requestId, ... } / { t: 'gateway', event, d }
 *   voice -> channel: { t: 'sendPayload', d } / { t: 'joined' | 'left' | 'status' | 'error', requestId, ... } /
 *                      { t: 'transcript', ... } / { t: 'superseded' }
 * voice 側がソケットを listen し、channel 側が繋ぎに行く。requestId は channel 側が採番し、
 * join/leave/status の応答はそれで突き合わせる。transcript と sendPayload は要求に紐づかない。
 * status の state は 'idle' | 'joining' | 'joined' の3値、channelId は未入室のとき null。
 * voice は最後に繋いだクライアントを正とし、新しいクライアントが繋いだら古いソケットに
 * { t: 'superseded' } を送ってから end() する（#62/#69 側の実装。/restart で新旧 channel が
 * 重なる期間の混線防止）。superseded を受けた側は次の join() まで自動再接続しない
 *
 * 接続まわりの方針
 *   - voice プロセスの起動（node <plugin root>/voice/index.js を detached + unref）は join() が
 *     呼ばれたときだけ行う。channel サーバー起動時には何もしない
 *   - ソケットが無い/繋がらない場合、join() 済み（voiceRequested）であれば再接続のたびに起動を試みる
 *     （SPAWN_COOLDOWN_MS 未満の間隔では二重起動しない）。ただし連続 MAX_SPAWN_ATTEMPTS 回まで —
 *     voice が起動直後に落ち続けるケースで spawn が暴走しないようにする。
 *     カウンタをリセットするのは「voice から何か応答が 1 回でも返ってきたとき」（connect 成功しただけ
 *     ではリセットしない — listen した直後に死ぬプロセスだと connect は毎回成功してしまうため）と
 *     「明示的に join() が呼ばれたとき」の 2 つだけ。上限に達したら、その時点の保留中の要求（join
 *     など）をまとめて reject し、以後の自動 spawn を止める。次に join() が呼ばれたら、カウンタと
 *     一緒に reconnectTimer もクリアして backoffMs を初期値に戻し、仕切り直す
 *   - 接続が切れたら 1s → 2s → ... → 最大 30s の指数バックオフで再接続を続ける。ただし voice から
 *     { t: 'superseded' } を受けたあとは、次に join() が呼ばれるまで再接続を止める（新旧 channel が
 *     1 秒周期で voice を奪い合うのを防ぐ）
 *   - leave() が成功したら voiceRequested を false に戻す。voice を手で止めたときに channel が
 *     勝手に再起動しないようにするため
 *   - ENOENT / ECONNREFUSED（voice が居ない/起動待ち）以外の接続エラー（EACCES など、リトライしても
 *     直らない類）は、保留中の要求をその場でそのエラーで reject する
 *
 * 要求のタイムアウトについて
 *   voice の起動待ち（cold start）を計測に含めると、起動に時間がかかるだけで join が失敗してしまう。
 *   そのためタイマーは「ソケットに書き込めた時点」（sock.write のコールバック）から起こす。
 *   join は 30 秒、leave/status は 20 秒。ただし voiceRequested が false（誰も接続を試みていない）
 *   状態で要求を投げた場合は、繋がる見込みが薄いので従来どおり要求時点からタイマーを起こす。
 *   ソケットが close したときは、すでに書き込み済みで応答待ちの要求はタイムアウトを待たずに
 *   「接続が切れた」で即 reject する（書き込めていない = writeQueue に残っているものはそのまま残す）
 *
 * 入室状態の同期
 *   activeChannelId_ は 3 つの経路から更新される。
 *     1. join/leave の応答（joined で設定、left や join の失敗で解除）
 *     2. status の応答（接続成功時は初回を含め毎回 status を送って同期する。leave が失敗したときも
 *        「実際にはまだ入室中かもしれない」ので status を送って同期する。通常の status() 呼び出しの
 *        応答でも同様に同期する）
 *     3. Bot 自身の VOICE_STATE_UPDATE（Discord 自身が報告してくる正の情報。voice が Gateway 切断で
 *        自発的に idle に戻っても、これで channel 側の一時許可がすぐ外れる）
 *
 * Gateway 中継について
 *   discord.js 14.27 の WebSocketManager#attachEvents（node_modules/discord.js/src/client/websocket/
 *   WebSocketManager.js:232-234）は、ws から Dispatch パケットが来るたびに
 *     client.emit(Events.Raw, data, shardId)   // data = { t, s, op, d } そのまま
 *     this.emit(data.t, data.d, shardId)       // client.ws.on(data.t, ...) で同じものを d だけ受け取れる
 *   の順で発火する。挙動としてはどちらも使えるが、後者は GatewayDispatchEvents（discord-api-types。
 *   channel/package.json の直接依存ではなく discord.js 経由の間接依存）を追加 import する必要がある。
 *   client.on('raw', ...) は discord.js が実行時に Events.Raw = 'raw' として emit しているイベントだが、
 *   typings/index.d.ts の ClientEvents にはキーが無い（型定義からは外れている）。ただし Client#on には
 *   ClientEvents に無いイベント名向けのフォールバックのオーバーロード（listener の引数が any[] になる）
 *   があるので、キャストや型の緩和なしでそのまま tsc を通る。追加 import が要らないぶんこちらを採用した。
 *   VOICE_STATE_UPDATE は Bot 自身（data.d.user_id === client.user.id）のものだけを転送する。
 *   gateway イベントは未接続時に溜めても再送する意味が無いので、キューには入れず接続していないときは
 *   そのまま捨てる
 *
 * voice からの sendPayload はローカルの信頼できるプロセスとはいえ、Gateway へ任意のコマンドを
 * 流す口を無条件に開けたくないので op === 4（Voice State Update）だけ転送する。guild_id が無い/
 * 該当 shard が見つからないときはフォールバックせず、送らずにログだけ残す
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
  /** sock.write() のコールバックが呼ばれたか。true のものだけ close で即 reject する */
  written: boolean
}
type QueuedRequest = { requestId: string; line: string; timeoutMs: number }

function log(msg: string): void {
  process.stderr.write(`discord channel: voice-control: ${msg}\n`)
}

let sock: Socket | null = null
let connecting = false
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let backoffMs = RECONNECT_MIN_MS
let writeQueue: QueuedRequest[] = []
/** join() が一度でも呼ばれたか。true の間だけ再接続時に voice プロセスの起動を試みる */
let voiceRequested = false
/** { t: 'superseded' } を受けたか。true の間は次の join() まで自動再接続しない */
let supersededByAnother = false
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
      // Discord 自身が報告してくる正の情報。voice 側の自己申告（joined/left/status）とは別経路で
      // activeChannelId_ を同期する。channel_id が null ならボイスチャンネルに居ない
      activeChannelId_ = data.d?.channel_id ?? null
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

/** voice プロセスとソケットが繋がっているか。false なら要求を送っても voice の起動待ち（最大 REQUEST_TIMEOUT_MS）に
 *  なるだけなので、呼び出し側（voice-command.ts の status/leave）は事前にこれを見て即座に「未入室」を返せる */
export function isConnected(): boolean {
  return sock !== null && !sock.destroyed
}

/** voice に通話参加を依頼する。userIds は access.allowFrom（文字起こしの対象を絞る） */
export async function join(guildId: string, channelId: string, userIds: string[]): Promise<{ guildId: string; channelId: string }> {
  voiceRequested = true
  spawnFailures = 0
  spawnExhausted = false
  supersededByAnother = false
  // 上限到達や superseded で止まっていた再接続を、明示的な join() で仕切り直す
  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
  backoffMs = RECONNECT_MIN_MS
  const res = await sendRequest('join', { guildId, channelId, userIds }, JOIN_TIMEOUT_MS)
  return { guildId: res.guildId, channelId: res.channelId }
}

export async function leave(): Promise<void> {
  await sendRequest('leave', {}, REQUEST_TIMEOUT_MS)
  voiceRequested = false // 手で止めたときに再接続のたびに再起動しないように
}

/** state/channelId で activeChannelId_ を同期しつつ、正規化した形を返す */
export async function status(): Promise<StatusResult> {
  const res = await sendRequest('status', {}, REQUEST_TIMEOUT_MS)
  const result: StatusResult = { state: res.state, channelId: res.channelId ?? null, whisper: res.whisper }
  applyStatusResult(result)
  return result
}

function applyStatusResult(res: StatusResult): void {
  activeChannelId_ = res.state === 'joined' && res.channelId ? res.channelId : null
}

/** status を送って activeChannelId_ を同期する。失敗してもログを残すだけ（呼び出し元を止めない） */
async function syncStatus(reason: string): Promise<void> {
  try {
    await status() // status() 自身が activeChannelId_ を同期する
  } catch (e) {
    log(`status 同期に失敗したよ（${reason}）: ${e}`)
  }
}

// --- リクエスト/応答 -------------------------------------------------------

function sendRequest(t: PendingKind, extra: Record<string, unknown>, timeoutMs: number): Promise<any> {
  const requestId = `${Date.now()}-${++requestSeq}`
  return new Promise((resolve, reject) => {
    pending.set(requestId, { resolve, reject, timer: null, kind: t, written: false })
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

/** 実際に書き込めた（sock.write のコールバック）ときに呼ぶ。written を立ててからタイマーを起こす */
function onWritten(requestId: string, timeoutMs: number): void {
  const entry = pending.get(requestId)
  if (!entry) return
  entry.written = true
  startTimeout(requestId, timeoutMs)
}

function enqueueRequest(requestId: string, line: string, timeoutMs: number): void {
  if (sock && !sock.destroyed) {
    sock.write(line + '\n', () => onWritten(requestId, timeoutMs))
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
  // ソケットごとのローカル変数にする。切断時に不完全な行が残ったまま次の接続の
  // 先頭行と連結されるのを防ぐ（以前はモジュール変数で共有していた）
  let recvBuffer = ''

  s.once('connect', () => {
    connecting = false
    backoffMs = RECONNECT_MIN_MS
    // spawnFailures/spawnExhausted はここではリセットしない — listen した直後に落ちるプロセスだと
    // connect 自体は毎回成功してしまうため。リセットは「voice から応答が返ってきたとき」と
    // 「明示的な join()」だけ
    sock = s
    log('voice プロセスに接続したよ')
    for (const item of writeQueue.splice(0)) {
      // 応答を待つのをすでに諦めた古い要求（join のタイムアウト後など）は送らない。
      // 再接続した先の voice に古い join がそのまま届いて勝手に入室してしまうのを防ぐ
      if (!pending.has(item.requestId)) continue
      s.write(item.line + '\n', () => onWritten(item.requestId, item.timeoutMs))
    }
    // 接続成功時は初回も含めて必ず status を送り、実際の入室状態に同期する
    void syncStatus('接続直後')
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
    if (code !== 'ENOENT' && code !== 'ECONNREFUSED') {
      // 権限エラーなど、リトライしても直らない類のエラー。保留中の要求をその場で reject する
      // （バックオフでの再接続自体は close ハンドラ側で続ける — 外部要因が直る可能性もあるため）
      const message = `voice プロセスへの接続に失敗したよ（${code ?? err.message}）`
      log(message)
      rejectAllPending(new Error(message))
      return
    }
    if (!voiceRequested || spawnExhausted) return
    // ソケットが無い（voice が起きていない）/ 繋がらない（起動直後でまだ listen していない）
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
    activeChannelId_ = null // voice との接続が切れた = 通話にも居られない（再接続後に status で復元する）
    // 書き込み済みで応答待ちのものは、タイムアウトを待たずに「接続が切れた」で即 reject する。
    // まだ書き込めていない（writeQueue に残っている）ものはそのまま残す — 再接続後にまとめて判断する
    for (const requestId of [...pending.keys()]) {
      const entry = pending.get(requestId)
      if (entry?.written) {
        takePending(requestId)
        entry.reject(new Error('voice との接続が切れたよ'))
      }
    }
    scheduleReconnect()
  })
}

function scheduleReconnect(): void {
  if (supersededByAnother) return // 別の channel サーバーが正になった。次の join() まで手を出さない
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

  // voice から何か返ってきた = 少なくとも今は生きて話せている。spawn の連続失敗カウントをリセットする
  // （connect 成功時にはリセットしない。listen 直後に落ちるプロセスだと connect 自体は毎回
  // 成功してしまうため、"応答が返ってきた" ことを生存の証拠にする）
  spawnFailures = 0
  spawnExhausted = false

  const t = msg.t
  if (t === 'superseded') {
    // 別の channel サーバーが新しく繋いできた。voice はこのあとソケットを end() する。
    // 次に join() が呼ばれるまで自動再接続しない（新旧 channel が voice を奪い合わないように）
    log('別の channel サーバーが voice に接続したよ。次の join() まで再接続しないよ')
    supersededByAnother = true
    activeChannelId_ = null
    return
  }
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
  else if (t === 'error' && peeked?.kind === 'join') {
    // join の失敗は素直に「入室していない」扱いにする
    activeChannelId_ = null
  } else if (t === 'error' && peeked?.kind === 'leave') {
    // 退室に失敗したなら実際はまだ入室中かもしれない。決め打ちで消さず status で実態に合わせる
    void syncStatus('leave の失敗')
  }
  // status の error では activeChannelId_ に触れない（次の status/VOICE_STATE_UPDATE に任せる）

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
 *  op === 4（Voice State Update）以外は捨てる。guild_id が無い/該当 shard が見つからないときも
 *  フォールバックせず、送らずにログだけ残す */
async function forwardSendPayload(payload: { op: number; d: any } | undefined): Promise<void> {
  if (!client_ || !payload) return
  if (payload.op !== 4) {
    log(`sendPayload を無視したよ（op=${payload.op} は Voice State Update 以外）`)
    return
  }
  const guildId = payload.d?.guild_id
  if (!guildId) {
    log('sendPayload を送れなかったよ（guild_id が無い）')
    return
  }
  const shard = client_.guilds.cache.get(guildId)?.shard
  if (!shard) {
    log(`sendPayload を送れなかったよ（shard が見つからない, guildId=${guildId}）`)
    return
  }
  shard.send(payload)
}
