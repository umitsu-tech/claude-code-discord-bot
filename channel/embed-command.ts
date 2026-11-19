/**
 * embed-command.ts — action: "embed-command" のスラッシュコマンド（#103）の処理本体。
 * server.ts の handleSlashCommand() が action === 'embed-command' のときにここへ渡す。認可
 * （allowFrom・受信設定）はすでに server.ts 側で済んでいる前提。
 *
 * commands.json の定義に書いたコマンド（command: 引数の配列）を、シェルを通さずに実行する。
 * 標準出力を JSON として読み、{ "content"?: string, "embeds": APIEmbed[] } の形ならそのまま返事にする。
 * Claude のターンを使わないので、Claude が長い作業の途中でもすぐ返る。
 *
 * - コマンドは定義に書いたものだけを動かす。Discord から渡る値（options）はコマンドに渡さない
 * - 環境変数は channel サーバーのものを引き継ぐが、Bot トークン（DISCORD_BOT_TOKEN）だけは渡さない
 * - 時間切れのときは、コマンドが起こした子プロセスごと止める（detached で新しいプロセスグループにして
 *   グループに SIGKILL を送る）。孫が標準出力を握ったまま残って読み取りが終わらない場合に備え、
 *   止めてから KILL_GRACE_MS たっても終わらなければ読み取りを打ち切る
 * - 形が違う・終了コードが 0 でない・時間切れのときは、短いエラーを本人にだけ返す（標準エラーは先頭だけ）
 *
 * 3 秒の応答期限に間に合わせるため deferReply → editReply で返す。voice-command.ts と同じく、
 * 返す内容を決めてから editReply を 1 回だけ呼ぶ。
 */
import { MessageFlags, type APIEmbed, type ChatInputCommandInteraction } from 'discord.js'
import { resolveEmbedCommand, type CommandDef } from './commands'
import { CONTENT_LIMIT, validateEmbeds } from './embeds'

/** 標準出力として受け付ける大きさ。Embed 10 個の上限（6000 文字）に比べて十分に大きい */
const MAX_STDOUT_BYTES = 1024 * 1024
/** 標準エラーは先頭だけ読めばよい */
const MAX_STDERR_BYTES = 64 * 1024
/** エラーの返事に添える標準エラーの文字数 */
const STDERR_HEAD_CHARS = 300
/** 時間切れでグループを止めてから、読み取りを打ち切るまでの待ち時間 */
const KILL_GRACE_MS = 2_000

export type EmbedReply = { content?: string; embeds: APIEmbed[] }
export type RunResult = { ok: true; reply: EmbedReply } | { ok: false; error: string }

function log(msg: string): void {
  process.stderr.write(`discord channel: embed-command: ${msg}\n`)
}

/**
 * コマンドの標準出力を読む。{ "content"?: string, "embeds": APIEmbed[] } でなければ、どこが駄目かを書いたエラーを投げる。
 * embeds の中身は reply ツールと同じ validateEmbeds() で確かめる。
 */
export function parseCommandOutput(stdout: string): EmbedReply {
  const trimmed = stdout.trim()
  if (!trimmed) throw new Error('stdout is empty (expected JSON like {"embeds": [...]})')
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch (e) {
    throw new Error(`stdout is not valid JSON (${(e as Error).message})`)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('stdout must be a JSON object like {"content": "...", "embeds": [...]}')
  }
  const obj = parsed as Record<string, unknown>
  const unknown = Object.keys(obj).filter(k => k !== 'content' && k !== 'embeds')
  if (unknown.length > 0) throw new Error(`unsupported key(s) in output: ${unknown.join(', ')} (supported: content, embeds)`)
  if (!('embeds' in obj)) throw new Error('output has no "embeds" array')

  const embeds = validateEmbeds(obj.embeds)
  let content: string | undefined
  if (obj.content !== undefined && obj.content !== null) {
    if (typeof obj.content !== 'string') throw new Error('content must be a string')
    if (obj.content.length > CONTENT_LIMIT) {
      throw new Error(`content is ${obj.content.length} characters (max ${CONTENT_LIMIT})`)
    }
    if (obj.content.trim()) content = obj.content
  }
  if (!content && embeds.length === 0) throw new Error('output has neither content nor embeds')
  return content ? { content, embeds } : { embeds }
}

