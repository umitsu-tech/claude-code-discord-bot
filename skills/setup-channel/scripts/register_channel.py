#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.12"
# ///
"""
register_channel.py — 新しく作った Discord チャンネルを access.json の groups に登録する

setup-channel スキルの「受信設定」を機械的に行う。書き換えるのは groups[<チャンネルID>] だけ。
  - エントリが無ければ {"requireMention": false, "allowFrom": <トップレベル allowFrom の写し>} を追加する
  - エントリがあれば requireMention だけを false にする（allowFrom は変えない）
  - トップレベルの allowFrom が空なら何も書かずに NG で終わる（空の allowFrom はチャンネルの全員を通すため）
  - guilds（ギルド単位の既定）があるときは何も書かずに SKIP で終わる（--ignore-guilds で登録する）

access.json の置き場は ${DISCORD_STATE_DIR:-~/.claude/channels/discord}。
同じディレクトリの一時ファイルに書いてから rename で置き換える（channel サーバーと同じやり方）。

使い方: register_channel.py <チャンネルID> [--dry-run] [--ignore-guilds]
出力は OK: / SKIP: / NG: / DRY-RUN: のどれかで始まる 1 行。終了コードは NG が 1、引数の誤りが 2、それ以外は 0。
"""

import argparse
import json
import os
import re
import sys
import tempfile

STATE_DIR = os.environ.get("DISCORD_STATE_DIR") or os.path.expanduser("~/.claude/channels/discord")
ACCESS_JSON = os.path.join(STATE_DIR, "access.json")


def load_access() -> dict:
    """access.json を読む。無ければ空の dict。壊れていれば ValueError か TypeError"""
    try:
        with open(ACCESS_JSON, encoding="utf-8") as f:
            data = json.load(f)
    except FileNotFoundError:
        return {}
    if not isinstance(data, dict):
        raise TypeError("トップレベルがオブジェクトではない")
    return data


def save_access(data: dict) -> None:
    fd, tmp = tempfile.mkstemp(prefix=".access.json.", suffix=".tmp", dir=STATE_DIR)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(json.dumps(data, indent=2, ensure_ascii=False) + "\n")
        os.chmod(tmp, 0o600)
        os.replace(tmp, ACCESS_JSON)
    except BaseException:
        if os.path.exists(tmp):
            os.remove(tmp)
        raise


def plan(data: dict, channel_id: str, ignore_guilds: bool) -> tuple[str, str, bool]:
    """(種別, メッセージ, 書き込みが要るか) を返す。data は書き込みが要るときだけ書き換える"""
    allow_from = data.get("allowFrom")
    if not isinstance(allow_from, list) or not allow_from:
        message = (
            f"{ACCESS_JSON} のトップレベル allowFrom が空なので登録しない（空の allowFrom はチャンネルにいる全員の投稿を通す）。"
            "先にターミナルで /discord-bot:access によるペアリングを済ませる"
        )
        return ("NG", message, False)

    groups = data.setdefault("groups", {})
    if not isinstance(groups, dict):
        return ("NG", f"{ACCESS_JSON} の groups がオブジェクトではない", False)
    entry = groups.get(channel_id)
    if entry is not None and not isinstance(entry, dict):
        return ("NG", f"groups の {channel_id} がオブジェクトではない", False)

    guilds = data.get("guilds")
    if isinstance(guilds, dict) and guilds and not ignore_guilds:
        ids = ", ".join(guilds)
        if entry is None:
            message = (
                f"guilds にギルド単位の既定（{ids}）があるので groups には登録しない。"
                "新チャンネルがそのギルドにあれば既定の設定で届く。"
                "このチャンネルだけ受け方を変えるなら --ignore-guilds を付けて実行し直す"
            )
        else:
            message = (
                f"guilds にギルド単位の既定（{ids}）があるので変更しない。"
                f"groups には {channel_id} のエントリ（requireMention: {json.dumps(entry.get('requireMention'))}）があり、"
                "ギルドの既定より優先される。このチャンネルをメンション無しで受けるなら --ignore-guilds を付けて実行し直す"
            )
        return ("SKIP", message, False)

    if entry is None:
        groups[channel_id] = {"requireMention": False, "allowFrom": list(allow_from)}
        return (
            "OK",
            f"groups に {channel_id} を追加した（requireMention: false、allowFrom: {json.dumps(allow_from, ensure_ascii=False)}）",
            True,
        )
    if entry.get("requireMention") is False:
        return ("OK", f"{channel_id} は登録済みで requireMention: false。変更なし", False)
    entry["requireMention"] = False
    return ("OK", f"{channel_id} は登録済み。requireMention を false にした（allowFrom は変えていない）", True)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("channel_id", help="新しく作ったチャンネルの ID（フォーラムもチャンネル ID）")
    ap.add_argument("--dry-run", action="store_true", help="書き込まずに、何をするかだけ表示する")
    ap.add_argument("--ignore-guilds", action="store_true", help="guilds に既定があっても groups に登録する")
    args = ap.parse_args()

    if not re.fullmatch(r"[0-9]+", args.channel_id):
        print(f"NG: チャンネル ID は数字で渡す（受け取った値: {args.channel_id}）", file=sys.stderr)
        return 2

    try:
        data = load_access()
    except (ValueError, TypeError, OSError) as e:
        print(f"NG: {ACCESS_JSON} を読めない（{e}）。ファイルを確かめる", file=sys.stderr)
        return 1

    kind, message, needs_write = plan(data, args.channel_id, args.ignore_guilds)
    if kind == "NG":
        print(f"NG: {message}", file=sys.stderr)
        return 1
    if args.dry_run:
        print(f"DRY-RUN: 書き込みはしていない。実行すると次の結果になる → {kind}: {message}")
        return 0
    if needs_write:
        save_access(data)
    print(f"{kind}: {message}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
