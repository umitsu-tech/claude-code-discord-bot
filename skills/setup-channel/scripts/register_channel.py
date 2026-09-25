#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.12"
# ///
"""
register_channel.py — 新しく作った Discord チャンネルの受信設定を access.json の groups に入れる

setup-channel スキルの「受信設定」を機械的に行う。触るのは groups[<チャンネルID>] だけ。

自動で直すのは、ギルド単位の既定（guilds）が無く、トップレベルの allowFrom に 1 人以上いる構成だけ。
  - エントリが無ければ {"requireMention": false, "allowFrom": <トップレベル allowFrom の写し>} を追加する
  - create_channel（server-admin MCP）が作成直後に書く形のエントリ（キーが requireMention と allowFrom だけで、
    requireMention が true、allowFrom がトップレベルと同じか空）なら、requireMention を false にし、
    allowFrom をトップレベルの写しにする
  - すでに {"requireMention": false, "allowFrom": <トップレベルと同じ>} なら何もしない（実行し直しても同じ結果）

それ以外（guilds がある、トップレベル allowFrom が空、エントリが上の形でない、など）では何も書かずに NG で止まる。
guilds の既定との関係や allowFrom の決め方は構成によって変わるので、ユーザーと access.json を見て手で決める。

access.json の置き場は ${DISCORD_STATE_DIR:-~/.claude/channels/discord}。書き込みは同じディレクトリの一時ファイルに
書いてから rename で置き換える（channel サーバーと同じやり方）。置き換える直前に access.json を読み直し、
読んだときから変わっていたら（channel サーバーやほかの操作が書いた）、何も書かずに NG で終わる。

使い方: register_channel.py <チャンネルID> [--dry-run]
出力は OK: か NG: で始まる 1 行（--dry-run では頭に DRY-RUN: が付き、書き込まない）。
終了コードは NG が 1、引数の誤りが 2、OK が 0。
"""

import argparse
import json
import os
import re
import sys
import tempfile

STATE_DIR = os.environ.get("DISCORD_STATE_DIR") or os.path.expanduser("~/.claude/channels/discord")
ACCESS_JSON = os.path.join(STATE_DIR, "access.json")


class ChangedError(Exception):
    """読んだあとに access.json が変わっていた"""


def read_raw() -> bytes | None:
    """access.json のバイト列。無ければ None"""
    try:
        with open(ACCESS_JSON, "rb") as f:
            return f.read()
    except FileNotFoundError:
        return None


def save_access(data: dict, read_as: bytes) -> None:
    """read_as は読んだときのバイト列。置き換える直前に読み直し、変わっていたら書かずに ChangedError"""
    fd, tmp = tempfile.mkstemp(prefix=".access.json.", suffix=".tmp", dir=STATE_DIR)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(json.dumps(data, indent=2, ensure_ascii=False) + "\n")
        os.chmod(tmp, 0o600)
        if read_raw() != read_as:
            raise ChangedError
        os.replace(tmp, ACCESS_JSON)
    except BaseException:
        if os.path.exists(tmp):
            os.remove(tmp)
        raise


def dumps(value: object) -> str:
    return json.dumps(value, ensure_ascii=False)


def plan(data: dict, channel_id: str) -> tuple[str, str, bool]:
    """(種別, メッセージ, 書き込みが要るか) を返す。書き込みが要るときは data を書き換えてある"""
    manual = "何も書き込んでいない。ユーザーと access.json を見て、このチャンネルの受け方を手で決める"
    guilds = data.get("guilds")
    if guilds:
        names = ", ".join(guilds) if isinstance(guilds, dict) else dumps(guilds)
        return ("NG", f"guilds にギルド単位の既定（{names}）がある構成は自動で直さない。{manual}", False)
    top = data.get("allowFrom")
    if not isinstance(top, list) or not top:
        return ("NG", f"トップレベルの allowFrom が空（まだ誰もペアリングしていない）。{manual}", False)
    groups = data.setdefault("groups", {})
    if not isinstance(groups, dict):
        return ("NG", f"groups がオブジェクトではない。{manual}", False)

    entry = groups.get(channel_id)
    if entry is None:
        groups[channel_id] = {"requireMention": False, "allowFrom": list(top)}
        return ("OK", f"groups に {channel_id} を追加した（requireMention: false、allowFrom: {dumps(top)}）", True)
    if entry == {"requireMention": False, "allowFrom": top}:
        return ("OK", f"{channel_id} は登録済み（requireMention: false、allowFrom はトップレベルと同じ）。変更なし", False)
    if (
        isinstance(entry, dict)
        and set(entry) == {"requireMention", "allowFrom"}
        and entry["requireMention"] is True
        and entry["allowFrom"] in (top, [])
    ):
        groups[channel_id] = {"requireMention": False, "allowFrom": list(top)}
        return ("OK", f"{channel_id} の requireMention を false にした（allowFrom: {dumps(top)}）", True)

    note = "。allowFrom が空で、送り主を確かめない状態" if isinstance(entry, dict) and not entry.get("allowFrom") else ""
    return (
        "NG",
        f"groups の {channel_id}（{dumps(entry)}{note}）が create_channel の書く形ではないので変えない。{manual}",
        False,
    )


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("channel_id", help="新しく作ったチャンネルの ID（フォーラムもチャンネル ID）")
    ap.add_argument("--dry-run", action="store_true", help="書き込まずに、何をするかだけ表示する")
    args = ap.parse_args()

    if not re.fullmatch(r"[0-9]+", args.channel_id):
        print(f"NG: チャンネル ID は数字で渡す（受け取った値: {args.channel_id}）", file=sys.stderr)
        return 2

    try:
        read_as = read_raw()
        if read_as is None:
            print(f"NG: {ACCESS_JSON} が無い。先にターミナルで /discord-bot:access のペアリングを済ませる", file=sys.stderr)
            return 1
        data = json.loads(read_as.decode("utf-8"))
        if not isinstance(data, dict):
            raise TypeError("トップレベルがオブジェクトではない")
    except (ValueError, TypeError, OSError) as e:
        print(f"NG: {ACCESS_JSON} を読めない（{e}）。ファイルを確かめる", file=sys.stderr)
        return 1

    kind, message, needs_write = plan(data, args.channel_id)
    if needs_write and not args.dry_run:
        try:
            save_access(data, read_as)
        except ChangedError:
            print(
                "NG: access.json が、読んでから書き込むまでの間に変わった（channel サーバーやほかの操作が書き込んだ）ので、"
                "何も書き込まなかった。もう一度実行する",
                file=sys.stderr,
            )
            return 1
    prefix = "DRY-RUN: 書き込みはしていない。実行すると次の結果になる → " if args.dry_run else ""
    line = f"{prefix}{kind}: {message}"
    if kind == "NG":
        print(line, file=sys.stderr)
        return 1
    print(line)
    return 0


if __name__ == "__main__":
    sys.exit(main())
