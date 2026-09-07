> 開発者の作業メモです。開発時の環境のパス（`~/Desktop/work/...`）がそのまま出てきます。仕組みの説明は [how-it-works.md](how-it-works.md) を見てください。

# 自作機能の discord-bot プラグインへの集約 手順書

作成: 2026-09-03（実施は 9/3 以降）

## issue との対応

2026-09-03 に GitHub の issue に切り出した。作業はこちらを正とする（https://github.com/umitsu-tech/claude-code-discord-bot/issues）。

| issue | 内容 | この文書の節 | 推奨モデル |
| --- | --- | --- | --- |
| #1 | サーバー管理 MCP をプラグインに取り込む | 手順 1 の 1〜3 | Sonnet 5 |
| #2 | discord-workspace を切り替え・グローバル登録を外す | 手順 1 の 4〜8 | Sonnet 5 |
| #3 | setup-channel とフックの移植 | 手順 2 | Sonnet 5 |
| #4 | ギルド ID の自動判定 | 手順 1 の 2（代案） | Sonnet 5 |
| #5 | 公式フォークとプレゼンス統合 | 手順 3 | Fable 5.1 |
| #6 | スラッシュコマンド /ctx /clear | 手順 3 | Opus 5 |
| #7 | ワークスペース用スキルのコマンド化 | 手順 3 | Opus 5 |
| #8 | 公開準備 | 公開前チェックリスト | Sonnet 5 |
| #9 | statusline ダンプの掃除 | なし | Sonnet 5 |

## 方針

公式 Discord プラグインに無い自作機能のうち、汎用的なものをこのプラグインへ集め、
あなたの Bot の運用ルールと台帳に依存するものは discord-workspace に残す。

| 対象 | 行き先 | 理由 |
| --- | --- | --- |
| サーバー管理 MCP（original-tools・9 ツール） | プラグイン `.mcp.json` | 公式に無い機能で汎用<br>今はグローバル登録のため無関係なセッションでも起動している |
| setup-channel スキル + remind-channel-access フック | プラグイン | 公式プラグインの access.json 受信設定の穴を塞ぐ汎用ワークフロー<br>ユーザー ID の直書きだけ直す |
| sync-threads / close-article-thread / save-knowledge / task-memo / inject-ledgers | discord-workspace に残す | memory/ の台帳・knowledge/・#記事の種 のチャンネル ID に依存した運用そのもの |

## 手順 1. サーバー管理 MCP の移植

現状: `~/Desktop/work/claude-discord-channel/original-tools/`（Python 3.10+、FastMCP、httpx、python-dotenv、uv）。
`~/.claude.json` の `mcpServers.discord-server-admin` にグローバル登録。トークンとギルド ID は original-tools 直下の `.env`
（`DISCORD_BOT_TOKEN`、`DISCORD_GUILD_ID`）から `load_dotenv` で読んでいる。
ツール: list_channels / create_channel / create_category / edit_channel / delete_channel /
create_forum_thread / list_threads / close_thread / reopen_thread。

1. ソースを移動する: `original-tools/{pyproject.toml,uv.lock,src/,docs/}` → `discord-bot/mcp/server-admin/`。
   `.env` は移動しない（後述のとおり共有の場所から読む）。`.venv` は作り直す
2. `server.py` のトークン読み込みを直す。優先順は「環境変数 → `${DISCORD_STATE_DIR:-~/.claude/channels/discord}/.env`」
   にして、公式プラグインと同じファイルを共有する。`DISCORD_GUILD_ID` も同じファイルに書けるようにする
   （代案: 未設定なら `GET /users/@me/guilds` で Bot の参加サーバーを取り、1 つだけならそれを使う）
3. `.mcp.json` をプラグイン直下に置く

```json
{
  "mcpServers": {
    "server-admin": {
      "command": "uv",
      "args": ["run", "--directory", "${CLAUDE_PLUGIN_ROOT}/mcp/server-admin", "python", "-m", "discord_mcp.server"]
    }
  }
}
```

