#!/bin/bash
# start-discord.sh — Discord セッション一式を tmux セッション "discord" で起動する（discord-bot プラグイン同梱）
#   DISCORD_BOT_CHANNEL_MODE=fork（既定）ならフォーク版を、official なら公式プラグインを channel にして起動する
#   （Bot のステータス表示は channel サーバーが担当するので常駐スクリプトは無い）
#
#   使い方: Discord セッションにしたいプロジェクトのディレクトリで実行する
#     start-discord.sh                       新規セッションで起動
#     start-discord.sh --resume <session-id> 会話を引き継いで起動（追加引数はそのまま claude に渡す）
#   環境変数: DISCORD_TMUX_SESSION（既定 discord）
#             DISCORD_STATE_DIR / DISCORD_BOT_STATE_DIR / DISCORD_GUILD_ID / DISCORD_TMUX_SESSION は claude にそのまま引き継がれる
#             （別 Bot を並行して動かすときはこれらを組で変える。README「複数インスタンスで動かす」。
#              DISCORD_TMUX_SESSION も渡すのは、/restart の補助スクリプトが同じ tmux セッションへ起動し直すため）
#   対象の tmux セッション内で --channels 付き claude がすでに動いていれば起動しない（二重に立つと Discord へ二重返信するため）。
#   別の tmux セッションで動いている claude は別インスタンスとみなして無視する
set -u
SESSION="${DISCORD_TMUX_SESSION:-discord}"
DIR="$PWD"
# channel（Discord との送受信）をどのプラグインに任せるか。
#   official        : 公式 discord@claude-plugins-official を --channels に渡す。フォーク版 channel サーバーは
#                    プレゼンス表示だけ担当し、スラッシュコマンドは止める（受け付けても Claude に届かないため）
#   fork（既定）    : フォーク版を --channels に渡す。Claude Code は公式以外の channel を既定で捨てるので、
#                    管理者設定 allowedChannelPlugins で承認しておく（README セットアップ 4）
MODE="${DISCORD_BOT_CHANNEL_MODE:-fork}"
# tmux の new-session / new-window で起動するコマンドは、呼び出し元のシェルではなく tmux サーバーの環境を引き継ぐ。
# 複数インスタンス用に export した DISCORD_* が claude に届くよう、コマンド文字列の頭に NAME=value の形で付けて渡す
ENV_PREFIX=""
for name in DISCORD_STATE_DIR DISCORD_BOT_STATE_DIR DISCORD_GUILD_ID DISCORD_BOT_STATUSLINE_DIR DISCORD_TMUX_SESSION; do
  if [ -n "${!name:-}" ]; then
    ENV_PREFIX="${ENV_PREFIX}${name}=$(printf '%q' "${!name}") "
  fi
done
# 置き場を指定して起動するときは、その置き場の .env をトークンの唯一の出どころにする。channel サーバーは環境変数の
# DISCORD_BOT_TOKEN を .env より優先するので、tmux サーバーの環境などに別インスタンスのトークンが残っていると乗っ取られる
if [ -n "${DISCORD_STATE_DIR:-}" ]; then
  ENV_PREFIX="env -u DISCORD_BOT_TOKEN ${ENV_PREFIX}"
fi
if [ "${MODE}" = "fork" ]; then
  # 管理者設定 allowedChannelPlugins で承認済みの前提。--channels で普通に渡す
  CLAUDE_CMD="${ENV_PREFIX}claude --channels plugin:discord-bot@ryuki-plugins $*"
else
  CLAUDE_CMD="${ENV_PREFIX}DISCORD_SLASH_COMMANDS=off claude --channels plugin:discord@claude-plugins-official $*"
fi

# 対象セッションのペイン直下のプロセス（ペイン自身と子）に --channels 付き claude がいるか
session_has_channels_claude() {
  local pane_pid pids
  for pane_pid in $(tmux list-panes -s -t "${SESSION}" -F '#{pane_pid}'); do
    pids="$( (echo "${pane_pid}"; pgrep -P "${pane_pid}" 2>/dev/null) | paste -sd, -)"
    if ps -o command= -p "${pids}" 2>/dev/null | grep -Eq 'claude.*(--channels|--dangerously-load-development-channels).*plugin:discord'; then
      return 0
    fi
  done
  return 1
}

if ! tmux has-session -t "${SESSION}" 2>/dev/null; then
  tmux new-session -d -s "${SESSION}" -n claude -c "${DIR}" "${CLAUDE_CMD}"
  echo "tmux セッション ${SESSION} を作成し、claude を起動しました（cwd: ${DIR}）"
elif session_has_channels_claude; then
  echo "claude（--channels）は tmux セッション ${SESSION} で起動済みです"
elif tmux list-panes -s -t "${SESSION}" -F '#{pane_pid}' | xargs -I{} pgrep -P {} -x claude 2>/dev/null | grep -q . \
  || tmux list-panes -s -t "${SESSION}" -F '#{pane_current_command}' | grep -Eq '^(claude|[0-9]+\.[0-9]+\.[0-9]+)$'; then
  echo "注意: tmux セッション ${SESSION} 内で claude は動いていますが --channels が付いていません。二重起動を避けるため何もしません"
  echo "      Discord に繋ぐには、その claude を終了してからもう一度このスクリプトを実行してください"
else
  tmux new-window -d -t "${SESSION}" -n claude -c "${DIR}" "${CLAUDE_CMD}"
  echo "claude を新しいウィンドウで起動しました（cwd: ${DIR}）"
fi

echo "--- windows ---"
tmux list-windows -t "${SESSION}" -F '  #{window_index}: #{window_name}  (#{pane_current_command})'
[ -z "${TMUX:-}" ] && echo "接続: tmux attach -t ${SESSION}"
exit 0
