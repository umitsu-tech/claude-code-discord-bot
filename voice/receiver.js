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
 *   不具合を避けるため。購読は「相手からの音声データそのものが止まった」と確認できるまで閉じない
 * - 無音・区切りの判定は 3 種類ある（`_finalizeNow` の reason）。
 *   'silence-vad'     データは届き続けているが、Silero VAD が `silenceMs` 分ずっと
 *                      「発話でない」と判定し続けた（ノイズゲート無効・PTT 押しっぱなし等で
 *                      無音のパケットが送られ続けるケースに対応する）
 *   'silence-nodata'  相手のクライアントが送信そのものを止め、音声データが `silenceMs` の間
 *                      1 バイトも届かない（壁時計ベースの watchdog タイマーで検出する。
 *                      VAD のフレーム処理はデータが届いたときにしか進まないので、
 *                      'silence-vad' の仕組みだけではこのケースを検出できない）
 *   'max'             `maxUtteranceS` を超えた強制区切り
 *   購読を閉じてよい（`idle` を発火する）のは 'silence-nodata' と destroy() のときだけ。
 *   'silence-vad' と 'max' はデータがまだ来る可能性があるので、バッファと VAD の内部状態だけ
 *   リセットして同じ購読のまま次の発話を受け続ける
 * - `speaking` の `end` は使わない。Discord の speaking はノイズゲートに依存する自己申告で、
 *   日本語の間投詞程度の間（0.5 秒前後）で on/off が揺れることがある。Manual 購読はその間も
 *   閉じずに開いたままにしておき、続きが同じストリームにそのまま流れてくることで対応する
 *
 * チャンクの投入順について
 *
 * - avr-vad の Silero v5 モデルは RNN の隠れ状態をフレームごとに読み書きするので、
 *   投入順が入れ替わったり、確定処理（finalize）が投入中のチャンクの判定結果を
 *   横取りしたりすると壊れる。`_queue`（チャンク投入タスクと確定タスクを両方積む単一の FIFO）と
 *   `_drainLoop` で全部を直列に処理し、確定処理も「それまでに投入されたチャンクの判定が
 *   終わったあと」にしか走らないようにしてある
 * - VAD の処理がリアルタイムより遅れた場合に備えて、チャンク投入タスクの滞留数に上限を設け、
 *   超えたら古いものから捨てる（無制限にメモリを食い続けないようにするため）
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

