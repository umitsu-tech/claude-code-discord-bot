#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.12"
# ///
"""
register_channel.py — 新しく作った Discord チャンネルの受信設定を access.json の groups に入れる

setup-channel スキルの「受信設定」を機械的に行う。触るのは groups[<チャンネルID>] だけ。

前提
  - channel サーバーはギルドのチャンネルの設定を groups[<チャンネルID>] → guilds[<そのチャンネルのギルドID>]
    の順に引く。groups にエントリがあれば guilds の既定は使われない
  - groups のエントリの allowFrom が空なら、channel サーバーは送り主を確かめない。以下これを「開いたエントリ」と呼ぶ
  - create_channel（server-admin MCP）は作成直後に groups[<ID>] = {"requireMention": true,
    "allowFrom": <その時点のトップレベル allowFrom の写し>} を書く。以下これを「自動エントリ」と呼ぶ

このスクリプトは、開いたエントリを残したまま終わらない（トップレベル allowFrom の写しに狭めるか、取り除く）。

チャンネルのギルドに guilds の既定があるとき（--ignore-guilds なし）
  - エントリが無ければ何もしない（SKIP。既定の設定で届く）
  - 開いたエントリか、自動エントリ（トップレベル allowFrom と同じ写し）なら取り除く（残すと既定より優先されるため）
  - それ以外のエントリは変えずに NG（持ち主が決めた設定かもしれないので、ユーザーに判断してもらう）
それ以外（guilds が無い、別のギルドの既定しか無い、または --ignore-guilds）
  - トップレベル allowFrom が空なら登録せず NG。開いたエントリがあれば取り除く
  - エントリが無ければ {"requireMention": false, "allowFrom": <トップレベル allowFrom の写し>} を追加する
  - エントリがあれば requireMention を false にし、開いたエントリなら allowFrom をトップレベルの写しにする
チャンネルのギルドが分からないとき（guilds があるのに調べられない）
  - 開いたエントリがあれば取り除き、NG で --guild-id を付けた実行し直しを促す

チャンネルのギルド ID は、--guild-id → Discord API（GET /channels/<ID>）→ DISCORD_GUILD_ID の順に調べる。
Bot のトークンと DISCORD_GUILD_ID は、環境変数か ${DISCORD_STATE_DIR}/.env から読む（server-admin MCP と同じ順）。
guilds が空か --ignore-guilds のときは調べない（通信しない）。

access.json の置き場は ${DISCORD_STATE_DIR:-~/.claude/channels/discord}。
同じディレクトリの一時ファイルに書いてから rename で置き換える（channel サーバーと同じやり方）。

使い方: register_channel.py <チャンネルID> [--guild-id <ギルドID>] [--ignore-guilds] [--dry-run]
出力は OK: / SKIP: / NG: のどれかで始まる 1 行（--dry-run では頭に DRY-RUN: が付き、書き込まない）。
終了コードは NG が 1、引数の誤りが 2、それ以外は 0。NG でもエントリを取り除いたときは書き込む。
"""

import argparse
import json
import os
import re
import sys
import tempfile
import urllib.request

STATE_DIR = os.environ.get("DISCORD_STATE_DIR") or os.path.expanduser("~/.claude/channels/discord")
ACCESS_JSON = os.path.join(STATE_DIR, "access.json")
API_BASE = "https://discord.com/api/v10"
PLACEHOLDERS = {"", "your_bot_token_here", "your_guild_id_here"}


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


def read_setting(key: str) -> str:
    """環境変数、無ければ ${DISCORD_STATE_DIR}/.env から読む。未設定や雛形の値なら空文字"""
    value = os.environ.get(key, "")
    if not value:
        try:
            with open(os.path.join(STATE_DIR, ".env"), encoding="utf-8") as f:
                for line in f:
                    m = re.match(rf"^{key}=(.*)$", line.strip())
                    if m:
                        value = m.group(1).strip().strip("\"'")
                        break
        except OSError:
            pass
    return "" if value in PLACEHOLDERS else value


