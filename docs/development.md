# 開発と更新

## 更新のしかた

インストール時にプラグインは `~/.claude/plugins/cache/ryuki-plugins/discord-bot/<version>/` へコピーされます。
このリポジトリを編集してコミットしたら、`plugin.json` の `version` を上げてから反映します。マーケットプレイス `ryuki-plugins` の定義（`marketplace.json`）は https://github.com/ryuki-imachi/claude-plugins にあります。

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
`restart.log`（補助スクリプトと `claude update` の記録）です。
Discord の設定は公式プラグインと同じ `~/.claude/channels/discord/`（`.env`、`access.json`）に置きます。

## 移植の経緯

手順書と公開前チェックリストは [migration-plan.md](migration-plan.md) にあります。