4. ツール名が変わる。`mcp__discord-server-admin__<tool>` → `mcp__plugin_discord-bot_server-admin__<tool>`
   （公式の `mcp__plugin_discord_discord__reply` と同じ規則。実際の名前は `/mcp` かツール一覧で確認してから置換する）。
   discord-workspace 側で書き換える場所:
   - `.claude/settings.json` の `permissions.allow`（8 ルール）と PostToolUse フックの matcher
   - `.claude/skills/setup-channel/SKILL.md`、`sync-threads/SKILL.md`、`close-article-thread/SKILL.md` の allowed-tools と本文
   - `CLAUDE.md` の「利用可能なツール」表、`docs/discord-context-control.md`
5. グローバル登録を外す: `claude mcp remove discord-server-admin -s user`（`~/.claude.json` から消える）
6. `plugin.json` と `marketplace.json` の version を上げてコミット →
   discord-workspace で `claude plugin update discord-bot@ryuki-plugins --scope project` → Discord セッションで `/reload-plugins`
7. 検証
   - discord-workspace の使い捨てセッションで `list_channels` が動く（tmux 内、`--channels` は付けない）
   - 別ディレクトリのセッションで server-admin の MCP が起動しない（子プロセス一覧で確認）
   - Discord から「テスト用チャンネル作って」→ setup-channel の流れが通る（受信テストまで）
8. 片付け: `original-tools/` を削除し、`claude-discord-channel/README.md` の表を更新。`qiita-article/` の記事に
   MCP のパスが書かれていないか確認する

## 手順 2. setup-channel とフックの移植

1. `discord-workspace/.claude/skills/setup-channel/` → `discord-bot/skills/setup-channel/`
   - allowed-tools のツール名を新しい名前に
   - `allowFrom` へのユーザー ID の直書きをやめ、`~/.claude/channels/discord/access.json` の
     トップレベル `allowFrom` をそのまま使う手順に書き換える
   - 「CLAUDE.md のチャンネル構成表を更新」「memory/active-threads.md にセクション追加」は
     「プロジェクトの CLAUDE.md や台帳にチャンネル一覧があれば更新する」という一般化した表現にする
2. `discord-workspace/.claude/hooks/remind-channel-access.sh` → `discord-bot/hooks/remind-channel-access.sh`
   - 注入する文面のユーザー ID を access.json から読むように。JSON を読んで文面を組む処理なので Python
     （`uv run --script`）が向く。`jq` だけで済むなら bash のままでもよい
   - `hooks/hooks.json` に PostToolUse（matcher: 新しい create_channel のツール名）を追加
3. discord-workspace 側から skill と hook、settings.json の PostToolUse エントリを削除。CLAUDE.md の
   「新規作成時は必ず /setup-channel の手順に従い」を `/discord-bot:setup-channel` に書き換える
4. version を上げて update → `/reload-plugins` → Discord から「テスト用チャンネル作って」で通しテスト → テストチャンネル削除

## 手順 3. 公式プラグインをフォークして Bot 本体にし、スラッシュコマンドを載せる

2026-09-03 の相談メモ。フォークとプレゼンス統合（#5）は同日に実施済み（v0.5.0、`channel/`）。スラッシュコマンドは #6 #7。

### なぜフォークが要るか

Discord のスラッシュコマンド（アプリケーションコマンド）は `interactionCreate` イベントとして、
Gateway に接続している Bot プロセスにしか届かない。公式プラグインの server.ts は `messageCreate` だけを
Claude に転送し、Bot 自身の投稿（`author.bot`）は捨てるので、別プロセスからコマンドの内容を流し込む手段が無い。
本物のスラッシュコマンドでクロコのスキルを叩くには、Claude に繋がる Bot プロセスそのものを自前にするしかない。

### 形

- 公式 server.ts（Bun + discord.js + MCP SDK、Apache-2.0）をこのプラグインに取り込み、`claude/channel` を
  宣言する MCP サーバーとして `.mcp.json` に登録する。公式プラグインは無効化して Gateway 接続を 1 本にする
