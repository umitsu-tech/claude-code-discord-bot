import { describe, expect, test } from 'bun:test'
import { EMBED_LIMITS, validateEmbeds } from './embeds'

const s = (n: number, ch = 'a') => ch.repeat(n)

describe('validateEmbeds', () => {
  test('accepts the supported keys and normalizes them', () => {
    const [e] = validateEmbeds([
      {
        title: '  Sessions  ',
        description: 'two running',
        url: 'https://example.com/x',
        color: '#5865F2',
        fields: [{ name: 'main', value: 'ctx 42%', inline: true }],
        footer: { text: 'updated' },
        timestamp: '2026-11-19T12:00:00+09:00',
      },
    ])
    expect(e).toEqual({
      title: 'Sessions',
      description: 'two running',
      url: 'https://example.com/x',
      color: 0x5865f2,
      fields: [{ name: 'main', value: 'ctx 42%', inline: true }],
      footer: { text: 'updated' },
      timestamp: '2026-11-19T03:00:00.000Z',
    })
  })

  test('accepts values exactly at the limits', () => {
    expect(() => validateEmbeds([{ title: s(EMBED_LIMITS.title) }])).not.toThrow()
    expect(() => validateEmbeds([{ description: s(EMBED_LIMITS.description) }])).not.toThrow()
    expect(() =>
      validateEmbeds([{ fields: Array.from({ length: EMBED_LIMITS.fields }, () => ({ name: 'n', value: 'v' })) }]),
    ).not.toThrow()
    expect(() => validateEmbeds(Array.from({ length: EMBED_LIMITS.perMessage }, () => ({ title: 't' })))).not.toThrow()
    // trim してから数える
    expect(() => validateEmbeds([{ title: `  ${s(EMBED_LIMITS.title)}\n` }])).not.toThrow()
  })

  test.each([
    ['title', [{ title: s(257) }], 'embeds[0].title is 257 characters (max 256)'],
    ['description', [{ description: s(4097) }], 'embeds[0].description is 4097 characters (max 4096)'],
    ['field name', [{ fields: [{ name: s(257), value: 'v' }] }], 'embeds[0].fields[0].name is 257 characters (max 256)'],
    ['field value', [{ title: 't', fields: [{ name: 'n', value: 'v' }, { name: 'n', value: s(1025) }] }], 'embeds[0].fields[1].value is 1025 characters (max 1024)'],
    ['footer', [{ footer: { text: s(2049) } }], 'embeds[0].footer.text is 2049 characters (max 2048)'],
    ['field count', [{ fields: Array.from({ length: 26 }, () => ({ name: 'n', value: 'v' })) }], 'embeds[0].fields has 26 items (max 25)'],
    ['embed count', Array.from({ length: 11 }, () => ({ title: 't' })), 'embeds has 11 items (Discord allows max 10 per message)'],
  ])('rejects %s over the limit', (_label, input, message) => {
    expect(() => validateEmbeds(input)).toThrow(message)
  })

  test('rejects more than 6000 characters across all embeds', () => {
    const two = [{ description: s(3000) }, { description: s(3000) }]
    expect(() => validateEmbeds(two)).not.toThrow()
    expect(() => validateEmbeds([...two, { title: 'x' }])).toThrow('embeds total is 6001 characters (max 6000')
  })

  test.each([
    ['not an array', { title: 't' }, 'embeds must be an array'],
    ['unknown key', [{ title: 't', image: { url: 'https://example.com/a.png' } }], 'embeds[0] has unsupported key(s): image'],
    ['empty embed', [{ color: 0xff0000 }], 'embeds[0] is empty'],
    ['blank field value', [{ fields: [{ name: 'n', value: '   ' }] }], 'embeds[0].fields[0].value must not be empty'],
    ['bad color', [{ title: 't', color: 'red' }], 'embeds[0].color must be'],
    ['color out of range', [{ title: 't', color: 0x1000000 }], 'embeds[0].color must be'],
    ['non-http url', [{ title: 't', url: 'javascript:alert(1)' }], 'embeds[0].url must be an http(s) URL'],
    ['bad timestamp', [{ title: 't', timestamp: 'yesterday' }], 'embeds[0].timestamp must be an ISO 8601 date string'],
    ['non-boolean inline', [{ fields: [{ name: 'n', value: 'v', inline: 'yes' }] }], 'embeds[0].fields[0].inline must be a boolean'],
  ])('rejects %s', (_label, input, message) => {
    expect(() => validateEmbeds(input)).toThrow(message)
  })
})
