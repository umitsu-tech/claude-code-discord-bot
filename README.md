# Claude Code 用 Discord Bot プラグイン（discord-bot）

*A Claude Code plugin that turns a Discord bot into a remote front-end for a Claude Code session: check context usage and clear the session from Discord, show usage in the bot's status, manage server channels, and run skills via slash commands. Forked from the official Discord channel plugin. Documentation is in Japanese.*

開発者が運用している Discord サーバー管理 Bot「kuroko-chan」の中身です。Claude Code のプラグインとして動きます。
Discord 社および Anthropic 社とは無関係の、非公式なコミュニティ製プラグインです。

Claude Code には、Discord のメッセージをそのまま会話に流し込む channel 機能（`claude --channels ...`）があります。
ただし公式の Discord プラグインが担当するのはメッセージの送受信だけで、コンテキストの残量を見たりクリアしたりといった
セッションの管理も、チャンネルやスレッドを作るといったサーバーの管理もできません。
このプラグインは、公式プラグインの channel サーバーをフォークして土台にし、その上にセッション管理・サーバー管理・
Bot ステータス表示を載せたものです。作った経緯と考え方は [docs/background.md](docs/background.md) にまとめています。

## 全体像

![全体構成](docs/diagrams/architecture.png)

## 機能

| 機能 | 内容 |
| --- | --- |
| Discord との送受信 | 公式プラグインからフォークした channel サーバー（`channel/`）<br>reply / react / edit_message / fetch_messages / download_attachment |
| アクセス管理 | `/discord-bot:access` でペアリング承認・allowlist・チャンネルの受信設定<br>`/discord-bot:configure` で Bot トークンの保存<br>設定ファイルは公式と同じ `~/.claude/channels/discord/` |
| コンテキスト使用量の表示 | Discord で `/ctx`<br>ctx / 5h / 7d の使用率をコードブロックで返す |
| Discord からのクリア | Discord で `/clear`<br>宣言 → tmux ペインに `/clear` を送信 → 新セッション開始時に「クリアしたよ」を自動投稿 |
| Discord からの再起動 | Discord で `/restart`（`resume: yes` で会話を引き継ぐ）<br>`/exit` を送信 → `claude update` → 起動し直し → 「再起動したよ（2.1.261 → 2.1.262）」を自動投稿 |
| Discord からのモデル・effort 切り替え | Discord で `/model alias:sonnet` `/effort level:low`<br>tmux ペインに送信 → 切り替わりを検知したら「切り替えたよ」を自動投稿 |
| Bot ステータスに使用量を常時表示 | Bot のアクティビティを `ctx 53% · 5h 46% · 7d 17%` に更新<br>ctx 80% 以上で赤 / セッション無しで黄。モデル名の横に effort も表示 |
| サーバー管理 MCP | チャンネル・カテゴリ・フォーラムスレッドの作成・編集・削除・一覧（`server-admin` 9 ツール） |
| チャンネル作成ワークフロー | `/discord-bot:setup-channel`<br>作成 → access.json の受信設定 → 受信テスト<br>作成直後にフックが受信設定を促す |
| スラッシュコマンド | `/ctx` `/clear` `/model` `/effort` `/restart` を同梱<br>`~/.claude/discord-bot/commands.json` に書けば任意のスキルを引数付きで呼べる |
| 起動ランチャー | `scripts/start-discord.sh` が tmux セッション `discord` で claude を起動<br>二重起動は防ぐ |

## セットアップ

必要なものは tmux、uv、bun と Discord の Bot です。Bot は Message Content Intent を有効にしたうえで、
`bot` と `applications.commands` の 2 つのスコープでサーバーに招待してください。`applications.commands` が無いと
スラッシュコマンドを登録できません。Bot の作り方は `channel/UPSTREAM-README.md` の Quick Setup 1〜3 と同じです。
動作確認は macOS で行っています。

### 1. プラグインを入れる

Discord セッションに使うプロジェクトのディレクトリで、プロジェクトスコープで有効化します。
公式の Discord プラグインを使っていた場合は無効にしてください。同じトークンで Gateway 接続が 2 本になり、返信が二重になります。

```sh
claude plugin marketplace add ryuki-imachi/claude-plugins
cd <Discord セッションに使うプロジェクト>
claude plugin install discord-bot@ryuki-plugins --scope project
```

### 2. Bot トークンを保存する

公式プラグインで設定済みならそのまま使えます。ギルド ID は、Bot が 1 つのサーバーにしか入っていなければ省略できます。

```
/discord-bot:configure <トークン>
```

### 3. ステータスラインの JSON を保存する

`/ctx` と Bot ステータス表示は、Claude Code がステータスライン用に渡す JSON を読みます。
`settings.json` の `statusLine.command` を次のようにラッパー経由にするのが簡単です。

