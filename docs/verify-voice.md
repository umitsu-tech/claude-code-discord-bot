# 音声機能の通し検証手順

Issue #61〜#66 でマージした音声入力（聞き取りのみ）の通し確認。tmux の使い捨てセッションで行う。
上から順にやる。結果はこのファイルの各項目の末尾に「OK / NG（現象）」を書き足していく。

## 0. 前提

- 検証中は `--channels` 付き claude を 2 つ立てない
- サーバーにボイスチャンネルがあり、Bot に `Connect` 権限があること
- 検証用のボイスチャンネルは、テキストチャットから `/voice join` を打てるように事前に
  `access.json` の `groups` に登録しておく（`/discord-bot:setup-channel` か `/discord-bot:access group add`）
- 本番の常駐セッションとは別に、使い捨ての tmux セッションで検証する（常駐に影響を出さないため）

## 1. セットアップ（ターミナル）

```sh
scripts/setup-voice.sh
```

- [ ] `whisper-server` が導入済みと表示される、または Homebrew でインストールされる
- [ ] `~/.claude/discord-bot/models/` にモデル 2 つ（`ggml-large-v3-turbo-q5_0.bin`、`ggml-silero-v5.1.2.bin`）ができる
- [ ] `~/.claude/discord-bot/voice.json` ができる（`whisper.binary` が絶対パスになっていること）
- [ ] `voice/node_modules` ができる

## 2. 使い捨てセッションを起動する（ターミナル）

```sh
tmux new -s voice-verify
cd ~/Desktop/work/discord-workspace   # または検証対象のプロジェクト
claude plugin update discord-bot@ryuki-plugins --scope project
DISCORD_BOT_CHANNEL_MODE=fork discord-start
```

- [ ] 起動ログに `Channel notifications registered` が出る
- [ ] `commands: registered N command(s)` に `voice` が含まれる
- [ ] Discord で `/` を打つと `voice`（join / leave / status のサブコマンド）が候補に出る

## 3. ボイスチャンネルに入る（Discord アプリ）

1. 検証用のボイスチャンネルに参加する
   - [ ] 参加できた

## 4. `/voice join`

そのボイスチャンネルのテキストチャットで `/voice join` を送る。

- [ ] 本人にだけ見える形で「〇〇に入りました。喋った内容は〇〇のテキストチャットに返します。」が返る
- [ ] Bot がボイスチャンネルに参加する（Discord アプリのメンバー一覧に Bot が出る）
- [ ] 失敗する場合は `~/.claude/discord-bot/voice.log` の `stateChange` ログでどの段階で止まったかを確認する。
  `Ready` に到達しない場合は `voice.json` の `voice.readyTimeoutS`（既定 8 秒）で 1 回だけ自動的に接続をやり直す
  （合計最大 16 秒。#73）。それでも失敗したら、もう一度 `/voice join` を打つ

## 5. 発話して文字起こしを確認する

1. 短く（1 秒未満）発話する
   - [ ] テキストチャットに文字起こしが投稿される、または明らかにノイズと分かる短い発話は
     `minSpeechMs`（既定 300ms）未満として捨てられ、何も投稿されない
2. 数秒（3〜5 秒程度）話す
   - [ ] 発言内容と一致する文字起こしがテキストチャットに投稿される
   - [ ] 投稿は喋り終えてから 2〜3 秒後に届く（whisper-server の `/inference` が約 2.5 秒かかるため）
3. 途中に短い間（0.5 秒程度の相槌・言い直し）を挟んで発話する
   - [ ] 間で区切られず、ひと続きの発話として文字起こしされる（`speaking` の `end` では区切らない設計）

## 6. `/voice status`

- [ ] 「入室中: 〇〇 / whisper: ready」が本人にだけ返る

## 7. `/voice leave`

- [ ] 「退室しました。」が本人にだけ返る
- [ ] Bot がボイスチャンネルから抜ける
- [ ] 続けて `/voice status` を送ると「入室していません」が返る

## 8. 後始末

voice プロセスと whisper-server はプロセスとして残り続けるので、検証が終わったら止める。

```sh
pkill -f "node .*voice/index.js"
pkill -f whisper-server
rm -f ~/.claude/discord-bot/voice.sock
```

- [ ] `ps aux | grep -E "voice/index.js|whisper-server"` に何も残っていない

使い捨てセッションも終了する。

```sh
tmux kill-session -t voice-verify
```

## 確認済みの結果（2026-09-14、実機）

- 入室は約 0.5 秒で完了した
- 3.8 秒の発話が発言どおりに文字になった
- 1 秒未満の短い発話も正しく拾えた（`minSpeechMs` 未満のノイズとして捨てられず、意味のある発話として認識された）
- 1 回目の `/voice join` が `VoiceConnectionStatus.Ready` に到達せず、20 秒で「ボイスチャンネルへの接続に
  失敗しました」になった。同じ環境で成功も複数回あり、間欠的な症状だった（この検証時点では未対応。
  Issue #73 で自動再試行を実装済み。`readyTimeoutS` による 1 回の再試行で解消する見込み）

## NG だったときに集めるもの

- `~/.claude/discord-bot/voice.log`（voice プロセスの起動・入退室・文字起こしのログ）
- `/voice status` の応答（`whisper` が `down`/`starting` のままなら whisper-server 側の問題）
- Discord アプリでの Bot の入室状態（メンバー一覧、スピーカーアイコンの状態）
- 短い発話が拾えない場合は `voice.json` の `vad.minSpeechMs` / `vad.silenceMs` を見直す

## 終わったら

- このファイルを消すか、結果を書き込んで commit する
- CLAUDE.md の「現在の状況」を更新する
