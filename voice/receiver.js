/**
 * voice/receiver.js — 発話区間の検出と WAV への切り出し（Issue #63）
 *
 * 役割は 2 段に分けてある。
 *
 *   UtteranceSegmenter  Discord に依存しない部品。48kHz ステレオ PCM のチャンク列を受け取り、
 *                        Silero VAD（avr-vad）で発話区間を判定して `utterance` / `discarded` を発火する。
 *                        Discord に繋がずに単体でテストできるので、dev/verify-vad.js から
 *                        録音済み WAV に対しても同じロジックで検証できる。
 *
 *   VoiceReceiver        Discord 側の配線。`connection.receiver.speaking` の `start` をトリガーに
 *                        対象話者（joinedAs.userIds に含まれる人だけ）の Opus ストリームを
 *                        EndBehaviorType.Manual で開き、prism-media でデコードした PCM を
 *                        UtteranceSegmenter に流し込む。
 *
 * 終端判定の設計判断（Issue #61 のコメント、discordjs/discord.js#8105 を踏まえたもの）
 *
 * - EndBehaviorType.Manual を使うのは、AfterSilence が発話の途中でストリームを閉じてしまう
 *   不具合を避けるため。購読は VAD 側が「本当に喋り終えた」と判定するまで閉じない
 * - 無音の判定は 2 種類の独立した仕組みで行う。
 *   (a) 音声データが実際に届いているが VAD が「発話でない」と判定し続ける区間
 *       → Silero VAD のフレーム単位の判定（16kHz・512 サンプル/フレーム）で追う
 *   (b) 相手のクライアントが speaking=false を送って音声データそのものが届かなくなる区間
 *       → データが来ない実時間（壁時計）を watchdog タイマーで追う。VAD のフレーム処理は
 *          データが届いたときにしか進まないので、(a) だけでは検出できない
 *   どちらの場合も `silenceMs` 経過したら 1 発話として確定する
 * - `speaking` の `end` は使わない。Discord の speaking はノイズゲートに依存する自己申告で、
 *   日本語の間投詞程度の間（0.5 秒前後）で on/off が揺れることがある。Manual 購読はその間も
 *   閉じずに開いたままにしておき、続きが同じストリームにそのまま流れてくることで対応する
 */
import { EventEmitter } from 'node:events'
import prism from 'prism-media'
import { EndBehaviorType } from '@discordjs/voice'
import { RealTimeVAD } from 'avr-vad'

// Discord 音声の固定フォーマット（変更不可）
export const SAMPLE_RATE = 48000
export const CHANNELS = 2
export const BITS = 16
const BYTES_PER_FRAME = (CHANNELS * BITS) / 8 // 1 サンプル（左右 2ch 分）あたりのバイト数

// avr-vad（Silero v5）の推奨フレームサイズ。16kHz で 512 サンプル = 32ms。
// 48kHz→16kHz の変換は avr-vad 内蔵の Resampler に任せる（sampleRate: 48000 を渡すと有効になる）。
const VAD_FRAME_SAMPLES = 512
const VAD_FRAME_MS = (VAD_FRAME_SAMPLES / 16000) * 1000
const VAD_POSITIVE_THRESHOLD = 0.5

/**
 * WAV ヘッダ（44 バイト）を組み立てる。実験スクリプト（experiments/voice-receive/record.js）と同じ形式。
 */
function wavHeader(dataLength) {
  const byteRate = SAMPLE_RATE * BYTES_PER_FRAME
  const buf = Buffer.alloc(44)
  buf.write('RIFF', 0)
  buf.writeUInt32LE(36 + dataLength, 4)
  buf.write('WAVE', 8)
  buf.write('fmt ', 12)
  buf.writeUInt32LE(16, 16)
  buf.writeUInt16LE(1, 20)
  buf.writeUInt16LE(CHANNELS, 22)
  buf.writeUInt32LE(SAMPLE_RATE, 24)
  buf.writeUInt32LE(byteRate, 28)
  buf.writeUInt16LE(BYTES_PER_FRAME, 32)
  buf.writeUInt16LE(BITS, 34)
  buf.write('data', 36)
  buf.writeUInt32LE(dataLength, 40)
  return buf
}

export function buildWav(pcm) {
  return Buffer.concat([wavHeader(pcm.length), pcm])
}

/**
 * 48kHz ステレオ 16bit PCM → 判定用のモノラル Float32（-1..1）。
 * レート変換自体は avr-vad 内蔵の Resampler が行うので、ここではチャンネルを1本に落とすだけでよい。
 */
function toMonoFloat32(pcm) {
  const frames = Math.floor(pcm.length / BYTES_PER_FRAME)
  const out = new Float32Array(frames)
  for (let i = 0; i < frames; i++) {
    const offset = i * BYTES_PER_FRAME
    const l = pcm.readInt16LE(offset)
    const r = pcm.readInt16LE(offset + 2)
    out[i] = (l + r) / 2 / 32768
  }
  return out
}

