import { describe, expect, test } from 'bun:test'
import { resolveEmbedCommand } from './commands'
import { parseCommandOutput, runEmbedCommand } from './embed-command'

const sh = (script: string) => ['sh', '-c', script]

describe('parseCommandOutput', () => {
  test('reads content and embeds', () => {
    const out = JSON.stringify({ content: '2 sessions', embeds: [{ title: 'Sessions', color: 3066993 }] })
    expect(parseCommandOutput(`${out}\n`)).toEqual({ content: '2 sessions', embeds: [{ title: 'Sessions', color: 3066993 }] })
  })

  test('content is optional', () => {
    expect(parseCommandOutput('{"embeds":[{"description":"ok"}]}')).toEqual({ embeds: [{ description: 'ok' }] })
  })

  test.each([
    ['empty output', '', 'stdout is empty'],
    ['not JSON', 'Sessions: 2', 'stdout is not valid JSON'],
    ['an array', '[{"title":"t"}]', 'stdout must be a JSON object'],
    ['no embeds key', '{"content":"hi"}', 'output has no "embeds" array'],
    ['unknown key', '{"embeds":[],"text":"hi"}', 'unsupported key(s) in output: text'],
    ['nothing to show', '{"embeds":[]}', 'output has neither content nor embeds'],
    ['long content', JSON.stringify({ content: 'a'.repeat(2001), embeds: [] }), 'content is 2001 characters (max 2000)'],
    ['an over-limit embed', JSON.stringify({ embeds: [{ title: 'a'.repeat(257) }] }), 'embeds[0].title is 257 characters (max 256)'],
  ])('rejects %s', (_label, stdout, message) => {
    expect(() => parseCommandOutput(stdout)).toThrow(message)
  })
})

describe('resolveEmbedCommand', () => {
  test('defaults and clamps timeout_ms', () => {
    const base = { name: 'x', description: '', action: 'embed-command' as const, command: ['true'] }
    expect(resolveEmbedCommand(base)).toEqual({ command: ['true'], timeoutMs: 15_000 })
    expect(resolveEmbedCommand({ ...base, timeout_ms: 10 })).toEqual({ command: ['true'], timeoutMs: 1_000 })
    expect(resolveEmbedCommand({ ...base, timeout_ms: 10_000_000 })).toEqual({ command: ['true'], timeoutMs: 600_000 })
  })

  test('rejects a command that is not an array of strings', () => {
    const base = { name: 'x', description: '', action: 'embed-command' as const }
    for (const command of [undefined, [], 'sh /x.sh', ['sh', 1], ['']]) {
      expect(resolveEmbedCommand({ ...base, command: command as string[] })).toHaveProperty('error')
    }
  })
})

describe('runEmbedCommand', () => {
  test('returns the parsed output', async () => {
    const r = await runEmbedCommand(sh(`printf '%s' '{"embeds":[{"title":"ok"}]}'`), 5_000)
    expect(r).toEqual({ ok: true, reply: { embeds: [{ title: 'ok' }] } })
  })

  test('passes arguments without a shell', async () => {
    const r = await runEmbedCommand(['printf', '{"embeds":[{"title":"%s"}]}', '$HOME; echo injected'], 5_000)
    expect(r).toEqual({ ok: true, reply: { embeds: [{ title: '$HOME; echo injected' }] } })
  })

  test('does not pass the bot token', async () => {
    process.env.DISCORD_BOT_TOKEN = 'secret-token-for-test'
    try {
      const r = await runEmbedCommand(sh(`printf '{"embeds":[{"title":"[%s]"}]}' "$DISCORD_BOT_TOKEN"`), 5_000)
      expect(r).toEqual({ ok: true, reply: { embeds: [{ title: '[]' }] } })
    } finally {
      delete process.env.DISCORD_BOT_TOKEN
    }
  })

  test('reports a non-zero exit with the head of stderr', async () => {
    const r = await runEmbedCommand(sh('echo "no such session" >&2; exit 3'), 5_000)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error).toContain('終了コード 3')
      expect(r.error).toContain('no such session')
    }
  })

  test('reports output that is not the expected JSON', async () => {
    const r = await runEmbedCommand(sh('echo "Sessions: 2"'), 5_000)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('stdout is not valid JSON')
  })

  test('reports a command that cannot start', async () => {
    const r = await runEmbedCommand(['/nonexistent/embed-command-test'], 5_000)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('起動できなかった')
  })

  test('kills the command and its children on timeout', async () => {
    const started = Date.now()
    // 子の sleep が標準出力を握ったままでも、グループごと止めるのですぐ返る
    const r = await runEmbedCommand(sh('sleep 30 & sleep 30'), 300)
    expect(Date.now() - started).toBeLessThan(1_500)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('0.3 秒以内に終わらなかった')
  })

  test('stops a command whose output passes 1 MiB', async () => {
    const started = Date.now()
    // 出し続けるコマンドでも、時間切れを待たずに上限を超えた時点で止まる
    const r = await runEmbedCommand(['yes'], 10_000)
    expect(Date.now() - started).toBeLessThan(3_000)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('出力が大きすぎるので止めた')
  })
})
