/**
 * voice プロセスの設定ファイル（~/.claude/discord-bot/voice.json）を読み込む小さなモジュール。
 *
 * #63（VAD の閾値）と #64（whisper-server の起動管理）の両方から使うので、
 * どちらかに寄せず独立したモジュールにしてある。雛形は Issue #61 のコメントにある。
 *
 * ファイルが無い・壊れている場合は既定値にフォールバックする（voice プロセスが
 * 設定ファイル 1 つの不備で起動できなくなるのを避けるため）。
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const STATE_DIR = process.env.DISCORD_BOT_STATE_DIR ?? join(homedir(), '.claude', 'discord-bot')
const CONFIG_PATH = join(STATE_DIR, 'voice.json')

const DEFAULTS = {
  whisper: {
    binary: 'whisper-server',
    port: 8178,
    model: '',
    vadModel: '',
    language: 'ja',
    extraArgs: [],
  },
  vad: {
    silenceMs: 700,
    minSpeechMs: 300,
    maxUtteranceS: 30,
  },
  debug: {
    saveWav: false,
  },
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** セクション単位（whisper）で浅くマージする。未知のキーが増えても壊れないように。 */
function mergeSection(base, override) {
  if (!isPlainObject(override)) return { ...base }
  return { ...base, ...override }
}

function isFinitePositiveNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

/**
 * vad セクションはフィールドごとに検証する。1 つのフィールドが不正でも、
 * そのフィールドだけ既定値に戻して他は活かす（vad セクションまるごと既定値に
 * 戻すと、他の正しい設定まで無視されてしまうため）。
 */
function validateVadSection(raw) {
  const out = { ...DEFAULTS.vad }
  if (!isPlainObject(raw)) return out
  for (const key of /** @type {const} */ (['silenceMs', 'minSpeechMs', 'maxUtteranceS'])) {
    if (!(key in raw)) continue
    if (isFinitePositiveNumber(raw[key])) {
      out[key] = raw[key]
    } else {
      console.error(
        `[voice/config] vad.${key} は有限の正の数値である必要があります` +
          `（受け取った値: ${JSON.stringify(raw[key])}）。既定値 ${DEFAULTS.vad[key]} を使います`,
      )
    }
  }
  return out
}

/** debug セクションも同様にフィールドごとに検証する。 */
function validateDebugSection(raw) {
  const out = { ...DEFAULTS.debug }
  if (!isPlainObject(raw)) return out
  if ('saveWav' in raw) {
    if (typeof raw.saveWav === 'boolean') {
      out.saveWav = raw.saveWav
    } else {
      console.error(
        `[voice/config] debug.saveWav は boolean である必要があります` +
          `（受け取った値: ${JSON.stringify(raw.saveWav)}）。既定値 ${DEFAULTS.debug.saveWav} を使います`,
      )
    }
  }
  return out
}

let cached = null

/**
 * @param {{ forceReload?: boolean }} [opts] テストや設定変更後の再読み込み用。通常は省略してよい（キャッシュされる）。
 */
export function loadVoiceConfig(opts = {}) {
  if (cached && !opts.forceReload) return cached

  let raw = {}
  try {
    raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'))
  } catch (err) {
    if (err?.code !== 'ENOENT') {
      console.error(
        `[voice/config] ${CONFIG_PATH} を読み込めなかったので既定値を使います: ${err?.message ?? err}`,
      )
    }
  }
  if (!isPlainObject(raw)) raw = {}

  cached = {
    whisper: mergeSection(DEFAULTS.whisper, raw.whisper),
    vad: validateVadSection(raw.vad),
    debug: validateDebugSection(raw.debug),
  }
  return cached
}

export function getStateDir() {
  return STATE_DIR
}

export const VOICE_CONFIG_PATH = CONFIG_PATH
