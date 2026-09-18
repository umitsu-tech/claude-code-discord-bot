# 変更履歴

版ごとの変更点をまとめる。1 件 1〜2 行、Issue と PR の番号つき。詳しい経緯は [archive/migration-plan.md](archive/migration-plan.md) を参照。

## v0.8.1〜v0.8.2（2026-09-19）

- #87 `start-discord.sh` が `DISCORD_STATE_DIR` などを claude に引き継がない（tmux サーバーの環境が使われる）問題を修正。起動コマンドの頭に付けて渡す
- #85 複数インスタンス運用に対応。`start-discord.sh` の二重起動判定を対象 tmux セッション内に限定し、`/discord-bot:configure` `/discord-bot:access` が `DISCORD_STATE_DIR` を読むようにし、README に「複数インスタンスで動かす」を追加

## v0.8.0（2026-09-14）

- ボイスチャンネル対応（発話の文字起こしのみ、読み上げは未対応）。親 issue #61、子issue #62〜#67 （voice プロセスの骨格 PR #69、Silero VAD PR #71、whisper-server 連携 PR #72、channel サーバー側の中継 PR #68、 `/voice` join・leave・status PR #70、ドキュメント・検証手順 PR #77）
- #73 入室が間欠的に Ready に到達しない症状への自動リトライ（PR #75）
- #74 文字起こしを VC のテキストチャットへ自動投稿（PR #76）

## v0.7.2〜v0.7.4（2026-09-07・2026-09-14）

- #57 配布元をマーケットプレイス `claude-plugins` へ移行（PR #58）
- #59 GitHub ユーザー名の参照を更新（PR #60）

## v0.7.1（2026-09-05）

- #47 Discord から `/model` `/effort` を切り替え（PR #50）
- #46 Discord から常駐セッションを再起動 `/restart`（PR #51）

## v0.6.3〜v0.6.7（issue の外で実施、2026-09-03）

- 判断: 開発フラグの不具合は anthropics/claude-code#82939 で既報のため、こちらからは報告しない（2026-09-03）
- docs/diagrams/ に構成図・処理フロー図を追加（Mermaid → draw.io へ置き換え）、README の文章と表を整理

## v0.1.0〜v0.6.8（2026-09-02〜04、公開）

- issue #1〜#9 をすべてクローズしてプラグインへ集約（PR #10〜#45）
  - #1 サーバー管理 MCP の取り込み、#4 ギルド ID 自動判定、#3 setup-channel とフックの移植、
    #5 公式 Discord プラグインのフォーク（channel/、Apache-2.0）とプレゼンス統合、
    #6 スラッシュコマンド `/ctx` `/clear`、#7 ワークスペース用コマンド化、#8 公開準備、#9 ダンプ掃除

## 構成図の整理（version 変更なし、2026-09-15）

- #78 voice.sock を垂直 1 本・音声の線を折れ 1 回に（PR #79）
- #80 全部の矢印を箱の辺に垂直に出入りさせる（PR #81）