// VAD 処理待ちのチャンク数がこれを超えたら、古いものから捨てて警告を出す。
const MAX_QUEUED_CHUNKS = 200

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
 *   idle()                                                データが止まった。購読を閉じてよい
 *   warning(message)                                      バックプレッシャーでチャンクを捨てた等
 *   error(err)                                            VAD の推論などで例外が起きた
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
    this._vadInstance = null
    // チャンク投入タスクと確定（finalize）タスクを両方積む単一の FIFO。_drainLoop が1本ずつ順番に処理する。
    this._queue = []
    this._draining = false
    this._drainPromise = null
    this._noDataTimer = null
    this._maxTimer = null
    this.destroyed = false
  }

  _resetUtterance() {
    this._chunks = []
    this._speechMs = 0
    this._silentStreakMs = 0
    this._startedAt = null
    this._lastSpeechAt = null
  }

  async _ensureVad() {
    if (!this._vadReady) {
      this._vadReady = RealTimeVAD.new({
        model: 'v5',
        sampleRate: SAMPLE_RATE,
        frameSamples: VAD_FRAME_SAMPLES,
        // SpeechStart/SpeechEnd の内蔵ステートマシン（フレーム数ベース）は使わず、
        // フレームごとの確率だけをもらって ms 単位の自前の状態機械で判定する。
        onFrameProcessed: probs => this._onFrame(probs),
      }).then(vad => {
        vad.start()
        this._vadInstance = vad
        return vad
      })
    }
    return this._vadReady
  }

  _onFrame(probs) {
    const isSpeech = probs.isSpeech >= VAD_POSITIVE_THRESHOLD
    const now = Date.now()
    if (isSpeech) {
      if (this._startedAt === null) this._startedAt = now - VAD_FRAME_MS
      this._lastSpeechAt = now
      this._speechMs += VAD_FRAME_MS
      this._silentStreakMs = 0
      return
    }
    // 発話が一度も無いまま（＝話し始める前の物音など）でも数える。ノイズゲート無効・PTT
    // 押しっぱなしのように、無音のパケットが延々と届き続けるケースで maxUtteranceS まで
    // 待たせないため。実際に発話が始まっていれば minSpeechMs 判定で自然に捨てられる。
    this._silentStreakMs += VAD_FRAME_MS
    if (this._silentStreakMs >= this.silenceMs) {
      this._silentStreakMs = 0
      // データ自体はまだ届いている可能性があるので、購読は閉じない（'max' と同じ扱い）。
      this._enqueueFinalize('silence-vad')
    }
  }

  /** データが届かない実時間を追う watchdog。push のたびに延長する。 */
  _armNoDataTimer() {
    if (this.destroyed) return
    clearTimeout(this._noDataTimer)
    this._noDataTimer = setTimeout(() => {
      if (this.destroyed) return
      this._enqueueFinalize('silence-nodata')
    }, this.silenceMs)
    this._noDataTimer.unref?.()
  }

  _armMaxTimer() {
    if (this.destroyed || this._maxTimer) return
    this._maxTimer = setTimeout(() => {
      if (this.destroyed) return
      this._enqueueFinalize('max')
    }, this.maxUtteranceMs)
    this._maxTimer.unref?.()
  }

  /** 48kHz ステレオ PCM のチャンクを 1 個投入する。呼び出しが重なっても VAD への投入順は保つ。 */
  push(pcmChunk) {
    if (this.destroyed) return Promise.resolve()
    this._chunks.push(pcmChunk)
    // データが届いた = まだ喋っている（か、少なくとも無音ではない）ので watchdog を延長する。
    this._armNoDataTimer()
    this._armMaxTimer()
    return this._enqueueChunk(pcmChunk)
  }

  _enqueueChunk(pcmChunk) {
    const pendingChunks = this._queue.filter(task => task.type === 'chunk').length
    if (pendingChunks >= MAX_QUEUED_CHUNKS) {
      const idx = this._queue.findIndex(task => task.type === 'chunk')
      if (idx !== -1) {
        const [dropped] = this._queue.splice(idx, 1)
        this.emit(
          'warning',
          `VAD の処理待ちチャンクが上限（${MAX_QUEUED_CHUNKS}）を超えたので、古いチャンクを1個破棄しました`,
        )
        dropped.resolve?.()
      }
    }
    return new Promise(resolve => {
      this._queue.push({ type: 'chunk', pcm: pcmChunk, resolve })
      this._drain()
    })
  }

  /**
   * 確定処理をキューの末尾に積む。`_onFrame`（VAD のコールバック内）とタイマーの両方から
   * 呼ばれる fire-and-forget な経路があるので、このメソッド自体は reject しない
   * （失敗は `_drainLoop` が 'error' イベントとして報告する）。
   */
  _enqueueFinalize(reason) {
    return new Promise(resolve => {
      this._queue.push({ type: 'finalize', reason, resolve })
      this._drain()
    })
  }

  _drain() {
    if (this._draining) return
    this._draining = true
    this._drainPromise = this._drainLoop().finally(() => {
      this._draining = false
    })
  }

  async _drainLoop() {
    while (this._queue.length > 0) {
      const task = this._queue.shift()
      try {
        if (task.type === 'chunk') {
          await this._runVad(task.pcm)
        } else {
          this._finalizeNow(task.reason)
        }
      } catch (err) {
        this.emit('error', err)
      }
      // 成功・失敗どちらでも呼び出し元を待たせたままにしない（reject は使わない。
      // push()/_enqueueFinalize() の呼び出し元には 'error' イベントで別途伝える）。
      task.resolve?.()
    }
  }

  async _runVad(pcmChunk) {
    const vad = await this._ensureVad()
    await vad.processAudio(toMonoFloat32(pcmChunk))
  }

  _finalizeNow(reason) {
    clearTimeout(this._noDataTimer)
    clearTimeout(this._maxTimer)
    this._noDataTimer = null
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

    // avr-vad（FrameProcessor）は speaking 中に処理済みフレームを内部の audioBuffer に
    // 貯め続ける。区切りのたびに pause→start で解放し、RNN の隠れ状態もリセットしておく
    // （そのまま使い回すと、長い通話で audioBuffer が際限なく育ってしまう）。
    if (this._vadInstance && reason !== 'destroy') {
      this._vadInstance.pause()
      this._vadInstance.start()
    }

    if (reason === 'silence-nodata') {
      // データそのものが届かなくなった＝話者が本当に喋り終えた。購読を閉じてよい。
      this.emit('idle')
    } else if (reason !== 'destroy' && !this.destroyed) {
      // 'max' / 'silence-vad'。データはまだ来る可能性があるので、購読は開いたまま
      // 次の発話として受け続ける。
      this._armNoDataTimer()
      this._armMaxTimer()
    }
  }

  /** leave / idle 時、または話者の購読を閉じるときに呼ぶ。バッファに残っている発話は確定させてから片付ける。 */
  async destroy() {
    if (this.destroyed) return
    this.destroyed = true
    clearTimeout(this._noDataTimer)
    clearTimeout(this._maxTimer)
    this._noDataTimer = null
    this._maxTimer = null

    // キューに残っている処理（投入済みだが未処理のチャンク）を先に終わらせてから確定させる。
    // 先に状態をリセットしてしまうと、まだ処理中だったチャンクの判定結果が
    // リセット後の状態に紛れ込む（レビュー指摘）。
    await this._enqueueFinalize('destroy')
    this._queue.length = 0

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
 *   warning(message)
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

    // _closeSpeaker は Map から消えていれば何もしないので、同じ話者に対して
    // 複数の経路（VAD の idle、ストリームの error/close）から呼ばれても安全。
    const closeThis = () => this._closeSpeaker(userId)

    segmenter.on('utterance', utt => this.emit('utterance', { userId, ...utt }))
    segmenter.on('warning', message => this.emit('warning', `user=${userId}: ${message}`))
    segmenter.on('error', err => this.emit('error', err))
    segmenter.once('idle', closeThis)

    // @discordjs/voice はデコード失敗時などに stream.destroy(error) する。ここで閉じておかないと
    // speakers に古いエントリが残り続け、その話者は次に喋っても speakers.has で弾かれて
    // 二度と録音されなくなる。
    opusStream.on('error', err => {
      this.emit('error', err)
      closeThis()
    })
    opusStream.on('close', closeThis)
    decoder.on('error', err => {
      this.emit('error', err)
      closeThis()
    })
    decoder.on('close', closeThis)
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
