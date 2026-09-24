---
name: ctx
description: 今のセッションのコンテキスト使用率（ctx）と利用上限の使用率（5h / 7d）を同梱スクリプトで調べて返す。Discord からの依頼なら reply で返し、ターミナルから呼ばれたらその場で答える
when_to_use: 「/ctx」「/context」「コンテキストどれくらい？」「残り容量は」のように、コンテキストの残りや使用量を聞かれたとき
user-invocable: true
argument-hint: ""
effort: low
allowed-tools:
  - Bash(${CLAUDE_SKILL_DIR}/scripts/context_usage.py *)
  - Bash(${CLAUDE_SKILL_DIR}/scripts/context_usage.py)
  - mcp__plugin_discord-bot_discord__reply
---

# コンテキスト使用量の確認

Discord セッションは 1 つのセッションを開いたまま使うので、コンテキストの残りを Discord から確かめられるようにする。値はターミナル下部のステータスラインと同じ。

## 手順

1. 次を実行する。引数は要らない（セッション ID は環境変数 `CLAUDE_CODE_SESSION_ID` から取る）

   ```bash
   ${CLAUDE_SKILL_DIR}/scripts/context_usage.py
   ```

2. Discord からの依頼なら、出力をそのままコードブロックに入れて reply する。前置きは付けない。コードブロックに入れるのは、Discord が行頭の記号をリスト表示に変えて崩すため
3. `ctx` が 80% 以上なら、「区切りのいいところで /clear しようか」と一言添える
4. ターミナルから呼ばれたときは reply せず、出力をそのまま答える

## 数値の意味

- `ctx`: コンテキストウィンドウの使用率。直前の API 応答の時点の入力トークン（キャッシュを含む）をウィンドウ幅で割ったもの
- `5h` / `7d`: 利用上限の使用率と、リセットの時刻（JST）
- `source statusline`: ステータスラインが保存した JSON から読んだ値。ターミナルの表示と同じ
- `source transcript`: ステータスラインの JSON が無いときの代わり。会話ログの usage から概算し、ウィンドウ幅は settings.json の model から推定する（`[1m]` なら 1M）。5h / 7d は出ない

## 失敗したとき

「使用量データが見つかりません」と出たら、まだ API の応答が 1 回も無い新しいセッションか、ステータスラインの JSON を保存する設定が無い環境。1 ターン進めてから実行し直すか、README のセットアップ（ステータスラインの JSON を保存する手順）を確かめるよう伝える。
