/**
 * voice-command.ts — /voice join・leave・status（#66）の処理本体。
 * server.ts の handleSlashCommand() が action === 'voice' のときにここへ渡す。認可
 * （allowFrom・受信設定）はすでに server.ts 側で済んでいる前提で、Discord 側の状態
 * （呼び出し元がいるボイスチャンネル、チャンネル名の解決）と voice-control.ts の呼び出しだけを行う。
 *
 * join/leave/status はいずれも voice プロセスとの往復（最大で join が 30 秒、他が 20 秒）が
 * あるので、3 秒の応答期限に間に合わせるため deferReply → editReply で返す。
 *
 * leave() は voice 側の仕様上、未入室でも「既に idle」のログを出すだけで成功応答を返す
 * （#62 の handleLeave 参照）。「入室していません」を返し分けるため、leave() を呼ぶ前に
 * status() で現在の状態を見てから判断する。
 */
import { MessageFlags, type ChatInputCommandInteraction } from 'discord.js'
import { join, leave, status } from './voice-control'

const EPHEMERAL = { flags: MessageFlags.Ephemeral } as const

/** interaction.guild.channels 経由で名前を引く。取れなければ ID をそのまま出す */
async function resolveChannelName(interaction: ChatInputCommandInteraction, channelId: string): Promise<string> {
  try {
    const ch = await interaction.client.channels.fetch(channelId)
    return ch && 'name' in ch && ch.name ? ch.name : channelId
  } catch {
    return channelId
  }
}

async function handleJoin(interaction: ChatInputCommandInteraction, allowFrom: string[]): Promise<void> {
  const guild = interaction.guild
  if (!guild) {
    await interaction.reply({ content: 'DM では使えないよ。ボイスチャンネルのあるサーバーで打ってね。', ...EPHEMERAL }).catch(() => {})
    return
  }
  // interaction.member はキャッシュ由来で voice state が古いことがあるので、fetch し直して確認する
  const member = await guild.members.fetch(interaction.user.id).catch(() => null)
  const channel = member?.voice.channel
  if (!channel) {
    await interaction.reply({ content: '先にボイスチャンネルに入ってください。', ...EPHEMERAL }).catch(() => {})
    return
  }

  await interaction.deferReply(EPHEMERAL)
  try {
    await join(guild.id, channel.id, allowFrom)
    await interaction.editReply({ content: `${channel.name} に入りました。喋った内容はこのチャンネルのテキストチャットに返します。` })
  } catch (e) {
    await interaction.editReply({ content: `入室できなかったよ（${(e as Error).message}）。` })
  }
}

async function handleLeave(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply(EPHEMERAL)
  let current
  try {
    current = await status()
  } catch (e) {
    await interaction.editReply({ content: `voice プロセスが応答しません（${(e as Error).message}）。` })
    return
  }
  if (current.state === 'idle') {
    await interaction.editReply({ content: '入室していません。' })
    return
  }
  try {
    await leave()
    await interaction.editReply({ content: '退室しました。' })
  } catch (e) {
    await interaction.editReply({ content: `退室できなかったよ（${(e as Error).message}）。` })
  }
}

async function handleStatus(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply(EPHEMERAL)
  try {
    const res = await status()
    if (res.state === 'idle' || !res.channelId) {
      await interaction.editReply({ content: `入室していません / whisper: ${res.whisper}` })
      return
    }
    const name = await resolveChannelName(interaction, res.channelId)
    const label = res.state === 'joining' ? '接続中' : '入室中'
    await interaction.editReply({ content: `${label}: ${name} / whisper: ${res.whisper}` })
  } catch (e) {
    await interaction.editReply({ content: `voice プロセスが応答しません（${(e as Error).message}）。` })
  }
}

/** allowFrom は access.allowFrom（join() に渡して文字起こしの対象を絞る） */
export async function handleVoiceCommand(interaction: ChatInputCommandInteraction, allowFrom: string[]): Promise<void> {
  const sub = interaction.options.getSubcommand()
  if (sub === 'join') return handleJoin(interaction, allowFrom)
  if (sub === 'leave') return handleLeave(interaction)
  if (sub === 'status') return handleStatus(interaction)
  await interaction.reply({ content: `未対応のサブコマンドだよ（${sub}）。`, ...EPHEMERAL }).catch(() => {})
}