```json
{
  "statusLine": {
    "type": "command",
    "command": "uv run ~/path/to/claude-code-discord-bot/scripts/statusline_dump.py -- <元のコマンド>"
  }
}
```

### 4. channel プラグインとして承認する

Claude Code は公式以外の channel プラグインからの通知を既定で捨てるため、このプラグインで Discord と送受信するには
承認リストに載せる必要があります。管理者設定 `/Library/Application Support/ClaudeCode/managed-settings.json`
（macOS、要 sudo）に次を書きます。

```json
{
  "allowedChannelPlugins": [
    { "plugin": "discord-bot", "marketplace": "ryuki-plugins" },
    { "plugin": "discord", "marketplace": "claude-plugins-official" }
  ]
}
```

承認しない場合は、`DISCORD_BOT_CHANNEL_MODE=official` を付けて起動すると公式プラグインが送受信を担当し、
このプラグインは Bot ステータス表示・サーバー管理 MCP・スキルだけを受け持ちます。この構成ではスラッシュコマンドは使えません。

### 5. 起動する

プロジェクトのディレクトリで実行します。tmux セッション `discord` の中で claude が動きます。
初回は DM に届くペアリングコードを `/discord-bot:access pair <コード>` で承認してください。

```sh
~/path/to/claude-code-discord-bot/scripts/start-discord.sh                       # 新規
~/path/to/claude-code-discord-bot/scripts/start-discord.sh --resume <session-id> # 会話を引き継ぐ
```

起動画面の上のほうに「messages from plugin:discord-bot@ryuki-plugins inject directly in this session」と出て、
その下に「not on the approved channels allowlist」の行が無ければ、Discord からのメッセージが届く状態です。

## 使い方

Discord のチャンネルで `/ctx` と送ると、次のような返事が来ます。

```
コンテキスト使用量
ctx ■■■■■□□□□□ 54%  544.8K / 1000.0K tokens
5h  ■■■■■□□□□□ 48%  リセット 09/03 00:00
7d  ■□□□□□□□□□ 13%  リセット 09/06 19:00
セッション 1c5a207c  Fable 5.1  計測 09/02 23:00:54  source statusline
```

`/clear` と送ると「クリアするね（今 54%）」と返事があり、数秒後に「コンテキストをクリアしたよ」が届きます。
その次のメッセージから新しいセッションになります。作業途中の要点は、クリア前に台帳などへ書いておいてください。

`/model alias:sonnet` `/effort level:low` と送ると「送ったよ」と返事があり、次のメッセージからそのモデル・effort で応対します。
切り替わったことを検知できたときは、数秒後に「モデルを Sonnet 5 に切り替えたよ」のような通知が届きます。
`/model` の引数指定はデフォルトとしても保存されるので、ターミナルで新しく開くセッションのモデルも変わります。
`/effort` の `low`〜`xhigh` はモデルごとに保存され、`max` はこのセッション限り、`auto` は保存済みの設定をクリアします。

`/restart` と送ると「再起動するね」と返事があり、数秒後にセッションが終了して新しい tmux ウィンドウで起動し直します。
`claude update` を挟むので、Claude Code のバージョンを上げるときに使えます。起動が終わると「再起動したよ（2.1.261 → 2.1.262）」が届きます。
会話は引き継がないので、`/clear` と同じく要点は先に書き出しておいてください。引き継ぎたいときは `/restart resume:yes` と送ります。
ターミナルで `/exit` したときは今までどおり終了するだけです。

Bot のステータスは、Claude が応答してステータスラインが再描画されるたびに更新されます。channel サーバーがその値を
最大 20 秒ごとに拾うので、何もしていない間は変わりません。カードの 2 行目にある「更新 HH:MM」が、最後に再描画された時刻です。

チャンネルを増やしたいときは、Discord で「〇〇というチャンネル作って」と頼むだけで済みます。
`/discord-bot:setup-channel` が作成から受信設定、受信テストまで案内します。

## ドキュメント

- [docs/background.md](docs/background.md) 背景と考え方、関連記事
- [docs/how-it-works.md](docs/how-it-works.md) /clear の流れ、Bot ステータス、スラッシュコマンド（/model・/effort・/restart を含む）、サーバー管理 MCP、制約
- [docs/development.md](docs/development.md) 更新のしかた、ディレクトリ構成、移植の経緯

## ライセンス

このリポジトリは MIT License です。ただし `channel/` は公式 Discord プラグイン
（`anthropics/claude-plugins-official`、Apache-2.0）のフォークなので、そのディレクトリのファイルは
Apache-2.0 のままです（`channel/LICENSE`）。改変した内容は `channel/server.ts` の先頭に書いてあります。