- 取り込んだファイルには Apache-2.0 の表示と変更点を残す（公開前チェックリスト参照）
- プレゼンス更新（discord_presence.py の中身）を server.ts に統合する。常駐スクリプトと tmux の presence ウィンドウが不要になる
- コマンドは `src/commands/<name>.ts` に 1 ファイル 1 コマンドで置き、`deploy.ts` で Discord に登録する。
  この構造は https://github.com/caru-ini/discord-bot-template（Bun + discord.js + Biome、MIT）の
  `commands/`・`events/`・`deploy.ts` の分け方を参考にする。Docker / Railway 周りは不要（Claude Code の下で stdio で動く）
- interaction を受けたら 3 秒以内に `deferReply`（または「受け付けたよ」の ephemeral 返信）し、
  `notifications/claude/channel` で Claude に `/discord-bot:ctx` のようなスキル呼び出し文を content として送る。
  meta に chat_id と interaction のトークンを入れ、reply ツールで通常のチャンネル投稿として返す
  （interaction の follow-up は 15 分で失効するので、長い作業は普通の投稿に倒す）

### コマンド候補

- `/ctx`、`/clear`（既存スキルをそのまま）
- `/channel new name type category`（setup-channel）
- `/task add|list|done`（task-memo）、`/threads sync`（sync-threads）など、ワークスペース側のスキルも
  引数付きで呼べるようにする。スキル本体はワークスペースに残し、コマンドは「スキル名と引数を Claude に渡す」だけにする

### 名前

2026-09-03 に決定: リポジトリ `claude-code-discord-bot`、プラグイン名 `discord-bot`（旧 `discord-session` から改名済み）。
検討した候補は次のとおり。

- リポジトリ `claude-code-discord-bot`、プラグイン名 `discord-bot`（スキルは `/discord-bot:ctx`）: 説明的で、公開向き
- リポジトリ `kuroko`、プラグイン名 `kuroko`（`/kuroko:ctx`）: 短くて愛着があるが、他人には中身が伝わらない

改名はリポジトリ名（`gh repo rename`）、`plugin.json` と `marketplace.json` の name、
discord-workspace の `enabledPlugins` のキーと CLAUDE.md の参照、再インストールで済む。履歴が浅い今のうちにやるのが楽

## 注意

- `--channels` 付きの claude を検証用に 2 つ立てない（二重返信）。検証は `--channels` 無しの使い捨てセッションで行う
- プラグインの MCP サーバーは `/reload-plugins` で再起動される。Discord ブリッジ（公式プラグイン）も一瞬つなぎ直る
- ツール名の置換漏れがあると、スキルが古い名前を呼んで許可プロンプトや失敗になる。
  `grep -rn discord-server-admin ~/Desktop/work/discord-workspace --include='*.md' --include='*.json' --include='*.sh'` で最後に確認する
- 作業の区切りごとに、このプラグインの `CLAUDE.md`「現在の状況」と discord-workspace の `memory/tasks.md` を更新する

## その後の候補

- 済（2026-09-03）: リポジトリを Public に切り替えた。公式プラグインの `server.ts` もフォークして
  プレゼンス更新を統合し、Gateway 接続を 1 本にまとめた
- ローカルの marketplace 登録をディレクトリ参照から GitHub 経由に切り替える
  （`claude plugin marketplace add umitsu-tech/claude-code-discord-bot`）
- Developer Portal で Presence Intent を有効にし、`discord_presence_check.py` で表示を自動確認できるようにする

## 公開前チェックリスト（権利・個人情報）

2026-09-03 に確認した内容。公開作業のときにこの節を上から順に見る。

### ライセンス

- ライセンスは MIT に決定し `LICENSE` を置いた（2026-09-03）。`plugin.json` にも `license` を記載済み
- 依存ライブラリは配布に含めず `uv run` で取得するので、表記義務は実質無い。参考: discord.py は MIT、mcp は MIT、
  httpx は BSD-3-Clause、python-dotenv は BSD-3-Clause、aiohttp は Apache-2.0 と MIT
- 公式 Discord プラグイン（`anthropics/claude-plugins-official`）は Apache-2.0。今のプラグインは公式のコードを含んで
  いないので義務は無い。将来 `server.ts` をフォークして同梱する場合は、Apache-2.0 の条件に従う。
  具体的には、元の LICENSE ファイル（と NOTICE があればそれ）を同梱し、改変したファイルに「変更した」旨と元の著作権表示を残す。
  MIT のリポジトリに Apache-2.0 のファイルが混ざるのは問題ないが、README にファイル単位でライセンスを書き分ける

