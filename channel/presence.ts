/**
 * presence.ts — Bot のステータス（アクティビティ）に Claude Code のコンテキスト使用量を表示する
 *
 * ステータスライン用に保存された JSON（~/.claude/tmp/statusline/<session_id>.json、statusline_dump.py が書く）
 * を 20 秒ごとに読み、この MCP サーバーを起動した Claude Code プロセス（親をたどって見つける）の
 * セッションのものを選んで表示する。ctx 80% 以上で取り込み中（赤）、対象が無ければ退席中（黄）。
 * 注意: フォルダを信頼していない Claude Code はステータスラインを実行しないので、ダンプは書かれない。
 *
 * DISCORD_PRESENCE_AGENTS=on のときは、更新のたびに `claude agents --json` を非同期で動かし、
 * 同じマシンで作業中（state が working か blocked）のバックグラウンドのセッションの数を「作業 N」として
 * 使用量の後ろに足す（#105）。0 件や、コマンドが無い・失敗した・時間切れ・出力が読めないときは足さない。
 * 既定は off（更新のたびにプロセスを起こすうえ、数えるのはこの Bot と関係ない作業も含むマシン全体の数で、
 * サーバーの全員に見えるステータスに出るので、出すかどうかは持ち主が決める）。
 *
 * 環境変数
 *   DISCORD_BOT_STATUSLINE_DIR  ダンプの場所（既定 ~/.claude/tmp/statusline）
 *   DISCORD_PRESENCE_MODE       playing（既定）/ watching / listening / competing / custom
 *   DISCORD_PRESENCE_INTERVAL   更新間隔（秒。既定 20）
 *   DISCORD_PRESENCE_AGENTS     on で作業中のセッションの数を出す（既定 off）。startPresence() で読むので、
 *                               server.ts が起動時に読み込む .env に書いても効く
 */
