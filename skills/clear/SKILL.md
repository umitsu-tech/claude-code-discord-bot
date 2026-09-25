---
name: clear
description: このセッションが動いている tmux ペインへ /clear を送り、ターンが終わったところでコンテキストを空にする。Discord のメッセージでは組み込みの /clear が実行されないので、その代わりに使う。ターミナルで直接 /clear できるときは要らない
when_to_use: Discord で「/clear」「クリアして」「コンテキストをリセットして」「新しいセッションにして」と頼まれたとき
user-invocable: true
argument-hint: ""
allowed-tools:
  - Bash(${CLAUDE_PLUGIN_ROOT}/skills/ctx/scripts/context_usage.py *)
  - Bash(${CLAUDE_PLUGIN_ROOT}/skills/ctx/scripts/context_usage.py)
  - Bash(${CLAUDE_SKILL_DIR}/scripts/clear_session.sh *)
  - mcp__plugin_discord-bot_discord__reply
---

# Discord からの /clear

channel 経由のメッセージは Claude への入力テキストとして届くだけで、/clear のような組み込みコマンドは実行されない（公式は未対応。anthropics/claude-code#37342）。そこで、このセッションが動いている tmux ペインへ `tmux send-keys` で `/clear` と Enter を送る。/clear はターンの途中に送ってもキューに入り、このターンが終わった直後に実行される。

## 手順

1. 今の使用量を調べる。失敗しても先へ進む

   ```bash
   ${CLAUDE_PLUGIN_ROOT}/skills/ctx/scripts/context_usage.py
   ```

2. これからクリアすることを Discord に reply する。例「コンテキストをクリアするね（今 54%、544K tokens）。終わったらこのチャンネルに知らせるよ」
3. 進めている作業に、まだ保存していない要点（台帳や設計メモに書くこと）があれば、ここで保存する。クリアしたあとには引き継がれない
4. /clear を送る。`--chat-id` には、届いた `<channel>` タグの `chat_id` を渡す（完了通知の宛先になる）

   ```bash
   ${CLAUDE_SKILL_DIR}/scripts/clear_session.sh --chat-id <chat_id>
   ```

5. 出力の頭で分ける
   - `OK:` なら、ほかのツールを呼ばずに短く終える。ターンが終わると /clear が走り、新しいセッションの SessionStart フック（このプラグインの `hooks/notify-clear-done.py`）が Discord へ「クリアしたよ」を投稿する
   - `NG:` なら、その理由（tmux の外で動いている、端末の無いリモートセッションなど）を Discord に伝える。その場合はユーザーがターミナルで /clear するしかない

## 仕組みと制約

- 送り先は、`CLAUDE_PID` → そのプロセスの TTY → 同じ TTY を持つ tmux ペイン、の順に特定する。Discord セッションは tmux の中で `claude --channels plugin:discord-bot@ryuki-plugins` として動かす前提で、`scripts/start-discord.sh` がそのように起動する
- /clear のあともプロセスと MCP の接続（Discord とのやりとり）はそのまま残り、セッション ID だけが新しくなる
- 完了通知はフックが出すので、プラグインを入れ替えたあとは Discord セッションの再起動が要る
- ターミナルで手動で /clear したときは通知しない。通知のきっかけになるマーカー（`${DISCORD_BOT_STATE_DIR:-~/.claude/discord-bot}/pending-clear.json`）が無いため
- /compact は扱わない
