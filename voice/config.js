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
    // DISCORD_BOT_STATE_DIR を上書きしても既定のモデル置き場が追随するように、STATE_DIR から組み立てる。
    model: join(STATE_DIR, 'models', 'ggml-large-v3-turbo-q5_0.bin'),
    vadModel: join(STATE_DIR, 'models', 'ggml-silero-v5.1.2.bin'),
    language: 'ja',
    extraArgs: [],
    // whisper-server の起動（ポートへの疎通）を待つ上限。モデル読み込みぶんの余裕を見てある。
    startTimeoutS: 60,
  },
  vad: {
    silenceMs: 700,
    minSpeechMs: 300,
    maxUtteranceS: 30,
  },
  voice: {
    // Ready への到達を待つ上限（1 回あたり）。タイムアウトしたら 1 回だけ再試行するので、
    // 合計の待ち時間はこの 2 倍（既定 8 * 2 = 16 秒）。channel 側の join タイムアウト（30 秒）に収める。
    readyTimeoutS: 8,
  },
  debug: {
    saveWav: false,
  },
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isFinitePositiveNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0
}

/**
 * whisper セクションもフィールドごとに検証する。1 つのフィールドが不正でも、
 * そのフィールドだけ既定値に戻して他は活かす。
 */
function validateWhisperSection(raw) {
  const out = { ...DEFAULTS.whisper }
  if (!isPlainObject(raw)) return out
  for (const key of /** @type {const} */ (['binary', 'model', 'vadModel', 'language'])) {
    if (!(key in raw)) continue
    if (isNonEmptyString(raw[key])) {
      out[key] = raw[key]
    } else {
      console.error(
        `[voice/config] whisper.${key} は空でない文字列である必要があります` +
          `（受け取った値: ${JSON.stringify(raw[key])}）。既定値 ${JSON.stringify(DEFAULTS.whisper[key])} を使います`,
      )
    }
  }
  for (const key of /** @type {const} */ (['port', 'startTimeoutS'])) {
    if (!(key in raw)) continue
    if (isFinitePositiveNumber(raw[key])) {
      out[key] = raw[key]
    } else {
      console.error(
        `[voice/config] whisper.${key} は有限の正の数値である必要があります` +
          `（受け取った値: ${JSON.stringify(raw[key])}）。既定値 ${DEFAULTS.whisper[key]} を使います`,
      )
    }
  }
  if ('extraArgs' in raw) {
    if (Array.isArray(raw.extraArgs)) {
      out.extraArgs = raw.extraArgs
    } else {
      console.error(
        `[voice/config] whisper.extraArgs は配列である必要があります（受け取った値: ${JSON.stringify(raw.extraArgs)}）。既定値を使います`,
      )
    }
  }
  return out
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

/** voice セクションもフィールドごとに検証する。 */
function validateVoiceSection(raw) {
  const out = { ...DEFAULTS.voice }
  if (!isPlainObject(raw)) return out
  if ('readyTimeoutS' in raw) {
    if (isFinitePositiveNumber(raw.readyTimeoutS)) {
      out.readyTimeoutS = raw.readyTimeoutS
    } else {
      console.error(
        `[voice/config] voice.readyTimeoutS は有限の正の数値である必要があります` +
          `（受け取った値: ${JSON.stringify(raw.readyTimeoutS)}）。既定値 ${DEFAULTS.voice.readyTimeoutS} を使います`,
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
    whisper: validateWhisperSection(raw.whisper),
    vad: validateVadSection(raw.vad),
    voice: validateVoiceSection(raw.voice),
    debug: validateDebugSection(raw.debug),
  }
  return cached
}

export function getStateDir() {
  return STATE_DIR
}

export const VOICE_CONFIG_PATH = CONFIG_PATH