def fetch_channel_guild_id(channel_id: str, token: str) -> str:
    """Discord API でチャンネルが属するギルドの ID を調べる。失敗したら例外"""
    req = urllib.request.Request(
        f"{API_BASE}/channels/{channel_id}",
        headers={"Authorization": f"Bot {token}", "User-Agent": "discord-bot (Claude Code plugin)"},
    )
    with urllib.request.urlopen(req, timeout=15) as r:
        data = json.load(r)
    guild_id = str(data.get("guild_id") or "")
    if not re.fullmatch(r"[0-9]+", guild_id):
        raise ValueError("応答に guild_id が無い")
    return guild_id


def resolve_guild_id(channel_id: str, given: str | None) -> tuple[str | None, str]:
    """(ギルド ID, どこで分かったか) を返す。分からなければ (None, 理由)"""
    if given:
        return (given, "--guild-id")
    reason = "Bot のトークンが無いので Discord API で調べられない"
    token = read_setting("DISCORD_BOT_TOKEN")
    if token:
        try:
            return (fetch_channel_guild_id(channel_id, token), "Discord API")
        except Exception as e:  # noqa: BLE001  通信・HTTP・応答のどの失敗でも次の手段へ進む
            reason = f"Discord API で調べられない（{type(e).__name__}: {e}）"
    env_guild_id = read_setting("DISCORD_GUILD_ID")
    if env_guild_id:
        return (env_guild_id, "DISCORD_GUILD_ID")
    return (None, reason)


def is_open(entry: dict) -> bool:
    """allowFrom が空（または無い・配列でない）なら、channel サーバーは送り主を確かめない"""
    allow_from = entry.get("allowFrom")
    return not isinstance(allow_from, list) or not allow_from


def is_auto_entry(entry: dict, top_allow_from: list) -> bool:
    """create_channel が今のトップレベル allowFrom で書いたエントリと同じ形か"""
    return (
        set(entry) == {"requireMention", "allowFrom"}
        and entry["requireMention"] is True
        and entry["allowFrom"] == top_allow_from
    )


def dumps(value: object) -> str:
    return json.dumps(value, ensure_ascii=False)


def describe(channel_id: str, entry: dict) -> str:
    note = "。allowFrom が空で、メンションすれば誰でも届く状態" if is_open(entry) else ""
    return f"groups の {channel_id}（{dumps(entry)}{note}）"


def plan_guild_default(groups: dict, channel_id: str, entry: dict | None, top: list, where: str) -> tuple[str, str, bool]:
    """チャンネルのギルドに guilds の既定があるとき"""
    if entry is None:
        message = (
            f"{where}には guilds の既定があるので、groups には登録しない（既定の設定で届く）。"
            "このチャンネルだけ受け方を変えるなら --ignore-guilds を付けて実行し直す"
        )
        return ("SKIP", message, False)
    if is_open(entry) or is_auto_entry(entry, top):
        del groups[channel_id]
        message = f"{describe(channel_id, entry)}を取り除いた。残すと{where}の guilds の既定より優先されるため。既定の設定で届く"
        return ("OK", message, True)
    message = (
        f"{describe(channel_id, entry)}があり、{where}の guilds の既定より優先される。"
        "create_channel が自動で作った形ではないので変えない。"
        f"既定に従わせるなら、ユーザーがターミナルで /discord-bot:access group rm {channel_id} を実行する。"
        "このチャンネルだけメンション無しで受けるなら --ignore-guilds を付けて実行し直す"
    )
    return ("NG", message, False)


def plan_unknown_guild(groups: dict, channel_id: str, entry: dict | None, reason: str) -> tuple[str, str, bool]:
    """guilds があるのに、チャンネルのギルドが分からないとき"""
    message = (
        f"guilds に既定があるが、このチャンネルのギルドが分からないので登録しない（{reason}）。"
        "--guild-id <ギルドID> を付けて実行し直す"
    )
    if entry is not None and is_open(entry):
        del groups[channel_id]
        return ("NG", f"{describe(channel_id, entry)}を取り除いた。{message}", True)
    return ("NG", message, False)


