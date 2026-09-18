/**
 * presence.ts — Bot のステータス（アクティビティ）に Claude Code のコンテキスト使用量を表示する
 *
 * ステータスライン用に保存された JSON（~/.claude/tmp/statusline/<session_id>.json、statusline_dump.py が書く）
 * を 20 秒ごとに読み、この MCP サーバーを起動した Claude Code プロセス（親をたどって見つける）の
 * セッションのものを選んで表示する。ctx 80% 以上で取り込み中（赤）、対象が無ければ退席中（黄）。
 * 注意: フォルダを信頼していない Claude Code はステータスラインを実行しないので、ダンプは書かれない。
 *
 * 環境変数
 *   DISCORD_BOT_STATUSLINE_DIR  ダンプの場所（既定 ~/.claude/tmp/statusline）
 *   DISCORD_PRESENCE_MODE       playing（既定）/ watching / listening / competing / custom
 *   DISCORD_PRESENCE_INTERVAL   更新間隔（秒。既定 20）
 */
import { ActivityType, type Client, type PresenceStatusData } from 'discord.js'
import { readdirSync, readFileSync, statSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

const DUMP_DIR = process.env.DISCORD_BOT_STATUSLINE_DIR ?? join(homedir(), '.claude', 'tmp', 'statusline')
const MODE = (process.env.DISCORD_PRESENCE_MODE ?? 'playing').toLowerCase()
const INTERVAL_MS = Number(process.env.DISCORD_PRESENCE_INTERVAL ?? '20') * 1000
const WARN_PCT = 80

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

function fmtTokens(n: number): string {
  return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : `${Math.round(n / 1000)}K`
}

export function buildPresence(d: Dump | null): { status: PresenceStatusData; line1: string; line2: string } {
  if (!d) return { status: 'idle', line1: 'Claude セッションなし', line2: 'claude が動いていません' }
  const ctx = d.context_window ?? {}
  const used = ctx.used_percentage
  const parts = [used != null ? `ctx ${Math.round(used)}%` : 'ctx 計測前']
  for (const [key, label] of [['five_hour', '5h'], ['seven_day', '7d']] as const) {
    const v = d.rate_limits?.[key]
    if (v?.used_percentage != null) parts.push(`${label} ${Math.round(v.used_percentage)}%`)
  }
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
  log(`claude pid=${claudePid ?? 'unknown'} mode=${MODE} interval=${INTERVAL_MS / 1000}s`)
  let last = ''
  const tick = (): void => {
    try {
      const { status, line1, line2 } = buildPresence(pickSession(claudePid))
      const key = `${status}|${line1}|${line2}`
      if (key === last) return
      client.user?.setPresence({ status, activities: [activityFor(line1, line2)] })
      last = key
      log(`-> [${status}] ${line1} / ${line2}`)
    } catch (e) {
      log(`error: ${e}`)
    }
  }
  tick()
  setInterval(tick, INTERVAL_MS).unref()
  // 再接続後はプレゼンスを送り直す
  client.on('shardResume', () => { last = '' })
  client.on('shardReady', () => { last = '' })
}
