# discord-bot（Claude Code プラグイン）

> このファイルは、このリポジトリで作業する Claude Code 向けの開発者の作業ルールと進捗メモです。利用者向けの説明は README.md にあります。

Claude Code の公式 Discord プラグインに無い機能を補う自作プラグイン。詳細は README.md、移植の手順書は docs/archive/migration-plan.md を参照。

## 開発ルール

- Discord セッションの起動・終了・再起動（`discord-start`、`/exit`、`/reload-plugins` の送信、管理者設定の作成）は開発者が自分のターミナルで行う。Claude はコマンドを提示するだけで、tmux 経由で他のセッションを操作しない（2026-09-03 に検証目的で Claude が操作したのは例外。以後は開発者が主体）
- 作業は GitHub の issue 単位で進める（https://github.com/umitsu-tech/claude-code-discord-bot/issues）。 issue ごとに `main` から `issue-<番号>-<短い英語>` のブランチを切り、終わったら PR を作って `main` にマージする。 `main` に直接コミットしない
- issue には推奨モデルをラベルで付けてある（`model:sonnet` / `model:opus` / `model:fable`）。ラベルより上のモデルでやる分には構わない。着手時にそのモデルで難しいと感じたら、無理に進めず issue にコメントを残して止める
- 着手時に issue の「やること」を読み、完了時に受け入れ条件を実際に確認してから PR を出す。PR 本文に `Closes #<番号>` を書く
- 変更したら `.claude-plugin/plugin.json` の version を上げてコミットし、 discord-workspace で `claude plugin update discord-bot@ryuki-plugins --scope project` → Discord セッションで `/reload-plugins` `/reload-plugins` で入れ替わるのはスキルとフックだけ。channel/ や mcp/ のコード、commands.json を変えたときはセッションを再起動する（`discord-start --resume <session-id>`）。再起動しないと古いコードが動き続ける
- bash と Python は処理内容で選ぶ。プロセス・tmux・ファイルの操作は bash、JSON や HTTP、日時計算のように構造化データを扱う処理は Python。片方の中にもう片方を埋め込む（bash 内の `python3 -c` など）くらいなら一本に寄せる。無理に統一しない
- Python を使うときは `uv run --script` で動かす（shebang `#!/usr/bin/env -S uv run --script` と inline metadata を付ける）
- 検証は tmux 内の使い捨てセッションで行う。`--channels` 付きの claude を 2 つ立てない（Discord に二重返信する）
- 作業の区切りごとに「現在の状況」を更新してコミットする
- ユーザー固有の値（Discord のユーザー ID、チャンネル ID、ギルド ID）をスクリプトやスキルに直書きしない。 `~/.claude/channels/discord/` の設定ファイルか環境変数から読む

## 現在の状況

- 最終更新: 2026-09-25
- いまの版と稼働状態: v0.9.2。管理者設定 allowedChannelPlugins で承認したうえで `DISCORD_BOT_CHANNEL_MODE=fork discord-start` で起動する。フォーク版 channel サーバーが送受信を担当し、公式プラグインは使っていない
- 直近の完了: スキルの Opus 5.5 向け書き直しとスクリプト化 #96（v0.9.2） / 複数インスタンス対応とギルド単位の既定 #85〜#93（v0.8.1〜v0.9.1） / ボイスチャンネル対応 #61〜#67（v0.8.0）
- 残り・次の一歩: #96 は plugin update と再起動で反映し、Discord から `/restart resume:yes`、`/ctx`、チャンネル作成（setup-channel と register_channel.py）が通ることを確かめた。`/clear` の確認が残り。受信設定のエントリの設計の見直し（#98）は要検討。/clear を Bot 側に寄せる案（#52）は見送り
- 履歴: docs/changelog.md
- 関連リソース: リポジトリ https://github.com/umitsu-tech/claude-code-discord-bot（Public）、マーケットプレイス https://github.com/umitsu-tech/claude-plugins、discord-workspace の `memory/tasks.md`（台帳の入口）と `docs/discord-context-control.md`（設計メモ）
