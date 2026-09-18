#!/bin/bash
# restart-helper.sh — Discord からの /restart を受けて、claude の終了を待ってから起動し直す裏方
#   （discord-bot プラグイン同梱。channel/session-control.ts が親から切り離して起動する）
#
#   claude が終わると channel サーバー（claude の子プロセス）も一緒に死ぬので、
#   「終了待ち → claude update → 起動し直し」は claude の外にいるこのスクリプトが担当する。
#
#   引数は環境変数で受け取る:
#     RESTART_CLAUDE_PID     終了を待つ claude のプロセス ID（必須）
#     RESTART_PANE           claude が動いている tmux ペインの ID（必須。%12 のような形）
#     RESTART_CWD            起動し直すときの作業ディレクトリ（必須）
#     RESTART_CHAT_ID        依頼元の Discord チャンネル ID（完了通知・失敗通知に使う）
#     RESTART_RESUME_SESSION 空でなければ --resume <id> を付けて起動する
#     RESTART_MODE           DISCORD_BOT_CHANNEL_MODE に渡す値（既定 fork）
#     RESTART_LAUNCHER       起動に使うランチャー（既定 このスクリプトと同じディレクトリの start-discord.sh）
#     DISCORD_BOT_STATE_DIR  状態ファイルの置き場（既定 ~/.claude/discord-bot）
#     DISCORD_BOT_TOKEN      失敗通知を Discord へ投げるためのトークン（無ければ通知しない）
#     DISCORD_TMUX_SESSION   ランチャーへそのまま引き継ぐ
#   待ち時間（動作確認用に短縮できる）:
#     RESTART_POLL_SEC       終了確認の間隔（既定 1）
#     RESTART_NUDGE_SEC      C-c と /exit を送り直すまでの秒数（既定 90）
#     RESTART_GIVEUP_SEC     諦めるまでの秒数（既定 180）
#     RESTART_UPDATE_TIMEOUT_SEC  claude update を打ち切るまでの秒数（既定 180）
#
#   標準出力・標準エラーは呼び出し側が ~/.claude/discord-bot/restart.log へ追記モードで繋いでいる。
set -u
# 切り離して起動されるので PATH は最小限しか無い。claude と tmux が居る場所を足す
PATH="$HOME/.local/bin:/opt/homebrew/bin:$PATH"

state_dir="${DISCORD_BOT_STATE_DIR:-$HOME/.claude/discord-bot}"
pid="${RESTART_CLAUDE_PID:-}"
pane="${RESTART_PANE:-}"
cwd="${RESTART_CWD:-}"
chat_id="${RESTART_CHAT_ID:-}"
resume_session="${RESTART_RESUME_SESSION:-}"
mode="${RESTART_MODE:-fork}"
launcher="${RESTART_LAUNCHER:-$(cd "$(dirname "$0")" && pwd)/start-discord.sh}"
poll="${RESTART_POLL_SEC:-1}"
nudge_at="${RESTART_NUDGE_SEC:-90}"
giveup_at="${RESTART_GIVEUP_SEC:-180}"
update_timeout="${RESTART_UPDATE_TIMEOUT_SEC:-180}"
requested_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }

# Discord への通知は失敗時だけ。成功時の通知は起動し直した channel サーバーが投稿する
post_discord() {
  if [ -z "${DISCORD_BOT_TOKEN:-}" ] || [ -z "$chat_id" ]; then
    log "  Discord への通知は省略（トークンかチャンネル ID が無い）"
    return 0
  fi
  local code
  code=$(curl -sS -o /dev/null -w '%{http_code}' -X POST \
    -H "Authorization: Bot ${DISCORD_BOT_TOKEN}" \
    -H "Content-Type: application/json" \
    --data "{\"content\":\"$1\"}" \
    "https://discord.com/api/v10/channels/${chat_id}/messages" 2>&1)
  log "  Discord へ通知: http ${code}"
}

mkdir -p "$state_dir"
log "restart-helper 開始: pid=${pid} pane=${pane} cwd=${cwd} chat_id=${chat_id:-none} resume=${resume_session:-none} mode=${mode}"

if [ -z "$pid" ] || [ -z "$pane" ] || [ -z "$cwd" ]; then
  log "NG: RESTART_CLAUDE_PID / RESTART_PANE / RESTART_CWD が足りない"
  exit 2