/**
 * 1 話者ぶんの発話区間検出。Discord には一切依存しない。
 *
 * イベント
 *   utterance({ wav, startedAt, endedAt, durationMs })  発話 1 件が確定した
 *   discarded({ reason, speechMs, bytes })               minSpeechMs 未満などで捨てた
 */
export class UtteranceSegmenter extends EventEmitter {
  /** @param {{ silenceMs?: number, minSpeechMs?: number, maxUtteranceS?: number }} [config] */
  constructor(config = {}) {
    super()
    this.silenceMs = config.silenceMs ?? 700
    this.minSpeechMs = config.minSpeechMs ?? 300
    this.maxUtteranceMs = (config.maxUtteranceS ?? 30) * 1000

    this._resetUtterance()
    this._vadReady = null
    // vad.processAudio は内部で Silero の RNN 状態（隠れ状態テンソル）を読み書きするので、
    // 複数のチャンクを並行に投入すると状態が壊れる。この Promise チェーンで 1 本ずつ順番に処理する。
    this._vadQueue = Promise.resolve()
    this._silenceTimer = null
    this._maxTimer = null
    this.destroyed = false
  }

  _resetUtterance() {
    this._chunks = []
    this._speechMs = 0
    this._startedAt = null
    this._lastSpeechAt = null
  }

  async _ensureVad() {
    if (!this._vadReady) {
      this._vadReady = RealTimeVAD.new({
        model: 'v5',
        sampleRate: SAMPLE_RATE,
        frameSamples: VAD_FRAME_SAMPLES,
        // SpeechStart/SpeechEnd の内蔵ステートマシンは使わず、フレームごとの確率だけをもらう。
        // 無音判定は上の watchdog（壁時計ベース）と組み合わせて自前で行うため。
        onFrameProcessed: probs => this._onFrame(probs),
      }).then(vad => {
        vad.start()
        return vad
      })
    }
    return this._vadReady
  }

  _onFrame(probs) {
    if (this.destroyed) return
    if (probs.isSpeech < VAD_POSITIVE_THRESHOLD) return
    const now = Date.now()
    if (this._startedAt === null) this._startedAt = now - VAD_FRAME_MS
    this._lastSpeechAt = now
    this._speechMs += VAD_FRAME_MS
  }

  _armSilenceTimer() {
    clearTimeout(this._silenceTimer)
    this._silenceTimer = setTimeout(() => this._finalize('silence'), this.silenceMs)
    this._silenceTimer.unref?.()
  }

  _armMaxTimer() {
    if (this._maxTimer) return
    this._maxTimer = setTimeout(() => this._finalize('max'), this.maxUtteranceMs)
    this._maxTimer.unref?.()
  }

  /** 48kHz ステレオ PCM のチャンクを 1 個投入する。呼び出しが重なっても VAD への投入順は保つ。 */
  push(pcmChunk) {
    if (this.destroyed) return Promise.resolve()
    this._chunks.push(pcmChunk)
    // データが届いた = まだ喋っている（か、少なくとも無音ではない）ので watchdog を延長する。
    this._armSilenceTimer()
    this._armMaxTimer()
    const result = this._vadQueue.then(() => this._runVad(pcmChunk))
    // キュー自体は失敗しても reject させない（1 回の失敗で以降のチャンクが
    // 全部素通りする＝ VAD が止まったまま気づけなくなるのを防ぐため）。
    // 呼び出し元に失敗を伝えるのは `result`（push の戻り値）の役目。
    this._vadQueue = result.catch(() => {})
    return result
  }

  async _runVad(pcmChunk) {
    if (this.destroyed) return
    const vad = await this._ensureVad()
    if (this.destroyed) return
    await vad.processAudio(toMonoFloat32(pcmChunk))
  }

  _finalize(reason) {
    if (this.destroyed) return
    clearTimeout(this._silenceTimer)
    clearTimeout(this._maxTimer)
    this._silenceTimer = null
    this._maxTimer = null

    const pcm = Buffer.concat(this._chunks)
    const speechMs = this._speechMs
    const startedAt = this._startedAt
    const lastSpeechAt = this._lastSpeechAt
    this._resetUtterance()

    if (startedAt !== null && speechMs >= this.minSpeechMs) {
      const durationMs = (pcm.length / BYTES_PER_FRAME / SAMPLE_RATE) * 1000
      this.emit('utterance', {
        wav: buildWav(pcm),
        startedAt: new Date(startedAt),
        endedAt: new Date(lastSpeechAt ?? startedAt),
        durationMs,
      })
    } else if (pcm.length > 0) {
      this.emit('discarded', { reason, speechMs, bytes: pcm.length })
    }

    if (reason === 'max') {
      // 話し続けている途中の強制区切り。ストリームは閉じずに、続きを次の発話として受け続ける。
      this._armSilenceTimer()
      this._armMaxTimer()
    } else {
      // silence（無音確定）または destroy。呼び出し側（VoiceReceiver）に購読を閉じてよいと伝える。
      this.emit('idle')
    }
  }

