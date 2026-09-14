# discord-bot（Claude Code プラグイン）

> このファイルは、このリポジトリで作業する Claude Code 向けの開発者の作業ルールと進捗メモです。利用者向けの説明は README.md にあります。

Claude Code の公式 Discord プラグインに無い機能を補う自作プラグイン。詳細は README.md、
移植の手順書は docs/migration-plan.md を参照。

## 開発ルール

- Discord セッションの起動・終了・再起動（`discord-start`、`/exit`、`/reload-plugins` の送信、管理者設定の作成）は開発者が自分の
  ターミナルで行う。Claude はコマンドを提示するだけで、tmux 経由で他のセッションを操作しない（2026-09-03 に検証目的で
  Claude が操作したのは例外。以後は開発者が主体）
- 作業は GitHub の issue 単位で進める（https://github.com/umitsu-tech/claude-code-discord-bot/issues）。
  issue ごとに `main` から `issue-<番号>-<短い英語>` のブランチを切り、終わったら PR を作って `main` にマージする。
  `main` に直接コミットしない
- issue には推奨モデルをラベルで付けてある（`model:sonnet` / `model:opus` / `model:fable`）。ラベルより上のモデルで
  やる分には構わない。着手時にそのモデルで難しいと感じたら、無理に進めず issue にコメントを残して止める
- 着手時に issue の「やること」を読み、完了時に受け入れ条件を実際に確認してから PR を出す。PR 本文に `Closes #<番号>` を書く
- 変更したら `.claude-plugin/plugin.json` の version を上げてコミットし、
  discord-workspace で `claude plugin update discord-bot@ryuki-plugins --scope project` → Discord セッションで `/reload-plugins`
  `/reload-plugins` で入れ替わるのはスキルとフックだけ。channel/ や mcp/ のコード、commands.json を変えたときは
  セッションを再起動する（`discord-start --resume <session-id>`）。再起動しないと古いコードが動き続ける
- bash と Python は処理内容で選ぶ。プロセス・tmux・ファイルの操作は bash、JSON や HTTP、日時計算のように
  構造化データを扱う処理は Python。片方の中にもう片方を埋め込む（bash 内の `python3 -c` など）くらいなら一本に寄せる。
  無理に統一しない
- Python を使うときは `uv run --script` で動かす（shebang `#!/usr/bin/env -S uv run --script` と inline metadata を付ける）
- 検証は tmux 内の使い捨てセッションで行う。`--channels` 付きの claude を 2 つ立てない（Discord に二重返信する）
- 作業の区切りごとに「現在の状況」を更新してコミットする
- ユーザー固有の値（Discord のユーザー ID、チャンネル ID、ギルド ID）をスクリプトやスキルに直書きしない。
  `~/.claude/channels/discord/` の設定ファイルか環境変数から読む

## 現在の状況

- 最終更新: 2026-09-14
- 完了済み: issue #1〜#9 をすべてクローズ。サーバー管理 MCP の取り込み、discord-workspace の切り替え、
  setup-channel とフックの移植、ギルド ID 自動判定、ダンプ掃除、公式 Discord プラグインのフォーク（channel/、Apache-2.0）と
  プレゼンス統合、スラッシュコマンド /ctx /clear、ワークスペース用コマンド（追加定義 ~/.claude/discord-bot/commands.json）、公開準備
- issue の外で実施: docs/diagrams/ に構成図と処理フロー図を追加（drawio と PNG）、README の文章と表を整理（v0.6.7）
- 完了（2026-09-05）: issue #47（/model /effort）を PR #50、issue #46（/restart）を PR #51 でマージ（v0.7.1）。
  どちらも channel サーバー側で処理する方式（session-control.ts が tmux ペインへ send-keys、/restart は
  scripts/restart-helper.sh を切り離して起動）。スキル方式（PR #49）とスーパーバイザー方式（PR #48）は取り下げた。
  実機確認は 2026-09-05 に完了（手順は docs/verify-0.7.1.md）
- 完了（2026-09-14）: ボイスチャンネル対応（親 issue #61）の #62〜#67 が完了（v0.8.0）。
  #62（voice プロセスの骨格、`voice/` を新設）→ #63（Silero VAD による発話区間の切り出し、receiver.js）→
  #64（whisper-server の起動管理と文字起こし、transcriber.js・scripts/setup-voice.sh）→
  #65（channel サーバー側の中継、channel/voice-control.ts）→ #66（`/voice` join・leave・status、
  channel/voice-command.ts）→ #67（ドキュメント 3 枚〈architecture 再構成 / voice-architecture /
  voice-sequence〉、docs/verify-voice.md、README・how-it-works・development の更新）。Node で動く別
  プロセスが Unix ドメインソケット `~/.claude/discord-bot/voice.sock` で待ち受け、Gateway は channel
  サーバーの 1 本を借りて入退室する。文字起こしはローカルの whisper.cpp（whisper-server 常駐 + 発話ごとに
  /inference）。読み上げは未対応（初回スコープ外）
- 完了（2026-09-14）: #73（入室が間欠的に Ready に到達しない症状への再試行。`voice.json` に
  `voice.readyTimeoutS`〈既定 8 秒〉を追加し、1 回だけ自動的に接続をやり直す）と #74（文字起こしを
  `🎤 <表示名>: <文字起こし>` の形で VC のテキストチャットへ自動投稿。`access.json` の `voiceEcho: false`
  で無効化可）をマージ。#67 のドキュメント・図に反映済み
- 残り・次の一歩: 無し。/clear を Bot 側に寄せる案（#52）は見送り（スキル経由でクリア前に要点を保存できる利点を残す）。開発フラグの不具合は anthropics/claude-code#82939 で既報のため報告しない（2026-09-03 判断）
- 現在の稼働: 管理者設定 allowedChannelPlugins で承認したうえで `DISCORD_BOT_CHANNEL_MODE=fork discord-start` で起動する。
  フォーク版 channel サーバーが「Channel notifications registered」になり、公式プラグインは使っていない。
  Discord 側の動作確認は 2026-09-03 19:50 に完了（通常メッセージ、/ctx と /task のスラッシュコマンドで結果が投稿されることを確認）
- リモート: https://github.com/umitsu-tech/claude-code-discord-bot（2026-09-03 に Public 化）。
  マーケットプレイス `ryuki-plugins` の定義は 2026-09-07 に https://github.com/umitsu-tech/claude-plugins へ移した（Issue #57）。
  ローカルの marketplace 登録はディレクトリ参照のままで、GitHub 経由には切り替えていない
- 関連リソース: discord-workspace の `memory/tasks.md`（台帳の入口）と `docs/discord-context-control.md`（設計メモ）