/**
 * 上限まで読み、超えたぶんは読み捨てる（読まないと子プロセスが書き込みで止まるため）。
 * 初めて上限を超えたときに onOverflow を 1 回呼ぶ（標準出力ではコマンドを止めるのに使う）
 */
async function readCapped(
  reader: { read(): Promise<{ done: boolean; value?: Uint8Array }> },
  cap: number,
  onOverflow?: () => void,
): Promise<{ text: string; overflow: boolean }> {
  const chunks: Uint8Array[] = []
  let size = 0
  let overflow = false
  for (;;) {
    const { done, value } = await reader.read()
    if (done || !value) break
    const take = size < cap ? value.subarray(0, cap - size) : value.subarray(0, 0)
    if (take.length > 0) {
      chunks.push(take)
      size += take.length
    }
    if (take.length < value.length && !overflow) {
      overflow = true
      onOverflow?.()
    }
  }
  return { text: Buffer.concat(chunks).toString('utf8'), overflow }
}

/** 標準エラーの先頭を、エラーの返事に添えられる形にする（コードブロックを壊す ``` は崩す） */
export function stderrHead(stderr: string): string {
  const s = stderr.trim()
  if (!s) return ''
  const head = s.length > STDERR_HEAD_CHARS ? `${s.slice(0, STDERR_HEAD_CHARS)}…` : s
  return head.replace(/```/g, "'''")
}

function withStderr(message: string, stderr: string): string {
  const head = stderrHead(stderr)
  return head ? `${message}\n\`\`\`\n${head}\n\`\`\`` : message
}

/** Bot トークンを外した環境変数 */
function childEnv(): Record<string, string | undefined> {
  const { DISCORD_BOT_TOKEN: _token, ...rest } = process.env
  return rest
}

/** コマンドを動かして標準出力を読む。失敗のときは Discord にそのまま出せる短い日本語を返す */
export async function runEmbedCommand(command: string[], timeoutMs: number): Promise<RunResult> {
  let proc: ReturnType<typeof Bun.spawn<'ignore', 'pipe', 'pipe'>>
  try {
    proc = Bun.spawn(command, {
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      env: childEnv(),
      // 新しいプロセスグループにして、時間切れのときに子プロセスごと止められるようにする
      detached: true,
    })
  } catch (e) {
    log(`spawn failed: ${JSON.stringify(command)}: ${e}`)
    return { ok: false, error: `コマンドを起動できなかったよ（${command[0]}）。commands.json の command を確かめてね。` }
  }

  const outReader = proc.stdout.getReader()
  const errReader = proc.stderr.getReader()
  let timedOut = false
  let overflowed = false
  let abandon: () => void = () => {}
  const abandoned = new Promise<'abandoned'>(resolve => {
    abandon = () => resolve('abandoned')
  })
  let graceTimer: ReturnType<typeof setTimeout> | undefined
  /** グループごと止め、KILL_GRACE_MS たっても読み取りが終わらなければ打ち切る */
  const stop = (): void => {
    try {
      process.kill(-proc.pid, 'SIGKILL')
    } catch {
      try {
        proc.kill('SIGKILL')
      } catch {}
    }
    graceTimer ??= setTimeout(abandon, KILL_GRACE_MS)
  }
  const timer = setTimeout(() => {
    timedOut = true
    stop()
  }, timeoutMs)

  const finished = Promise.all([
    // 上限を超えた時点で止める。出し続けるコマンドを時間切れまで動かさないため
    readCapped(outReader, MAX_STDOUT_BYTES, () => {
      overflowed = true
      stop()
    }),
    readCapped(errReader, MAX_STDERR_BYTES),
    proc.exited,
  ])
  const result = await Promise.race([finished, abandoned])
  clearTimeout(timer)
  clearTimeout(graceTimer)

  const seconds = Math.round(timeoutMs / 100) / 10
  const overflowError = `出力が大きすぎるので止めたよ（${MAX_STDOUT_BYTES / 1024 / 1024} MiB まで）。`
  if (result === 'abandoned') {
    // グループを止めても標準出力が閉じない（別のグループに抜けた孫が握っている）。読み取りを捨てて返す
    void outReader.cancel().catch(() => {})
    void errReader.cancel().catch(() => {})
    log(`stopped (${overflowed ? 'stdout overflow' : `timeout ${timeoutMs}ms`}) but the output did not close: ${JSON.stringify(command)}`)
    return { ok: false, error: overflowed ? overflowError : `${seconds} 秒以内に終わらなかったので止めたよ。` }
  }
  const [out, err, exitCode] = result
  // 上限超えで止めたときは終了コードが SIGKILL になるので、先に見る
  if (overflowed) {
    log(`stdout exceeded ${MAX_STDOUT_BYTES} bytes, killed: ${JSON.stringify(command)}`)
    return { ok: false, error: overflowError }
  }
  if (timedOut) {
    log(`timed out after ${timeoutMs}ms: ${JSON.stringify(command)}`)
    return { ok: false, error: withStderr(`${seconds} 秒以内に終わらなかったので止めたよ。`, err.text) }
  }
  if (exitCode !== 0) {
    const how = proc.signalCode ? `シグナル ${proc.signalCode}` : `終了コード ${exitCode}`
    log(`exited with ${proc.signalCode ?? exitCode}: ${JSON.stringify(command)}: ${err.text.trim().slice(0, 1000)}`)
    return { ok: false, error: withStderr(`コマンドが失敗したよ（${how}）。`, err.text) }
  }
  try {
    return { ok: true, reply: parseCommandOutput(out.text) }
  } catch (e) {
    const detail = (e as Error).message
    log(`bad output: ${JSON.stringify(command)}: ${detail}`)
    return { ok: false, error: `出力を読めなかったよ: ${detail}` }
  }
}

function clip(s: string): string {
  return s.length > CONTENT_LIMIT ? `${s.slice(0, CONTENT_LIMIT - 1)}…` : s
}

/** スラッシュコマンドの本体。defer → コマンド実行 → 結果を editReply（失敗は本人にだけ） */
export async function handleEmbedCommand(interaction: ChatInputCommandInteraction, def: CommandDef): Promise<void> {
  const spec = resolveEmbedCommand(def)
  if ('error' in spec) {
    // 読み込み時に弾いているので通常は来ない
    await interaction.reply({ content: `/${def.name} の定義が正しくないよ: ${spec.error}`, flags: MessageFlags.Ephemeral }).catch(() => {})
    return
  }
  const ephemeral = def.ephemeral === true
  await interaction.deferReply(ephemeral ? { flags: MessageFlags.Ephemeral } : {})

  const result = await runEmbedCommand(spec.command, spec.timeoutMs)
  if (result.ok) {
    const { content, embeds } = result.reply
    await interaction
      .editReply({ embeds, ...(content ? { content } : {}) })
      .catch(e => log(`/${def.name}: editReply failed: ${e}`))
    return
  }

  const message = clip(`/${def.name}: ${result.error}`)
  if (ephemeral) {
    await interaction.editReply({ content: message }).catch(e => log(`/${def.name}: editReply failed: ${e}`))
    return
  }
  // 全員に見える形で defer したので、考え中の返事を消してから本人にだけエラーを見せる。
  // 考え中の返事が残っているあいだの followUp は、その返事を（全員に見えるまま）書き換えてしまうので、
  // 消せたときだけ送る。消せなかったときは固定の文言にとどめ、詳細は標準エラーのログにだけ残す
  const deleted = await interaction.deleteReply().then(
    () => true,
    e => {
      log(`/${def.name}: deleteReply failed: ${e}`)
      return false
    },
  )
  if (!deleted) {
    await interaction
      .editReply({ content: `/${def.name} は失敗したよ。` })
      .catch(e => log(`/${def.name}: editReply failed: ${e}`))
    return
  }
  await interaction
    .followUp({ content: message, flags: MessageFlags.Ephemeral })
    .catch(e => log(`/${def.name}: followUp failed: ${e}`))
}