  /** leave / idle 時、または話者の購読を閉じるときに呼ぶ。バッファに残っている発話は確定させてから片付ける。 */
  async destroy() {
    if (this.destroyed) return
    this.destroyed = true
    clearTimeout(this._silenceTimer)
    clearTimeout(this._maxTimer)
    if (this._startedAt !== null && this._speechMs >= this.minSpeechMs) {
      // 無音を待たずに畳むが、確定条件を満たしている発話は捨てずに拾っておく。
      const pcm = Buffer.concat(this._chunks)
      const durationMs = (pcm.length / BYTES_PER_FRAME / SAMPLE_RATE) * 1000
      this.emit('utterance', {
        wav: buildWav(pcm),
        startedAt: new Date(this._startedAt),
        endedAt: new Date(this._lastSpeechAt ?? this._startedAt),
        durationMs,
      })
    }
    this._resetUtterance()
    if (this._vadReady) {
      try {
        const vad = await this._vadReady
        await vad.destroy()
      } catch {
        // 後片付けなので失敗しても無視してよい
      }
    }
  }
}

/**
 * Discord 側の配線。VoiceConnection と join 時の情報を受け取り、対象話者だけを購読して
 * UtteranceSegmenter に繋ぐ。
 *
 * イベント
 *   utterance({ userId, wav, startedAt, endedAt, durationMs })
 *   error(err)
 */
export class VoiceReceiver extends EventEmitter {
  /**
   * @param {import('@discordjs/voice').VoiceConnection} connection
   * @param {{ userIds: string[] }} joinedAs
   * @param {{ silenceMs?: number, minSpeechMs?: number, maxUtteranceS?: number }} [vadConfig]
   */
  constructor(connection, joinedAs, vadConfig = {}) {
    super()
    this.connection = connection
    this.userIds = new Set(joinedAs.userIds ?? [])
    this.vadConfig = vadConfig
    /** @type {Map<string, { opusStream: import('@discordjs/voice').AudioReceiveStream, decoder: import('prism-media').opus.Decoder, segmenter: UtteranceSegmenter }>} */
    this.speakers = new Map()
    this.destroyed = false

    this._onSpeakingStart = userId => this._handleSpeakingStart(userId)
    connection.receiver.speaking.on('start', this._onSpeakingStart)
  }

  _handleSpeakingStart(userId) {
    if (this.destroyed) return
    if (!this.userIds.has(userId)) return // 対象外の話者（Bot 自身や join に含まれない人）
    if (this.speakers.has(userId)) return // 既に購読中。短い間を挟んで speaking が再度立っただけ

    let opusStream
    try {
      opusStream = this.connection.receiver.subscribe(userId, {
        end: { behavior: EndBehaviorType.Manual },
      })
    } catch (err) {
      this.emit('error', err)
      return
    }
    const decoder = new prism.opus.Decoder({ rate: SAMPLE_RATE, channels: CHANNELS, frameSize: 960 })
    const segmenter = new UtteranceSegmenter(this.vadConfig)

    this.speakers.set(userId, { opusStream, decoder, segmenter })

    segmenter.on('utterance', utt => this.emit('utterance', { userId, ...utt }))
    segmenter.on('error', err => this.emit('error', err))
    segmenter.once('idle', () => this._closeSpeaker(userId))

    opusStream.on('error', err => this.emit('error', err))
    decoder.on('error', err => this.emit('error', err))
    decoder.on('data', chunk => {
      segmenter.push(chunk).catch(err => this.emit('error', err))
    })
    opusStream.pipe(decoder)
  }

  _closeSpeaker(userId) {
    const entry = this.speakers.get(userId)
    if (!entry) return
    this.speakers.delete(userId)
    this._teardown(entry).catch(err => this.emit('error', err))
  }

  async _teardown(entry) {
    entry.opusStream.destroy()
    entry.decoder.destroy()
    await entry.segmenter.destroy()
  }

  /** leave / idle 時に、購読中の話者を全部破棄する。バッファに残っている発話は確定させてから閉じる。 */
  async destroy() {
    if (this.destroyed) return
    this.destroyed = true
    this.connection.receiver.speaking.off('start', this._onSpeakingStart)
    const entries = [...this.speakers.values()]
    this.speakers.clear()
    await Promise.all(entries.map(entry => this._teardown(entry)))
  }
}