### 商標・名乗り方

- 「Discord」「Claude Code」を製品名として使わず、README の冒頭に「非公式のコミュニティ製プラグインで、Discord 社
  および Anthropic 社とは無関係」と明記する。`discord-bot` のような技術的な名前自体は discord.py などと同じ使い方で問題ない
- Discord のロゴ・アイコン画像は同梱しない

### 個人情報・秘密情報

- Bot トークンを絶対に含めない。`.env` と `.venv/` は `.gitignore` 済み。MCP を移植するとき `original-tools/.env` は移動しない
- Discord のユーザー ID・チャンネル ID・ギルド ID は個人のサーバーを特定できるので、コードにも文書にも書かない
  （2026-09-03 に文書から除去し、コミット履歴も書き換え済み）。設定は `~/.claude/channels/discord/` から読む
  → 済（2026-09-03）: `channel/ACCESS.md` の例示スノーフレークもプレースホルダ（`<user-id>` 等）に置き換え、
  `git grep -nE '[0-9]{17,19}'` のヒットが `uv.lock` のハッシュ以外に無いことを確認した
- `/Users/ryuki/...` のような絶対パスは `<plugin>` や `~/path/to/...` に置き換える。Bot 名 kuroko-chan も「あなたの Bot」に直す
  → 済（2026-09-03）: README・docs・SKILL.md・スクリプトコメントの絶対パスを一般化。plugin.json/marketplace.json の
  description と migration-plan.md の kuroko-chan 言及もあなたの Bot に置き換え、README 冒頭の一文だけ残した。
  本人の個人名の呼称も README・CLAUDE.md・docs・SKILL.md・marketplace.json からユーザー/開発者に置き換え、
  検索でヒットが無いことを確認した
- `plugin.json` の author email は GitHub の noreply アドレスなのでそのままでよい
- 履歴は 2026-09-03 時点で走査済み（ID・トークンとも無し）。公開直前にもう一度確認する
  → 済（2026-09-03）: `git log --all -p | grep -E ...` を再実行。ヒットは `channel/ACCESS.md` の旧サンプルスノーフレーク、
  `.env` の書式例（`DISCORD_BOT_TOKEN=MTIz...` 等のプレースホルダ）、このチェックリスト自身の grep コマンド文字列のみで、
  実際の ID・トークンは無かった

```sh
git log --all -p | grep -E '[0-9]{17,19}|sk-ant|DISCORD_BOT_TOKEN=' || echo clean
```

  履歴を残したくない場合は orphan ブランチで一本化してから push する（元の履歴はローカルの `main-local` に残す）

```sh
git branch main-local
git checkout --orphan public && git commit -m "discord-bot v<version>"
git branch -D main && git branch -m main
```

### 規約

- Discord Developer Policy: 自分の Bot トークンで自分のサーバーを操作する通常の Bot なのでセルフボットには当たらない。
  プレゼンス更新は変化時のみ・最短 20 秒間隔で、Gateway のレート制限（120 イベント/60 秒）に十分収まる
- Anthropic: Claude Code のプラグイン仕様は公開されており、自作プラグインの公開・配布は自由。
  `claude-plugins-official` へ投稿する場合は別途レビューがある

### 同梱物の確認

- `original-tools/docs/design.md` などに個人サーバーの情報が無いか読む
  → 済（2026-09-03）: `mcp/server-admin/docs/design.md` と `mcp/server-admin/README.md` を確認。サーバー名・
  チャンネル名の一覧・実際の ID は無く、技術的な設計の記述のみだったので変更なし
- README のセットアップ手順を GitHub 経由（`claude plugin marketplace add umitsu-tech/claude-code-discord-bot`）を
  第一の方法にし、ローカルパスでの登録は「開発するとき」の方法として後ろに回す
  → 済（2026-09-03）
- `qiita-article/` の画像は記事用なので公開リポジトリに入れない
