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
  dev/fake-gateway.js               channel の代わりに Gateway 中継だけを行う開発用スクリプト
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
docs/migration-plan.md              移植の手順書と公開前チェックリスト
docs/diagrams/                      図の元ファイル（.drawio）と書き出した PNG。編集は draw.io で、書き出しは drawio CLI（--scale 3）
```

状態ファイルは `~/.claude/discord-bot/` に置きます。`/clear` 用が `pending-clear.json` と `clear-notify.log`、
`/restart` 用が `restart-done.json`（完了マーカー。起動し直した channel サーバーが読んで消す）と
`restart.log`（補助スクリプトと `claude update` の記録）、voice プロセス用が `voice.sock`（channel との
やりとりに使う Unix ドメインソケット）と `voice.log` です。
Discord の設定は公式プラグインと同じ `~/.claude/channels/discord/`（`.env`、`access.json`）に置きます。

## voice プロセスの動作確認

`voice/` は Node で動かします（Bun では `@discordjs/voice` が動きません）。channel サーバー側の中継が
入るまでは、`voice/dev/fake-gateway.js` が channel の代わりに Gateway 中継だけを行うので、これで
入退室を確認できます。ギルド ID とボイスチャンネル ID は引数か環境変数で渡します。

```sh
cd voice && npm install
node index.js > ~/.claude/discord-bot/voice.log 2>&1 &           # 待ち受けを開始
node dev/fake-gateway.js <ギルドID> <ボイスチャンネルID> [滞在秒数]  # join → Ready → leave まで自動で行う
```

voice プロセスはログを標準出力にだけ出します。ファイルに残したいときは上のようにリダイレクトしてください
（channel サーバーから spawn する場合は channel 側が `voice.log` へまとめます）。

`fake-gateway.js` は Bot トークンを `~/.claude/channels/discord/.env` から読みます。常駐セッションと
Gateway 接続が一時的に 2 本になりますが、テキスト系のインテントを持たせていないので二重返信は起きません。

## 移植の経緯

手順書と公開前チェックリストは [migration-plan.md](migration-plan.md) にあります。