import { ActivityType, type Client, type PresenceStatusData } from 'discord.js'
import { readdirSync, readFileSync, statSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

const DUMP_DIR = process.env.DISCORD_BOT_STATUSLINE_DIR ?? join(homedir(), '.claude', 'tmp', 'statusline')
const MODE = (process.env.DISCORD_PRESENCE_MODE ?? 'playing').toLowerCase()
const INTERVAL_MS = Number(process.env.DISCORD_PRESENCE_INTERVAL ?? '20') * 1000
const WARN_PCT = 80
/** claude agents --json を打ち切るまでの時間 */
const AGENTS_TIMEOUT_MS = 5_000

export type Dump = {
  session_id?: string
  cwd?: string
  _claude_pid?: number
  _dumped_at?: string
  model?: { id?: string; display_name?: string }
  effort?: { level?: string }
  context_window?: { used_percentage?: number; total_input_tokens?: number; context_window_size?: number }
  rate_limits?: Record<string, { used_percentage?: number }>
}

function log(msg: string): void {
  process.stderr.write(`discord channel: presence: ${msg}\n`)
}

/** 親プロセスをたどって Claude Code 本体の PID を返す（実行ファイル名で判定） */
export function findClaudePid(): number | null {
  let pid = process.ppid
  for (let i = 0; i < 8 && pid > 1; i++) {
    const out = Bun.spawnSync(['ps', '-o', 'ppid=,comm=', '-p', String(pid)]).stdout.toString().trim()
    if (!out) return null
    const sp = out.indexOf(' ')
    const ppid = Number(out.slice(0, sp))
    const exe = out.slice(sp + 1).trim()
    if (/(^|\/)claude$|\/claude\/versions\/[0-9]/.test(exe)) return pid
    pid = ppid
  }
  return null
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function readDumps(): Dump[] {
  let names: string[]
  try {
    names = readdirSync(DUMP_DIR).filter(n => n.endsWith('.json') && !n.startsWith('.'))
  } catch {
    return []
  }
  const out: Dump[] = []
  for (const n of names) {
    try {
      out.push(JSON.parse(readFileSync(join(DUMP_DIR, n), 'utf8')) as Dump)
    } catch {}
  }
  return out
}

function dumpedAt(d: Dump): number {
  const t = d._dumped_at ? Date.parse(d._dumped_at) : NaN
  return Number.isNaN(t) ? 0 : t
}

/**
 * この MCP サーバーの親 Claude Code セッションのダンプを選ぶ。
 * PID が分かっているときはその PID のダンプだけを見る（無ければ null）。ダンプの置き場は全インスタンス共用なので、
 * 別インスタンスのダンプに落ちると /restart の cwd や /model・/effort の監視を取り違える。
 * PID を特定できなかったときだけ、生きているセッションの最新を使う
 */
export function pickSession(claudePid: number | null): Dump | null {
  const dumps = readDumps()
  const pool = claudePid
    ? dumps.filter(d => d._claude_pid === claudePid)
    : dumps.filter(d => d._claude_pid && pidAlive(d._claude_pid))
  if (pool.length === 0) return null
  pool.sort((a, b) => dumpedAt(b) - dumpedAt(a))
  return pool[0]!
}

/** DISCORD_PRESENCE_AGENTS が on か。on / true / yes / 1 を受ける（大文字小文字は問わない） */
export function agentsEnabled(value: string | undefined = process.env.DISCORD_PRESENCE_AGENTS): boolean {
  return ['on', 'true', 'yes', '1'].includes((value ?? '').trim().toLowerCase())
}

/**
 * `claude agents --json` の出力から、作業中のバックグラウンドのセッションを数える。
 * kind が background で、state が working（ターン実行中）か blocked（返事待ち。作業は終わっていない）のもの。
 * 配列でなければ null（表示しない）
 */
export function countWorkingAgents(json: unknown): number | null {
  if (!Array.isArray(json)) return null
  return json.filter(a => {
    if (typeof a !== 'object' || a === null) return false
    const { kind, state } = a as { kind?: unknown; state?: unknown }
    return kind === 'background' && (state === 'working' || state === 'blocked')
  }).length
}

/** 同じ理由の失敗を更新のたびにログへ出さないよう、直前の理由を覚えておく（成功したら忘れる） */
let lastAgentsError = ''
function agentsFailed(msg: string): null {
  if (msg !== lastAgentsError) log(`${msg}（直るまで同じ理由ではログに出さない）`)
  lastAgentsError = msg
  return null
}

/** `claude agents --json` を動かして数える。どこかで失敗したら null（呼び出し側は表示しない） */
async function fetchWorkingAgents(): Promise<number | null> {
  let proc: ReturnType<typeof Bun.spawn<'ignore', 'pipe', 'ignore'>>
  try {
    // Bot トークンは渡さない（embed-command と同じ）
    const { DISCORD_BOT_TOKEN: _token, ...env } = process.env
    proc = Bun.spawn(['claude', 'agents', '--json'], { stdin: 'ignore', stdout: 'pipe', stderr: 'ignore', env })
  } catch (e) {
    return agentsFailed(`claude agents --json を起動できなかった: ${e}`)
  }
  const timer = setTimeout(() => proc.kill('SIGKILL'), AGENTS_TIMEOUT_MS)
  try {
    const [text, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
    if (code !== 0) return agentsFailed(`claude agents --json が終了コード ${code} で終わった`)
    const n = countWorkingAgents(JSON.parse(text))
    if (n === null) return agentsFailed('claude agents --json の出力が配列でない')
    lastAgentsError = ''
    return n
  } catch (e) {
    return agentsFailed(`claude agents --json を読めなかった: ${e}`)
  } finally {
    clearTimeout(timer)
  }
}

function fmtTokens(n: number): string {
  return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : `${Math.round(n / 1000)}K`
}

/** agents は作業中のバックグラウンドのセッションの数。1 以上のときだけ使用量の後ろに「作業 N」を足す */
export function buildPresence(
  d: Dump | null,
  agents: number | null = null,
): { status: PresenceStatusData; line1: string; line2: string } {
  if (!d) return { status: 'idle', line1: 'Claude セッションなし', line2: 'claude が動いていません' }
  const ctx = d.context_window ?? {}
  const used = ctx.used_percentage
  const parts = [used != null ? `ctx ${Math.round(used)}%` : 'ctx 計測前']
  for (const [key, label] of [['five_hour', '5h'], ['seven_day', '7d']] as const) {
    const v = d.rate_limits?.[key]
    if (v?.used_percentage != null) parts.push(`${label} ${Math.round(v.used_percentage)}%`)
  }
  if (agents != null && agents > 0) parts.push(`作業 ${agents}`)
  const details: string[] = []
  if (used != null) details.push(`${fmtTokens(ctx.total_input_tokens ?? 0)} / ${fmtTokens(ctx.context_window_size ?? 0)} tokens`)
  if (d.model?.display_name) details.push(d.effort?.level ? `${d.model.display_name} · effort ${d.effort.level}` : d.model.display_name)
  const at = dumpedAt(d)
  if (at) {
    const t = new Date(at + 9 * 3600 * 1000) // JST
    details.push(`更新 ${String(t.getUTCHours()).padStart(2, '0')}:${String(t.getUTCMinutes()).padStart(2, '0')}`)
  }
  const status: PresenceStatusData = (used ?? 0) >= WARN_PCT ? 'dnd' : 'online'
  return { status, line1: parts.join(' · ').slice(0, 128), line2: details.join(' · ').slice(0, 128) }
}

function activityFor(line1: string, line2: string) {
  if (MODE === 'custom') {
    const text = line2 ? `${line1} · ${line2}` : line1
    // Bot のカスタムステータスは state が表示される
    return { name: text.slice(0, 128), type: ActivityType.Custom, state: text.slice(0, 128) }
  }
  const types: Record<string, ActivityType> = {
    playing: ActivityType.Playing,
    watching: ActivityType.Watching,
    listening: ActivityType.Listening,
    competing: ActivityType.Competing,
  }
  return { name: line1, type: types[MODE] ?? ActivityType.Playing, state: line2 || undefined }
}

export function startPresence(client: Client): void {
  const claudePid = findClaudePid()
  const agentsOn = agentsEnabled()
  log(`claude pid=${claudePid ?? 'unknown'} mode=${MODE} interval=${INTERVAL_MS / 1000}s agents=${agentsOn ? 'on' : 'off'}`)
  let last = ''
  let agents: number | null = null
  let fetchingAgents = false
  const render = (): void => {
    try {
      const { status, line1, line2 } = buildPresence(pickSession(claudePid), agents)
      const key = `${status}|${line1}|${line2}`
      if (key === last) return
      client.user?.setPresence({ status, activities: [activityFor(line1, line2)] })
      last = key
      log(`-> [${status}] ${line1} / ${line2}`)
    } catch (e) {
      log(`error: ${e}`)
    }
  }
  // on のときは数を非同期で取り、取れてから描く（1 回の更新でプレゼンスを 2 度送らないため）。
  // 前回の取得がまだ終わっていなければ重ねて動かさず、前回の数のまま描く
  const tick = (): void => {
    if (!agentsOn || fetchingAgents) {
      render()
      return
    }
    fetchingAgents = true
    void fetchWorkingAgents().then(n => {
      fetchingAgents = false
      agents = n
      render()
    })
  }
  tick()
  setInterval(tick, INTERVAL_MS).unref()
  // 再接続後はプレゼンスを送り直す
  client.on('shardResume', () => { last = '' })
  client.on('shardReady', () => { last = '' })
}
