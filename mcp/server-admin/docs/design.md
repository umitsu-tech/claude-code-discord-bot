# 設計書: Discord サーバー管理 MCP サーバー

> この文書はプラグインに取り込む前、単体のプロジェクトとして作っていたときの設計書です。実装の判断の理由を残す目的で
> そのまま置いてあります。現在の実装と違うところは末尾の「実装との差分」にまとめました。


## 1. 背景と目的

### 背景
Claude Code の公式 Discord プラグインは以下のメッセージ操作のみ提供:
- `fetch_messages`: メッセージ取得
- `reply`: メッセージ送信
- `react`: リアクション追加
- `edit_message`: メッセージ編集
- `download_attachment`: 添付ファイルダウンロード

学習用 Discord サーバーを Claude Code から自由に操作するには、チャンネル管理やロール管理などの機能が必要。

### 目的
Discord REST API v10 を利用した MCP サーバーを自作し、Claude Code からサーバー管理操作を行えるようにする。

## 2. 技術構成

| コンポーネント | 技術 | バージョン |
|--------------|------|----------|
| 言語 | Python | 3.10+ |
| MCP SDK | mcp（FastMCP） | v1.27.2+ |
| HTTP クライアント | httpx | 最新 |
| 環境変数管理 | python-dotenv | 最新 |
| パッケージ管理 | uv | 最新 |

### アーキテクチャ
```
Claude Code
  ↓ stdio（JSON-RPC）
MCP サーバー（FastMCP）
  ↓ HTTPS
Discord REST API v10
  ↓
Discord サーバー
```

## 3. Discord REST API エンドポイント

ベース URL: `https://discord.com/api/v10`

認証ヘッダー: `Authorization: Bot {BOT_TOKEN}`

### Phase 1: チャンネル管理

| 操作 | メソッド | エンドポイント |
|------|---------|--------------|
| チャンネル一覧取得 | GET | `/guilds/{guild_id}/channels` |
| チャンネル作成 | POST | `/guilds/{guild_id}/channels` |
| チャンネル情報取得 | GET | `/channels/{channel_id}` |
| チャンネル編集 | PATCH | `/channels/{channel_id}` |
| チャンネル削除 | DELETE | `/channels/{channel_id}` |

#### チャンネルタイプ（type フィールド）
| 値 | 種別 |
|----|------|
| 0 | テキストチャンネル |
| 4 | カテゴリ |
| 5 | アナウンスチャンネル |
| 15 | フォーラムチャンネル |

※ ボイスチャンネル（type=2）はスコープ外

## 4. MCP ツール定義

### `list_channels`
- 説明: サーバーのチャンネル一覧を取得する
- 引数: なし（GUILD_ID は環境変数から取得）
- 戻り値: チャンネル名・ID・タイプ・カテゴリの一覧

### `create_channel`
- 説明: 新しいチャンネルを作成する
- 引数:
  - `name` (str, 必須): チャンネル名
  - `channel_type` (int, 任意, デフォルト=0): チャンネルタイプ（0=テキスト, 4=カテゴリ, 5=アナウンス, 15=フォーラム）
  - `category_id` (str, 任意): 親カテゴリの ID
  - `topic` (str, 任意): チャンネルのトピック
- 戻り値: 作成されたチャンネルの情報

### `delete_channel`
- 説明: チャンネルを削除する
- 引数:
  - `channel_id` (str, 必須): 削除するチャンネルの ID
- 戻り値: 削除結果

### `edit_channel`
- 説明: チャンネルの名前やトピックを変更する
- 引数:
  - `channel_id` (str, 必須): 編集するチャンネルの ID
  - `name` (str, 任意): 新しい名前
  - `topic` (str, 任意): 新しいトピック
- 戻り値: 更新後のチャンネル情報

### `create_category`
- 説明: チャンネルカテゴリを作成する
- 引数:
  - `name` (str, 必須): カテゴリ名
- 戻り値: 作成されたカテゴリの情報

## 5. Discord プラグインとの連携（access.json 自動更新）

チャンネル作成/削除時に `~/.claude/channels/discord/access.json` を自動更新し、
新しいチャンネルですぐにエージェントとやり取りできるようにする。

- `create_channel`: テキスト/アナウンス/フォーラムチャンネル作成時に `groups` へ追加
- `delete_channel`: `groups` から該当チャンネルを削除
- `create_category`: カテゴリはメッセージ対象外のため更新しない

## 6. Discord Bot の権限設定

Bot に必要な権限（Permission Integer を Developer Portal で設定）:

- `Manage Channels`（チャンネルの作成・削除・編集）
- `View Channels`（チャンネル一覧の取得）

### 権限の設定方法
1. [Discord Developer Portal](https://discord.com/developers/applications) にアクセス
2. 対象の Bot アプリケーションを選択
3. OAuth2 → URL Generator で必要な権限にチェック
4. 生成された URL でサーバーに Bot を再招待（既存 Bot の権限更新）

## 6. 環境変数

`.env` ファイルに以下を設定:

```env
DISCORD_BOT_TOKEN=your_bot_token_here
DISCORD_GUILD_ID=your_guild_id_here
```

- `DISCORD_BOT_TOKEN`: Bot のトークン（Developer Portal → Bot → Token）
- `DISCORD_GUILD_ID`: 操作対象のサーバー ID（Discord でサーバー右クリック → ID をコピー）

## 7. レート制限への対応

Discord API にはレート制限がある。httpx で直接呼び出すため、最低限の対応が必要:

- レスポンスヘッダー `X-RateLimit-Remaining` が 0 の場合、`X-RateLimit-Reset-After` 秒待機
- 429 レスポンスを受けた場合、`Retry-After` ヘッダーの秒数だけ待機してリトライ

ただし、学習用サーバーでの手動操作程度ならレート制限に達することは稀。
初期実装では 429 時のリトライだけ実装し、問題が出たら拡張する。

## 8. 開発ステップ

1. プロジェクト初期化（pyproject.toml, .env, .gitignore）
2. Discord REST API クライアント実装（httpx ベース）
3. チャンネル管理ツール実装（一覧・作成・削除・編集・カテゴリ作成）
4. MCP サーバーとして起動・Claude Code に登録
5. 動作確認

追加機能（ロール管理・サーバー情報など）は必要になった時点で検討する。

## 実装との差分（2026-09-04 時点）

この設計書を書いたあとに変わったところです。

- ツールは 9 つに増えました。設計書に載っている 5 つ（`list_channels` / `create_channel` / `delete_channel` /
  `edit_channel` / `create_category`）に加えて、フォーラムとスレッドを扱う `create_forum_thread` / `list_threads` /
  `close_thread` / `reopen_thread` があります
- トークンとギルド ID は、プロジェクト直下の `.env` ではなく公式 Discord プラグインと共有する
  `${DISCORD_STATE_DIR:-~/.claude/channels/discord}/.env` から読みます。`DISCORD_GUILD_ID` が無いときは
  Bot が参加しているサーバーを問い合わせて自動で決めます
- レート制限は 429 を受けたときのリトライだけ実装しています。`X-RateLimit-Remaining` を見た先読みの待機は入れていません
- 「8. 開発ステップ」は完了済みです。プラグイン化の経緯はリポジトリ直下の `docs/archive/migration-plan.md` にあります
