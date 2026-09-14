#!/bin/bash
# setup-voice.sh — ボイスチャンネル対応（voice/）の導入スクリプト（discord-bot プラグイン同梱）
#
#   次を冪等に行う。何度実行しても、既にある分はスキップする。
#     1. whisper.cpp の導入（brew install whisper.cpp。whisper-server が入る）
#     2. 文字起こし用モデル 2 つを Hugging Face からダウンロード（~/.claude/discord-bot/models/）
#     3. ~/.claude/discord-bot/voice.json の雛形作成（無いときだけ）
#     4. voice/ での npm install（node_modules が無いときだけ）
#
#   モデルはリポジトリに入れない（#61 の設計判断）。
#
#   環境変数:
#     DISCORD_BOT_STATE_DIR  状態ファイルの置き場（既定 ~/.claude/discord-bot）
#     CLAUDE_PLUGIN_ROOT     プラグインのルート（既定 このスクリプトの一つ上のディレクトリ）
set -eu

state_dir="${DISCORD_BOT_STATE_DIR:-$HOME/.claude/discord-bot}"
models_dir="$state_dir/models"
voice_config="$state_dir/voice.json"

script_dir="$(cd "$(dirname "$0")" && pwd)"
plugin_root="${CLAUDE_PLUGIN_ROOT:-$(cd "$script_dir/.." && pwd)}"
voice_dir="$plugin_root/voice"

large_model_url="https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin"
vad_model_url="https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v5.1.2.bin"
large_model_file="$models_dir/ggml-large-v3-turbo-q5_0.bin"
vad_model_file="$models_dir/ggml-silero-v5.1.2.bin"

log() { printf '%s\n' "$*"; }

log "== discord-bot voice セットアップ =="

# 1. whisper.cpp
if command -v whisper-server >/dev/null 2>&1; then
  log "whisper-server は導入済み: $(command -v whisper-server)"
else
  log "whisper.cpp を Homebrew でインストールする（brew install whisper.cpp）"
  brew install whisper.cpp
fi

# 2. モデル
mkdir -p "$models_dir"

download_if_missing() {
  local url="$1" dest="$2"
  if [ -f "$dest" ]; then
    log "モデルは既にある: $dest"
    return 0
  fi
  log "モデルをダウンロードする: $dest"
  curl -L --fail -o "$dest.tmp" "$url"
  mv "$dest.tmp" "$dest"
}

download_if_missing "$large_model_url" "$large_model_file"
download_if_missing "$vad_model_url" "$vad_model_file"

# 3. voice.json
if [ -f "$voice_config" ]; then
  log "voice.json は既にある: $voice_config"
else
  log "voice.json の雛形を作成する: $voice_config"
  mkdir -p "$state_dir"
  cat > "$voice_config" <<JSON
{
  "whisper": {
    "binary": "whisper-server",
    "port": 8178,
    "model": "$large_model_file",
    "vadModel": "$vad_model_file",
    "language": "ja",
    "extraArgs": []
  },
  "vad": { "silenceMs": 700, "minSpeechMs": 300, "maxUtteranceS": 30 },
  "debug": { "saveWav": false }
}
JSON
fi

# 4. voice/ の依存関係
if [ -d "$voice_dir/node_modules" ]; then
  log "voice/node_modules は既にある"
else
  log "voice/ で npm install を実行する"
  (cd "$voice_dir" && npm install)
fi

log "セットアップが完了した"