fi

# 1. claude が終わるのを待つ。途中で C-c と /exit を送り直し、それでも駄目なら諦める
waited=0
nudged=0
while kill -0 "$pid" 2>/dev/null; do
  if [ "$waited" -ge "$giveup_at" ]; then
    log "NG: ${giveup_at} 秒たっても claude (pid ${pid}) が終了しないので再起動を中止する"
    post_discord "claude が終了しないので再起動を中止したよ。ターミナルで確認してね。"
    exit 1
  fi
  if [ "$nudged" -eq 0 ] && [ "$waited" -ge "$nudge_at" ]; then
    log "${nudge_at} 秒たっても終了しないので C-c と /exit を送り直す"
    tmux send-keys -t "$pane" C-c
    sleep 1
    tmux send-keys -t "$pane" -l '/exit'
    sleep 0.3
    tmux send-keys -t "$pane" Enter
    nudged=1
    waited=$((waited + 1))
  fi
  sleep "$poll"
  waited=$((waited + poll))
done
log "claude (pid ${pid}) が終了した（待ち ${waited} 秒）"

# 2. claude update。終了コードの意味が公開されていないので、失敗しても起動し直しへ進む
claude_version() { claude --version 2>/dev/null | awk '{print $1}'; }
old_version="$(claude_version)"
log "更新前のバージョン: ${old_version:-不明}"
log "claude update を実行する（最大 ${update_timeout} 秒）"
claude update &
update_pid=$!
waited=0
while kill -0 "$update_pid" 2>/dev/null && [ "$waited" -lt "$update_timeout" ]; do
  sleep 1
  waited=$((waited + 1))
done
if kill -0 "$update_pid" 2>/dev/null; then
  log "claude update が ${update_timeout} 秒で終わらないので打ち切る"
  kill "$update_pid" 2>/dev/null
else
  wait "$update_pid"
  log "claude update 終了（exit $?）"
fi
new_version="$(claude_version)"
log "更新後のバージョン: ${new_version:-不明}"

# 3. 完了通知のマーカー。起動し直した channel サーバーが ready 時に読んで投稿し、消す
resumed=false
[ -n "$resume_session" ] && resumed=true
cat > "$state_dir/restart-done.json" <<EOF
{"chat_id":"${chat_id}","old_version":"${old_version}","new_version":"${new_version}","resumed":${resumed},"requested_at":"${requested_at}"}
EOF
log "マーカーを書いた: $state_dir/restart-done.json"

# 4. 元の場所で起動し直す。tmux セッションを作るか新しいウィンドウにするかはランチャーが判断する
if [ ! -x "$launcher" ]; then
  log "NG: ランチャーが実行できない（${launcher}）"
  post_discord "再起動しようとしたけどランチャーを実行できなかったよ。ターミナルで確認してね。"
  exit 1
fi
cd "$cwd" || {
  log "NG: 作業ディレクトリへ移動できない（${cwd}）"
  post_discord "再起動しようとしたけど元のディレクトリへ移動できなかったよ。ターミナルで確認してね。"
  exit 1
}
# このスクリプトは claude の子孫として起動されているので、claude 由来の環境変数（CLAUDECODE、CLAUDE_CODE_* など）と
# 元のペインの TMUX / TMUX_PANE を引き継いでいる。tmux サーバーが一度消えていると新しい claude にそのまま渡るので外す。
# DISCORD_BOT_TOKEN（失敗通知用）も同様に外す。残すと新しい tmux サーバーのグローバル環境に入り、以後 tmux で起動する
# 別インスタンスまでこの Bot のトークンで接続してしまう（channel サーバーは環境変数のトークンを .env より優先する）
for v in $(env | grep -E '^(CLAUDE|TMUX|MCP_|DISCORD_BOT_TOKEN=)' | cut -d= -f1); do unset "$v"; done
log "ランチャーを実行する: ${launcher} ${resume_session:+--resume $resume_session}（cwd: ${cwd}, mode: ${mode}）"
if [ -n "$resume_session" ]; then
  DISCORD_BOT_CHANNEL_MODE="$mode" "$launcher" --resume "$resume_session"
else
  DISCORD_BOT_CHANNEL_MODE="$mode" "$launcher"
fi
log "ランチャー終了（exit $?）"
