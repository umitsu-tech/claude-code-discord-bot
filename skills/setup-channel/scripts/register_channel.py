#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.12"
# ///
"""
register_channel.py — 新しく作った Discord チャンネルの受信設定を access.json の groups に入れる

setup-channel スキルの「受信設定」を機械的に行う。触るのは groups[<チャンネルID>] だけ。

前提
  - channel サーバーはギルドのチャンネルの設定を groups[<チャンネルID>] → guilds[<ギルドID>] の順に引く。
    groups にエントリがあれば guilds の既定は使われない
  - groups のエントリの allowFrom が空なら、channel サーバーは送り主を確かめない（チャンネルにいる全員が通る）
  - create_channel（server-admin MCP）は作成直後に groups[<ID>] = {"requireMention": true,
    "allowFrom": <トップレベル allowFrom の写し>} を書く。以下これを「自動エントリ」と呼ぶ

guilds（ギルド単位の既定）があるとき（--ignore-guilds なし）
  - エントリが無ければ何もしない（SKIP。ギルドの既定で届く）
  - 自動エントリなら取り除く（残すとギルドの既定より優先されるため）
  - それ以外のエントリなら変えずに NG（持ち主が決めた設定かもしれないので、ユーザーに判断してもらう）
guilds が無いとき、または --ignore-guilds のとき
  - トップレベルの allowFrom が空なら登録せず NG。自動エントリがあれば取り除く
  - エントリが無ければ {"requireMention": false, "allowFrom": <トップレベル allowFrom の写し>} を追加する
  - エントリがあれば requireMention を false にする。そのエントリの allowFrom が空なら
    トップレベル allowFrom の写しにする（空のまま requireMention だけ外すと全員に開くため）

access.json の置き場は ${DISCORD_STATE_DIR:-~/.claude/channels/discord}。
同じディレクトリの一時ファイルに書いてから rename で置き換える（channel サーバーと同じやり方）。

使い方: register_channel.py <チャンネルID> [--dry-run] [--ignore-guilds]
出力は OK: / SKIP: / NG: のどれかで始まる 1 行（--dry-run では頭に DRY-RUN: が付き、書き込まない）。
終了コードは NG が 1、引数の誤りが 2、それ以外は 0。NG でも自動エントリを取り除いたときは書き込む。
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


def is_auto_entry(entry: object, top_allow_from: list) -> bool:
    """create_channel が自動で書いたエントリと同じ形か（requireMention: true とトップレベル allowFrom の写しだけ）"""
    return (
        isinstance(entry, dict)
        and set(entry) == {"requireMention", "allowFrom"}
        and entry["requireMention"] is True
        and entry["allowFrom"] == top_allow_from
    )


def dumps(value: object) -> str:
    return json.dumps(value, ensure_ascii=False)


def plan_with_guilds(groups: dict, channel_id: str, entry: dict | None, auto: bool, ids: str) -> tuple[str, str, bool]:
    if entry is None:
        message = (
            f"guilds にギルド単位の既定（{ids}）があるので groups には登録しない。"
            "新チャンネルがそのギルドにあれば既定の設定で届く。"
            "このチャンネルだけ受け方を変えるなら --ignore-guilds を付けて実行し直す"
        )
        return ("SKIP", message, False)
    if auto:
        del groups[channel_id]
        message = (
            f"create_channel が自動で作った groups の {channel_id}（{dumps(entry)}）を取り除いた。"
            f"残すとギルド単位の既定（{ids}）より優先されるため。新チャンネルがそのギルドにあれば既定の設定で届く"
        )
        return ("OK", message, True)
    message = (
        f"groups に {channel_id} のエントリ（{dumps(entry)}）があり、ギルド単位の既定（{ids}）より優先される。"
        "create_channel が自動で作った形ではないので変えない。"
        f"ギルドの既定に従わせるなら、ユーザーがターミナルで /discord-bot:access group rm {channel_id} を実行する。"
        "このチャンネルだけメンション無しで受けるなら --ignore-guilds を付けて実行し直す"
    )
    return ("NG", message, False)


def plan(data: dict, channel_id: str, ignore_guilds: bool) -> tuple[str, str, bool]:
    """(種別, メッセージ, 書き込みが要るか) を返す。書き込みが要るときは data を書き換えてある"""
    top = data.get("allowFrom")
    top_allow_from = top if isinstance(top, list) else []

    groups = data.setdefault("groups", {})
    if not isinstance(groups, dict):
        return ("NG", f"{ACCESS_JSON} の groups がオブジェクトではない", False)
    entry = groups.get(channel_id)
    if entry is not None and not isinstance(entry, dict):
        return ("NG", f"groups の {channel_id} がオブジェクトではない", False)
    auto = is_auto_entry(entry, top_allow_from)

    guilds = data.get("guilds")
    if isinstance(guilds, dict) and guilds and not ignore_guilds:
        return plan_with_guilds(groups, channel_id, entry, auto, ", ".join(guilds))

    if not top_allow_from:
        message = (
            f"{ACCESS_JSON} のトップレベル allowFrom が空なので登録しない（allowFrom が空のエントリはチャンネルにいる全員の投稿を通す）。"
            "先にターミナルで /discord-bot:access によるペアリングを済ませ、実行し直す"
        )
        if auto:
            del groups[channel_id]
            removed = f"create_channel が自動で作った groups の {channel_id}（{dumps(entry)}。メンションすれば誰でも届く状態）を取り除いた。"
            return ("NG", removed + message, True)
        return ("NG", message, False)

    if entry is None:
        groups[channel_id] = {"requireMention": False, "allowFrom": list(top_allow_from)}
        return (
            "OK",
            f"groups に {channel_id} を追加した（requireMention: false、allowFrom: {dumps(top_allow_from)}）",
            True,
        )

    changes = []
    if entry.get("requireMention") is not False:
        entry["requireMention"] = False
        changes.append("requireMention を false にした")
    entry_allow_from = entry.get("allowFrom")
    if not isinstance(entry_allow_from, list) or not entry_allow_from:
        entry["allowFrom"] = list(top_allow_from)
        changes.append(f"空だった allowFrom をトップレベルの写し（{dumps(top_allow_from)}）にした")
    if not changes:
        return ("OK", f"{channel_id} は登録済みで requireMention: false。変更なし", False)
    if len(changes) == 1 and changes[0].startswith("requireMention"):
        changes[0] += "（allowFrom は変えていない）"
    return ("OK", f"{channel_id} は登録済み。" + "。".join(changes), True)


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
    if needs_write and not args.dry_run:
        save_access(data)
    prefix = "DRY-RUN: 書き込みはしていない。実行すると次の結果になる → " if args.dry_run else ""
    line = f"{prefix}{kind}: {message}"
    if kind == "NG":
        print(line, file=sys.stderr)
        return 1
    print(line)
    return 0


if __name__ == "__main__":
    sys.exit(main())
