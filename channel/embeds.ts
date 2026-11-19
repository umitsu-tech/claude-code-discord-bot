/**
 * embeds.ts — Discord の Embed を送る前に、形と Discord の上限を確かめる（#103）
 *
 * reply ツールの embeds と、embed-command のコマンド出力の両方から使う。
 * 扱うキーは title・description・url・color・fields[{name, value, inline}]・footer{text}・timestamp だけで、
 * それ以外のキーはエラーにする（黙って捨てると、書いたのに表示されない理由が分からなくなるため）。
 *
 * 上限は Discord の API ドキュメント（Embed Limits）のとおり。
 *   1 メッセージ 10 個、title 256、description 4096、fields 25 個、field.name 256、field.value 1024、
 *   footer.text 2048、1 メッセージの全 Embed の title・description・field.name・field.value・footer.text の合計 6000
 * Discord は前後の空白を数えずに切り落とすので、ここでも trim してから数え、trim した値を送る。
 * 文字数は JS の length（UTF-16 の単位）で数える。絵文字などを 2 と数えるぶん、Discord より厳しめになる。
 */
import type { APIEmbed, APIEmbedField } from 'discord.js'

export const EMBED_LIMITS = {
  perMessage: 10,
  title: 256,
  description: 4096,
  fields: 25,
  fieldName: 256,
  fieldValue: 1024,
  footerText: 2048,
  total: 6000,
} as const

/** メッセージ本文（content）の上限 */
export const CONTENT_LIMIT = 2000

const EMBED_KEYS = ['title', 'description', 'url', 'color', 'fields', 'footer', 'timestamp']
const FIELD_KEYS = ['name', 'value', 'inline']
const FOOTER_KEYS = ['text']

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function rejectUnknownKeys(obj: Record<string, unknown>, allowed: string[], path: string): void {
  const unknown = Object.keys(obj).filter(k => !allowed.includes(k))
  if (unknown.length > 0) {
    throw new Error(`${path} has unsupported key(s): ${unknown.join(', ')} (supported: ${allowed.join(', ')})`)
  }
}

/** 文字列を trim して上限を確かめる。空なら undefined（必須なら呼び出し側がエラーにする） */
function text(v: unknown, path: string, limit: number): string | undefined {
  if (typeof v !== 'string') throw new Error(`${path} must be a string`)
  const s = v.trim()
  if (s.length > limit) throw new Error(`${path} is ${s.length} characters (max ${limit})`)
  return s.length > 0 ? s : undefined
}

function requiredText(v: unknown, path: string, limit: number): string {
  const s = text(v, path, limit)
  if (s === undefined) throw new Error(`${path} must not be empty`)
  return s
}

/** 0xRRGGBB の整数か "#RRGGBB" を受ける */
function color(v: unknown, path: string): number {
  if (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 0xffffff) return v
  if (typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v)) return parseInt(v.slice(1), 16)
  throw new Error(`${path} must be an integer 0-16777215 (0xRRGGBB) or a "#RRGGBB" string`)
}

function url(v: unknown, path: string): string {
  if (typeof v === 'string') {
    try {
      const u = new URL(v)
      if (u.protocol === 'http:' || u.protocol === 'https:') return v
    } catch {}
  }
  throw new Error(`${path} must be an http(s) URL`)
}

function timestamp(v: unknown, path: string): string {
  const d = new Date(typeof v === 'string' ? Date.parse(v) : typeof v === 'number' ? v : NaN)
  if (Number.isNaN(d.getTime())) throw new Error(`${path} must be an ISO 8601 date string`)
  return d.toISOString()
}

function field(v: unknown, path: string): APIEmbedField {
  if (!isObject(v)) throw new Error(`${path} must be an object with name and value`)
  rejectUnknownKeys(v, FIELD_KEYS, path)
  const out: APIEmbedField = {
    name: requiredText(v.name, `${path}.name`, EMBED_LIMITS.fieldName),
    value: requiredText(v.value, `${path}.value`, EMBED_LIMITS.fieldValue),
  }
  if (v.inline !== undefined) {
    if (typeof v.inline !== 'boolean') throw new Error(`${path}.inline must be a boolean`)
    out.inline = v.inline
  }
  return out
}

function embed(v: unknown, path: string): APIEmbed {
  if (!isObject(v)) throw new Error(`${path} must be an object`)
  rejectUnknownKeys(v, EMBED_KEYS, path)
  const out: APIEmbed = {}
  if (v.title !== undefined) {
    const s = text(v.title, `${path}.title`, EMBED_LIMITS.title)
    if (s) out.title = s
  }
  if (v.description !== undefined) {
    const s = text(v.description, `${path}.description`, EMBED_LIMITS.description)
    if (s) out.description = s
  }
  if (v.url !== undefined) out.url = url(v.url, `${path}.url`)
  if (v.color !== undefined) out.color = color(v.color, `${path}.color`)
  if (v.timestamp !== undefined) out.timestamp = timestamp(v.timestamp, `${path}.timestamp`)
  if (v.fields !== undefined) {
    if (!Array.isArray(v.fields)) throw new Error(`${path}.fields must be an array`)
    if (v.fields.length > EMBED_LIMITS.fields) {
      throw new Error(`${path}.fields has ${v.fields.length} items (max ${EMBED_LIMITS.fields})`)
    }
    if (v.fields.length > 0) out.fields = v.fields.map((f, i) => field(f, `${path}.fields[${i}]`))
  }
  if (v.footer !== undefined) {
    if (!isObject(v.footer)) throw new Error(`${path}.footer must be an object with text`)
    rejectUnknownKeys(v.footer, FOOTER_KEYS, `${path}.footer`)
    out.footer = { text: requiredText(v.footer.text, `${path}.footer.text`, EMBED_LIMITS.footerText) }
  }
  if (!out.title && !out.description && !out.fields && !out.footer) {
    throw new Error(`${path} is empty (set at least one of title, description, fields, footer)`)
  }
  return out
}

/** 上限の 6000 文字に数えるもの（title・description・field.name・field.value・footer.text） */
export function embedLength(e: APIEmbed): number {
  let n = (e.title?.length ?? 0) + (e.description?.length ?? 0) + (e.footer?.text.length ?? 0)
  for (const f of e.fields ?? []) n += f.name.length + f.value.length
  return n
}

/**
 * 1 メッセージ分の Embed の配列を確かめ、送れる形（trim 済み、color は整数、timestamp は ISO 形式）にして返す。
 * 駄目なら、どこが駄目かを embeds[0].fields[2].value のような位置つきで書いたエラーを投げる。
 */
export function validateEmbeds(v: unknown, path = 'embeds'): APIEmbed[] {
  if (!Array.isArray(v)) throw new Error(`${path} must be an array of embed objects`)
  if (v.length > EMBED_LIMITS.perMessage) {
    throw new Error(`${path} has ${v.length} items (Discord allows max ${EMBED_LIMITS.perMessage} per message)`)
  }
  const out = v.map((e, i) => embed(e, `${path}[${i}]`))
  const total = out.reduce((n, e) => n + embedLength(e), 0)
  if (total > EMBED_LIMITS.total) {
    throw new Error(
      `${path} total is ${total} characters (max ${EMBED_LIMITS.total} across all embeds in a message, ` +
        'counting title, description, field names and values, and footer text)',
    )
  }
  return out
}
