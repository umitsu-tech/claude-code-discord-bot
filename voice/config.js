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

/** セクション単位（whisper / vad / debug）で浅くマージする。未知のキーが増えても壊れないように。 */
function mergeSection(base, override) {
  if (!isPlainObject(override)) return { ...base }
  return { ...base, ...override }
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
    vad: mergeSection(DEFAULTS.vad, raw.vad),
    debug: mergeSection(DEFAULTS.debug, raw.debug),
  }
  return cached
}

export function getStateDir() {
  return STATE_DIR
}

export const VOICE_CONFIG_PATH = CONFIG_PATH
