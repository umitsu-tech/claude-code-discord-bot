# 開発と更新

## 更新のしかた

インストール時にプラグインは `~/.claude/plugins/cache/ryuki-plugins/discord-bot/<version>/` へコピーされます。
このリポジトリを編集してコミットしたら、`plugin.json` の `version` を上げてから反映します。マーケットプレイス `ryuki-plugins` の定義（`marketplace.json`）は https://github.com/umitsu-tech/claude-plugins にあります。

```sh
cd <Discord セッションに使うプロジェクト>
claude plugin update discord-bot@ryuki-plugins --scope project
```

そのあと、動いている Discord セッションで `/reload-plugins` を打つとスキルとフックが入れ替わります。
ただし MCP サーバー（channel サーバーと server-admin）は、`.mcp.json` の設定が変わらない限り `/reload-plugins` では
再起動されません。`channel/` や `mcp/` のコードを変えたときや、`~/.claude/discord-bot/commands.json` に
コマンドを足したときは、セッションを再起動してください（`scripts/start-discord.sh --resume <session-id>` で会話は引き継げます。
Discord からなら `/restart`、会話ごと引き継ぐなら `/restart resume:yes` でも同じことができます）。
ローカルディレクトリ由来のプラグインはスキル本文を元ディレクトリから直接読んでいるようなので
（`${CLAUDE_SKILL_DIR}` が元のパスを指す）、`/reload-plugins` だけで反映されることも多いです。

channel サーバーの元になった公式プラグインは `discord@claude-plugins-official` の 0.0.4 です。
上流に変更があったら `channel/server.ts` に取り込みます（差分の要点はファイル先頭のコメントに書いてあります）。

## ディレクトリ構成

```
.claude-plugin/plugin.json          マニフェスト
.mcp.json                           MCP サーバーの登録（discord = channel サーバー、server-admin = サーバー管理）
channel/                            Discord channel サーバー（公式プラグインのフォーク、Apache-2.0）
  server.ts                         送受信・アクセス制御・権限中継（上流 0.0.4 + 改変）
  presence.ts                       Bot ステータスへの使用量表示
  commands.ts / commands.json       スラッシュコマンドの登録と、スキル呼び出しへの変換
  session-control.ts                /model・/effort・/restart をサーバー側で処理（ペイン特定・send-keys・監視・完了通知）
  ACCESS.md                         アクセス制御の説明（上流をスキル名だけ書き換えたもの）
  UPSTREAM-README.md                上流の README（原文のまま）
voice/                              ボイスチャンネル用の Node プロセス（`@discordjs/voice` が Bun で動かないので channel と分けてある）
  index.js                          voice.sock で待ち受けて入退室する本体。Gateway は持たず channel から借りる
  receiver.js                       Silero VAD による発話区間の切り出し（UtteranceSegmenter / VoiceReceiver）
  transcriber.js                    whisper-server の起動管理と /inference 呼び出し（文字起こし）
  config.js                         voice.json（whisper / vad / voice / debug セクション）の読み込み。無効な値はフィールドごとに既定値へフォールバックする
  dev/fake-gateway.js               channel の代わりに Gateway 中継だけを行う開発用スクリプト
  dev/verify-vad.js                 録音済み WAV を UtteranceSegmenter に通し、区間の数と長さを機械的に確認する開発用スクリプト
mcp/server-admin/                   サーバー管理 MCP（Python、uv）
skills/access/ skills/configure/    アクセス管理とトークン設定（上流のスキルを名前空間だけ変えたもの）
skills/ctx/                         /discord-bot:ctx
skills/clear/                       /discord-bot:clear
skills/setup-channel/               /discord-bot:setup-channel
hooks/hooks.json                    SessionStart(clear) の完了通知、PostToolUse(create_channel) の受信設定リマインド
hooks/notify-clear-done.py
hooks/remind-channel-access.py
scripts/start-discord.sh            tmux セッション discord に claude を起動するランチャー
scripts/restart-helper.sh           /restart の裏方（claude の終了待ち → claude update → ランチャーで起動し直し）
scripts/statusline_dump.py          ステータスライン JSON を保存するラッパー（古いダンプの掃除つき）
scripts/discord_presence_check.py   自 Bot のプレゼンスを読む確認用（Presence Intent が必要）
scripts/setup-voice.sh              voice/ の導入（whisper.cpp、モデル、voice.json の雛形、npm install）。冪等
docs/migration-plan.md              移植の手順書と公開前チェックリスト
docs/diagrams/                      図の元ファイル（.drawio）と書き出した PNG。編集は draw.io で、書き出しは drawio CLI（--scale 3）
```

