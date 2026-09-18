#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.12"
# ///
"""
remind-channel-access.py — PostToolUse(create_channel) フック

チャンネル作成直後、access.json の受信設定（requireMention / allowFrom）を忘れずに
登録するよう注意書きを additionalContext として注入する。access.json のトップレベル
allowFrom を読んで文面に埋め込む（値が読めなくても落とさず、空欄の文面を出す）。
"""

import json
import os
import sys

DISCORD_STATE_DIR = os.environ.get("DISCORD_STATE_DIR") or os.path.expanduser("~/.claude/channels/discord")
ACCESS_JSON = os.path.join(DISCORD_STATE_DIR, "access.json")


def load_access() -> dict:
    try:
        with open(ACCESS_JSON) as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except Exception:  # noqa: BLE001
        return {}


def load_allow_from(data: dict) -> str:
    allow_from = data.get("allowFrom")
    if isinstance(allow_from, list) and allow_from:
        return json.dumps(allow_from, ensure_ascii=False)
    return ""


def main() -> int:
    try:
        json.load(sys.stdin)
    except Exception:  # noqa: BLE001
        pass

    data = load_access()
    allow_from = load_allow_from(data)
    guilds = data.get("guilds")
    if isinstance(guilds, dict) and guilds:
        # ギルド単位の既定があれば、個別登録が無くてもその設定で届く
        message = (
            "Discordチャンネルを作成した直後です。"
            f"{ACCESS_JSON} にはギルド単位の既定受信設定（guilds: {', '.join(guilds)}）があるので、"
            "新チャンネルがそのギルドにあれば個別の受信設定は不要です（既定は requireMention の値に従う。"
            "このチャンネルだけ挙動を変えたいときだけ groups に個別登録する）。"
            "(1) プロジェクトの CLAUDE.md や台帳にチャンネル一覧・構成表があれば更新する。"
            "(2) ユーザーにテスト投稿してもらい受信を確認する（requireMention: true ならメンション付きで）。"
        )
        print(json.dumps({"hookSpecificOutput": {"hookEventName": "PostToolUse", "additionalContext": message}}))
        return 0

    message = (
        "Discordチャンネルを作成した直後です。必ず次を実施してください: "
        f"(1) {ACCESS_JSON} の groups に新チャンネルIDを "
        f"requireMention: false / allowFrom: {allow_from or '[]'} "
        "（access.json のトップレベル allowFrom の値をそのまま使う）で登録する"
        "（自動生成済みエントリが requireMention: true なら false に修正）。"
        "怠るとメンション無しの投稿がClaudeに届きません。"
        "(2) プロジェクトの CLAUDE.md や台帳にチャンネル一覧・構成表があれば更新する。"
        "(3) ユーザーにテスト投稿してもらい受信を確認する。"
        "詳細手順: setup-channel スキル"
    )

    print(json.dumps({"hookSpecificOutput": {"hookEventName": "PostToolUse", "additionalContext": message}}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
