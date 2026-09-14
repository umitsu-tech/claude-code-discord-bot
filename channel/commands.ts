/**
 * commands.ts — Discord のスラッシュコマンド（アプリケーションコマンド）を Claude のスキル呼び出しに変換する
 *
 * コマンドの定義は JSON で持つ。
 *   - 同梱: ./commands.json（/ctx、/clear）
 *   - 追加: ${DISCORD_BOT_STATE_DIR:-~/.claude/discord-bot}/commands.json（ワークスペース固有のコマンドはこちらに書く）
 * 定義の形:
 *   { "name": "task", "description": "...", "skill": "/task-memo",
 *     "options": [ { "name": "text", "description": "...", "required": true } ] }
 * options は文字列引数だけを扱う。実行時は「<skill> <引数の値...>」という 1 行を Claude に渡す。
 *
 * skill の代わりに action を持つ定義（/model、/effort、/restart）は Claude に渡さず、
 * channel サーバー自身が session-control.ts で処理する（tmux ペインへ送り込む）。
 *
 * 起動時に Bot が参加している各ギルドへコマンドを登録する（ギルドコマンドは即時反映）。
 * 登録には Bot の招待時に applications.commands スコープが必要。無い場合はログに招待 URL を出す。
 * DISCORD_SLASH_COMMANDS=off で無効化できる。
 */
import { SlashCommandBuilder, type ChatInputCommandInteraction, type Client, type SlashCommandSubcommandsOnlyBuilder } from 'discord.js'
import { readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

/** action 付きはサーバー側で処理する（skill 省略可）。両方あれば action が優先 */
export type CommandAction = 'model' | 'effort' | 'restart' | 'voice'

export type CommandDef = {
  name: string
  description: string
  skill?: string
  action?: CommandAction
  options?: { name: string; description: string; required?: boolean }[]
  /** サブコマンド（例: /voice join）。あれば options は無視する（Discord は同じ階層に両方持てない） */
  subcommands?: { name: string; description: string }[]
}

const STATE_DIR = process.env.DISCORD_BOT_STATE_DIR ?? join(homedir(), '.claude', 'discord-bot')
const ENABLED = (process.env.DISCORD_SLASH_COMMANDS ?? 'on').toLowerCase() !== 'off'

function log(msg: string): void {
  process.stderr.write(`discord channel: commands: ${msg}\n`)
}

function readDefs(path: string): CommandDef[] {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (c): c is CommandDef =>
        typeof c === 'object' &&
        c !== null &&
        typeof (c as CommandDef).name === 'string' &&
        (typeof (c as CommandDef).skill === 'string' || typeof (c as CommandDef).action === 'string'),
    )
  } catch {
    return []
  }
}

/** 同梱 + 追加の定義を読む。同名は追加側が勝つ */
export function loadCommandDefs(): CommandDef[] {
  const builtin = readDefs(join(import.meta.dir, 'commands.json'))
  const extra = readDefs(join(STATE_DIR, 'commands.json'))
  const byName = new Map<string, CommandDef>()
  for (const c of [...builtin, ...extra]) byName.set(c.name, c)
  return [...byName.values()]
}

function toBuilder(c: CommandDef): SlashCommandBuilder | SlashCommandSubcommandsOnlyBuilder {
  const b = new SlashCommandBuilder().setName(c.name).setDescription((c.description || c.skill || c.name).slice(0, 100))
  if (c.subcommands?.length) {
    for (const s of c.subcommands) {
      b.addSubcommand(sub => sub.setName(s.name).setDescription((s.description || s.name).slice(0, 100)))
    }
    return b
  }
  for (const o of c.options ?? []) {
    b.addStringOption(opt =>
      opt.setName(o.name).setDescription((o.description || o.name).slice(0, 100)).setRequired(o.required ?? false),
    )
  }
  return b
}

/** Bot が参加している各ギルドにコマンドを登録する */
export async function registerSlashCommands(client: Client<true>): Promise<CommandDef[]> {
  if (!ENABLED) {
    log('disabled (DISCORD_SLASH_COMMANDS=off)')
    return []
  }
  const defs = loadCommandDefs()
  const builders = defs.map(toBuilder)
  for (const guild of client.guilds.cache.values()) {
    try {
      await guild.commands.set(builders)
      log(`registered ${defs.length} command(s) in ${guild.name}: ${defs.map(d => '/' + d.name).join(' ')}`)
    } catch (err) {
      const appId = client.application.id
      log(
        `failed to register in ${guild.name}: ${err}\n` +
          `  the bot probably lacks the applications.commands scope. Re-authorize with:\n` +
          `  https://discord.com/oauth2/authorize?client_id=${appId}&scope=bot%20applications.commands&permissions=0\n`,
      )
    }
  }
  return defs
}

/** 名前から定義を引く。サーバー側で処理するか（action）Claude に渡すか（skill）の判定に使う */
export function findCommand(defs: CommandDef[], name: string): CommandDef | undefined {
  return defs.find(d => d.name === name)
}

/**
 * interaction をスキル呼び出しの 1 行に変換する。「/discord-bot:ctx」「/task-memo 追加 明日〜」のような形。
 * action 付き（サーバー側で処理する定義）は null を返す。
 */
export function toSkillInvocation(defs: CommandDef[], interaction: ChatInputCommandInteraction): string | null {
  const def = findCommand(defs, interaction.commandName)
  if (!def || !def.skill || def.action) return null
  const args = (def.options ?? [])
    .map(o => interaction.options.getString(o.name))
    .filter((v): v is string => typeof v === 'string' && v.length > 0)
  return [def.skill, ...args].join(' ')
}