def plan_channel(groups: dict, channel_id: str, entry: dict | None, top: list, prefix: str) -> tuple[str, str, bool]:
    """groups に個別に登録するとき"""
    if not top:
        message = (
            f"{ACCESS_JSON} のトップレベル allowFrom が空なので登録しない（allowFrom が空のエントリはチャンネルにいる全員の投稿を通す）。"
            "先にターミナルで /discord-bot:access によるペアリングを済ませ、実行し直す"
        )
        if entry is not None and is_open(entry):
            del groups[channel_id]
            return ("NG", f"{prefix}{describe(channel_id, entry)}を取り除いた。{message}", True)
        return ("NG", prefix + message, False)

    if entry is None:
        groups[channel_id] = {"requireMention": False, "allowFrom": list(top)}
        return ("OK", f"{prefix}groups に {channel_id} を追加した（requireMention: false、allowFrom: {dumps(top)}）", True)

    changes = []
    if entry.get("requireMention") is not False:
        entry["requireMention"] = False
        changes.append("requireMention を false にした")
    if is_open(entry):
        entry["allowFrom"] = list(top)
        changes.append(f"空だった allowFrom をトップレベルの写し（{dumps(top)}）にした")
    if not changes:
        return ("OK", f"{prefix}{channel_id} は登録済みで requireMention: false。変更なし", False)
    if len(changes) == 1 and changes[0].startswith("requireMention"):
        changes[0] += "（allowFrom は変えていない）"
    return ("OK", f"{prefix}{channel_id} は登録済み。" + "。".join(changes), True)


def plan(data: dict, channel_id: str, ignore_guilds: bool, given_guild_id: str | None) -> tuple[str, str, bool]:
    """(種別, メッセージ, 書き込みが要るか) を返す。書き込みが要るときは data を書き換えてある"""
    top_raw = data.get("allowFrom")
    top = top_raw if isinstance(top_raw, list) else []

    groups = data.setdefault("groups", {})
    if not isinstance(groups, dict):
        return ("NG", f"{ACCESS_JSON} の groups がオブジェクトではない", False)
    entry = groups.get(channel_id)
    if entry is not None and not isinstance(entry, dict):
        return ("NG", f"groups の {channel_id} がオブジェクトではない", False)

    guilds = data.get("guilds")
    if not isinstance(guilds, dict) or not guilds or ignore_guilds:
        return plan_channel(groups, channel_id, entry, top, "")

    guild_id, source = resolve_guild_id(channel_id, given_guild_id)
    if guild_id is None:
        return plan_unknown_guild(groups, channel_id, entry, source)
    if guild_id in guilds:
        return plan_guild_default(groups, channel_id, entry, top, f"このチャンネルのギルド（{guild_id}、{source} で確認）")
    prefix = (
        f"guilds にあるのは別のギルド（{', '.join(guilds)}）の既定で、このチャンネルのギルド（{guild_id}、{source} で確認）"
        "には無いので、groups に個別に登録する手順で進める。"
    )
    return plan_channel(groups, channel_id, entry, top, prefix)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("channel_id", help="新しく作ったチャンネルの ID（フォーラムもチャンネル ID）")
    ap.add_argument("--guild-id", help="チャンネルが属するギルドの ID（Discord API で調べられないとき）")
    ap.add_argument("--ignore-guilds", action="store_true", help="guilds に既定があっても groups に個別に登録する")
    ap.add_argument("--dry-run", action="store_true", help="書き込まずに、何をするかだけ表示する")
    args = ap.parse_args()

    for label, value in (("チャンネル ID", args.channel_id), ("ギルド ID", args.guild_id)):
        if value is not None and not re.fullmatch(r"[0-9]+", value):
            print(f"NG: {label} は数字で渡す（受け取った値: {value}）", file=sys.stderr)
            return 2

    try:
        data = load_access()
    except (ValueError, TypeError, OSError) as e:
        print(f"NG: {ACCESS_JSON} を読めない（{e}）。ファイルを確かめる", file=sys.stderr)
        return 1

    kind, message, needs_write = plan(data, args.channel_id, args.ignore_guilds, args.guild_id)
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