状態ファイルは `~/.claude/discord-bot/` に置きます。`/clear` 用が `pending-clear.json` と `clear-notify.log`、
`/restart` 用が `restart-done.json`（完了マーカー。起動し直した channel サーバーが読んで消す）と
`restart.log`（補助スクリプトと `claude update` の記録）、voice プロセス用が `voice.sock`（channel との
やりとりに使う Unix ドメインソケット）と `voice.log` です。voice の設定は `voice.json`（whisper / vad / voice / debug
セクション。無いときは既定値で動く）、文字起こし用モデルは `models/`（`scripts/setup-voice.sh` が
Hugging Face から取得する。リポジトリには入れない）に置きます。
`voice.json` の `voice.readyTimeoutS`（既定 8）は、入室時に `VoiceConnectionStatus.Ready` への到達を
1 回あたり何秒待つかの上限です。タイムアウトしたら 1 回だけ接続をやり直すので、合計の待ち時間は
最大でこの 2 倍（既定 16 秒）になります。channel 側の join タイムアウト（30 秒）に収まるようにしてあります。
Discord の設定は公式プラグインと同じ `~/.claude/channels/discord/`（`.env`、`access.json`）に置きます。

## voice の導入

`scripts/setup-voice.sh` を実行すると、whisper.cpp の導入（Homebrew）、文字起こしモデル 2 つのダウンロード、
`voice.json` の雛形作成、`voice/` の `npm install` を一度に行います。何度実行しても、既にある分はスキップします
（モデルの再ダウンロードはしません）。

## voice プロセスの動作確認

`voice/` は Node で動かします（Bun では `@discordjs/voice` が動きません。依存する `@discordjs/opus` の
プリビルドされたネイティブアドオン（`opus.node`）を Bun が正しく解決できないためで、discord.js 側は
「fix する予定なし」としています。discordjs/discord.js#10296、oven-sh/bun#11313）。
channel サーバー側の中継が入るまでは、`voice/dev/fake-gateway.js` が channel の代わりに Gateway 中継だけを
行うので、これで入退室を確認できます。ギルド ID とボイスチャンネル ID は引数か環境変数で渡します。

```sh
cd voice && npm install
node index.js > ~/.claude/discord-bot/voice.log 2>&1 &           # 待ち受けを開始
node dev/fake-gateway.js <ギルドID> <ボイスチャンネルID> [滞在秒数]  # join → Ready → leave まで自動で行う
```

voice プロセスはログを標準出力にだけ出します。ファイルに残したいときは上のようにリダイレクトしてください
（channel サーバーから spawn する場合は channel 側が `voice.log` へまとめます）。

`fake-gateway.js` は Bot トークンを `~/.claude/channels/discord/.env` から読みます。常駐セッションと
Gateway 接続が一時的に 2 本になりますが、テキスト系のインテントを持たせていないので二重返信は起きません。

VAD（発話区間の切り出し）だけを単体で確認したいときは `voice/dev/verify-vad.js` を使います。Discord への
接続もソケットも要らず、録音済みの WAV（48kHz・16bit・ステレオ。Discord の受信形式）を本実装と同じ
`UtteranceSegmenter` に通して、区間の数・長さ・破棄された区間を表示します。`experiments/voice-receive/`
の録音済み WAV や、`voice.json` の `debug.saveWav: true` で保存した `~/.claude/discord-bot/recordings/`
の WAV をそのまま入力にできます。

```sh
node voice/dev/verify-vad.js <WAVファイルまたはディレクトリ> [...]
```

## 移植の経緯

手順書と公開前チェックリストは [migration-plan.md](migration-plan.md) にあります。
