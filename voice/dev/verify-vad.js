#!/usr/bin/env node
/**
 * 開発用: 録音済みの WAV を UtteranceSegmenter（本実装と同じ VAD ロジック）に通して、
 * 区間の数と長さを表示する。
 *
 * fake-gateway.js 越しの実機確認だけでは「本物の発話とほぼ無音のファイルを
 * ちゃんと切り分けられているか」を毎回耳で確認するしかないので、
 * experiments/voice-receive/ の録音済み WAV（48kHz ステレオ）に対して機械的に検証できるようにしてある。
 *
 * 使い方
 *   node dev/verify-vad.js <WAVファイルまたはディレクトリ> [...]
 *
 * WAV は 48kHz・16bit・ステレオ（Discord が受信で使う形式）を想定している。
 * それ以外のフォーマットのファイルは弾く。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { extname, join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { UtteranceSegmenter, SAMPLE_RATE, CHANNELS, BITS } from '../receiver.js'
import { loadVoiceConfig } from '../config.js'

// 1 回に投入する PCM チャンクの大きさ。Discord から届く Opus 1 フレーム分（20ms）に合わせてある。
// 大きすぎるチャンクで一気に投入すると、実際の受信より粒度が粗くなり watchdog の挙動が検証しにくくなる。
const CHUNK_MS = 20
const CHUNK_BYTES = (SAMPLE_RATE * CHANNELS * BITS) / 8 / (1000 / CHUNK_MS)

/** 44 バイトの RIFF/WAVE ヘッダを読み、フォーマットを検証したうえで PCM 本体を返す。 */
function readWavPcm(filePath) {
  const buf = readFileSync(filePath)
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('RIFF/WAVE ヘッダがありません')
  }
  // fmt チャンクは先頭にある前提（record.js が書き出す WAV も同じ構造）。
  const channels = buf.readUInt16LE(22)
  const sampleRate = buf.readUInt32LE(24)
  const bits = buf.readUInt16LE(34)
  if (channels !== CHANNELS || sampleRate !== SAMPLE_RATE || bits !== BITS) {
    throw new Error(
      `想定外のフォーマットです（channels=${channels} sampleRate=${sampleRate} bits=${bits}。` +
        `期待値は channels=${CHANNELS} sampleRate=${SAMPLE_RATE} bits=${BITS}）`,
    )
  }
  const dataLength = buf.readUInt32LE(40)
  return buf.subarray(44, 44 + dataLength)
}

function collectWavFiles(paths) {
  const files = []
  for (const p of paths) {
    const abs = resolve(p)
    const stat = statSync(abs)
    if (stat.isDirectory()) {
      for (const name of readdirSync(abs).sort()) {
        if (extname(name).toLowerCase() === '.wav') files.push(join(abs, name))
      }
    } else {
      files.push(abs)
    }
  }
  return files
}

async function verifyFile(filePath, vadConfig) {
  const pcm = readWavPcm(filePath)
  const segmenter = new UtteranceSegmenter(vadConfig)

  const segments = []
  const discards = []
  segmenter.on('utterance', utt => segments.push(utt))
  segmenter.on('discarded', d => discards.push(d))

  // silenceMs の watchdog は壁時計ベース（setTimeout）で動くので、ファイルの中身を
  // 実時間に近いペースで投入する。一気に流し込むと 700ms の無音判定が実時間としては
  // 一瞬で通り過ぎてしまい、本番と違う挙動の検証になってしまうため。
  for (let offset = 0; offset < pcm.length; offset += CHUNK_BYTES) {
    await segmenter.push(pcm.subarray(offset, Math.min(offset + CHUNK_BYTES, pcm.length)))
    await sleep(CHUNK_MS)
  }
  // ファイル終端で確定条件を満たしている発話が残っていれば、無音を待たずに拾う
  // （末尾に十分な無音が録れていない録音でも取りこぼさないようにするため）。
  await segmenter.destroy()

  return { segments, discards, totalBytes: pcm.length }
}

async function main() {
  const args = process.argv.slice(2)
  if (args.length === 0) {
    console.error('使い方: node dev/verify-vad.js <WAVファイルまたはディレクトリ> [...]')
    process.exit(1)
  }
  const files = collectWavFiles(args)
  if (files.length === 0) {
    console.error('WAV ファイルが見つかりませんでした')
    process.exit(1)
  }

  const { vad } = loadVoiceConfig()
  console.log(`vad 設定: silenceMs=${vad.silenceMs} minSpeechMs=${vad.minSpeechMs} maxUtteranceS=${vad.maxUtteranceS}`)
  console.log('')

  let totalSegments = 0
  for (const file of files) {
    const fileSeconds = statSync(file).size / (SAMPLE_RATE * CHANNELS * (BITS / 8))
    try {
      const { segments, discards } = await verifyFile(file, vad)
      totalSegments += segments.length
      console.log(`${file}（元ファイル ${fileSeconds.toFixed(1)}秒）`)
      if (segments.length === 0) {
        console.log('  区間なし')
      } else {
        segments.forEach((seg, i) => {
          console.log(`  区間 ${i + 1}: ${(seg.durationMs / 1000).toFixed(2)}秒`)
        })
      }
      for (const d of discards) {
        console.log(`  破棄: reason=${d.reason} speechMs=${d.speechMs.toFixed(0)} bytes=${d.bytes}`)
      }
    } catch (err) {
      console.log(`${file}: 読み込みに失敗しました（${err?.message ?? err}）`)
    }
    console.log('')
  }

  console.log(`合計 ${files.length} ファイル中、区間 ${totalSegments} 個を検出しました`)
}

main().catch(err => {
  console.error('検証中にエラーが発生しました:', err?.stack ?? err)
  process.exit(1)
})
