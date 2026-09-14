/**
 * voice-command.ts — /voice join・leave・status（#66）の処理本体。
 * server.ts の handleSlashCommand() が action === 'voice' のときにここへ渡す。認可
 * （allowFrom・受信設定）はすでに server.ts 側で済んでいる前提で、Discord 側の状態
 * （呼び出し元がいるボイスチャンネル、チャンネル名の解決）と voice-control.ts の呼び出しだけを行う。
 *
 * join/leave/status はいずれも voice プロセスとの往復（最大で join が 30 秒、他が 20 秒）が
 * あるので、3 秒の応答期限に間に合わせるため deferReply → editReply で返す。各ハンドラは
 * 本文（content）を決めてから editReply() を 1 回だけ呼ぶ構造にしている。try に成功時の
 * editReply まで含めてしまうと、操作自体は成功したのに editReply の送信だけが失敗したとき
 * catch がもう一度 editReply を呼んで「失敗した」と誤報してしまうため。
 *
 * voice-control.ts が投げる例外の message には voice.log の絶対パスなど内部情報が入ることが
 * あるので、そのまま Discord には出さない。stderr にログを残し、Discord には固定の利用者向け
 * 文言（「詳しくは voice.log を見てね」）だけを返す。
 *
 * leave() は voice 側の仕様上、未入室でも「既に idle」のログを出すだけで成功応答を返す
 * （#62 の handleLeave 参照）。「入室していません」を返し分けるため、leave() を呼ぶ前に
 * status() で現在の状態を見てから判断する。また voice 側は join/leave を同じ列で直列化して
 * いるので、state が 'joining'（Ready 待ち中）のときに leave() を呼ぶと、Ready 待ちの残り
 * 時間（最長 30 秒）ぶん leave() 自体がブロックされたあげく退室してしまう。joining の間は
 * leave() を呼ばず、少し待ってから打ち直すよう案内する（進行中の join を割り込んで止める
 * 対応は voice 側の話なので、ここではやらない）。
 *
 * status/leave は、voice プロセスが一度も起動していない（ソケット未接続）ときは isConnected() で
 * 弾いて即答する。繋ぎに行くと voice の起動待ちで REQUEST_TIMEOUT_MS（20 秒）掛かってしまうため
 * （voice の起動は join() だけが担う。status/leave では起動しない）。
 */
import { MessageFlags, type ChatInputCommandInteraction } from 'discord.js'
import { isConnected, join, leave, status } from './voice-control'

const EPHEMERAL = { flags: MessageFlags.Ephemeral } as const
const VOICE_UNAVAILABLE_MESSAGE = 'voice プロセスが応答しません。詳しくは voice.log を見てね。'

function log(msg: string): void {
  process.stderr.write(`discord channel: voice-command: ${msg}\n`)
}

/** interaction.guild.channels 経由で名前を引く。取れなければ ID をそのまま出す */
async function resolveChannelName(interaction: ChatInputCommandInteraction, channelId: string): Promise<string> {
  try {
    const ch = await interaction.client.channels.fetch(channelId)
    return ch && 'name' in ch && ch.name ? ch.name : channelId
  } catch {
    return channelId
  }
}

/** deferReply 済みの interaction へ 1 回だけ editReply する。editReply 自体の失敗はログに残すだけ */
async function reply(interaction: ChatInputCommandInteraction, content: string): Promise<void> {
  await interaction.editReply({ content }).catch(e => log(`editReply に失敗したよ: ${e}`))
}

async function handleJoin(interaction: ChatInputCommandInteraction, allowFrom: string[]): Promise<void> {
  const guild = interaction.guild
  if (!guild) {
    await interaction.reply({ content: 'DM では使えないよ。ボイスチャンネルのあるサーバーで打ってね。', ...EPHEMERAL }).catch(() => {})
    return
  }
  // GuildMember#voice は guild.voiceStates.cache から引く getter なので、guild.members.fetch() で
  // member を取り直しても voice state 自体は同じキャッシュ由来で変わらない（「取り直し」になっていない）。
  // 素直に voiceStates キャッシュを見る。interaction.member が GuildMember ならそちらの getter でも
  // 結局同じキャッシュを見るだけだが、念のためのフォールバックとして残す
  const member = interaction.member
  const channel =
    guild.voiceStates.cache.get(interaction.user.id)?.channel ?? (member && 'voice' in member ? member.voice.channel : null)
  if (!channel) {
    await interaction.reply({ content: '先にボイスチャンネルに入ってください。', ...EPHEMERAL }).catch(() => {})
    return
  }

  await interaction.deferReply(EPHEMERAL)
  let content: string
  try {
    await join(guild.id, channel.id, allowFrom)
    content = `${channel.name} に入りました。喋った内容は${channel.name}のテキストチャットに返します。`
  } catch (e) {
    log(`join に失敗したよ: ${(e as Error).message}`)
    content = '入室できなかったよ。詳しくは voice.log を見てね。'
  }
  await reply(interaction, content)
}

async function handleLeave(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply(EPHEMERAL)
  if (!isConnected()) {
    await reply(interaction, '入室していません（voice プロセスは起動していません）。')
    return
  }

  let current
  try {
    current = await status()
  } catch (e) {
    log(`leave 前の status 確認に失敗したよ: ${(e as Error).message}`)
    await reply(interaction, VOICE_UNAVAILABLE_MESSAGE)
    return
  }

  let content: string
  if (current.state === 'idle') {
    content = '入室していません。'
  } else if (current.state === 'joining') {
    // join と leave は voice 側で同じ列に直列化されている。ここで leave() を呼ぶと
    // Ready 待ちの残り時間ぶんブロックされたあげく退室してしまうので、待ってから打ち直してもらう
    content = '接続中です。少し待ってからもう一度 /voice leave を打ってください。'
  } else {
    try {
      await leave()
      content = '退室しました。'
    } catch (e) {
      log(`leave に失敗したよ: ${(e as Error).message}`)
      content = '退室できなかったよ。詳しくは voice.log を見てね。'
    }
  }
  await reply(interaction, content)
}

async function handleStatus(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply(EPHEMERAL)
  if (!isConnected()) {
    await reply(interaction, '入室していません（voice プロセスは起動していません） / whisper: down')
    return
  }

  let content: string
  try {
    const res = await status()
    if (res.state === 'idle' || !res.channelId) {
      content = `入室していません / whisper: ${res.whisper}`
    } else {
      const name = await resolveChannelName(interaction, res.channelId)
      const label = res.state === 'joining' ? '接続中' : '入室中'
      content = `${label}: ${name} / whisper: ${res.whisper}`
    }
  } catch (e) {
    log(`status に失敗したよ: ${(e as Error).message}`)
    content = VOICE_UNAVAILABLE_MESSAGE
  }
  await reply(interaction, content)
}

/** allowFrom は access.allowFrom（join() に渡して文字起こしの対象を絞る） */
export async function handleVoiceCommand(interaction: ChatInputCommandInteraction, allowFrom: string[]): Promise<void> {
  const sub = interaction.options.getSubcommand()
  if (sub === 'join') return handleJoin(interaction, allowFrom)
  if (sub === 'leave') return handleLeave(interaction)
  if (sub === 'status') return handleStatus(interaction)
  await interaction.reply({ content: `未対応のサブコマンドだよ（${sub}）。`, ...EPHEMERAL }).catch(() => {})
}
