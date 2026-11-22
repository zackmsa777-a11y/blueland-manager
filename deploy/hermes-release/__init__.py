"""BlueLand releases for the Hermes Discord gateway."""
import hashlib
import json
import os
from pathlib import Path
import re
import socket
import sqlite3
import subprocess
import time
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

ROOT = Path("/var/lib/blueland-releases")
REPO = "zackmsa777-a11y/blueland-manager"
WEB = "https://github.com/" + REPO
SHA = re.compile(r"[0-9a-f]{40}")
GAME_FILES = {"src/discord-games.js", "src/game-rules.js", "src/game-view.js", "src/game-card.js", "test/games.test.js"}
PHASES = {"checking":"فحص", "testing":"اختبار", "activating":"تفعيل", "live":"منشور",
          "current":"محدّث", "failed":"فشل", "rolled_back":"تراجع", "rollback_failed":"تعذّر التراجع"}


def github(resource):
    request = Request("https://api.github.com/repos/" + REPO + resource,
                      headers={"Accept":"application/vnd.github+json","User-Agent":"BlueLand-Release"})
    with urlopen(request, timeout=10) as response:
        return json.load(response)


def status(revision=""):
    live = (ROOT / "current").resolve(strict=True).name
    if not SHA.fullmatch(live):
        raise ValueError("تعذّر تحديد الإصدار الشغّال.")
    receipt = json.loads((ROOT / "status.json").read_text())
    data = {"live":live, "last_operation":receipt["phase"], "last_target":receipt["target"].strip(),
            "updated":receipt["updated"]}
    if revision:
        if not re.fullmatch(r"[0-9a-f]{7,40}", revision):
            raise ValueError("استخدم معرّف Git من ٧ إلى ٤٠ خانة.")
        data["revision"] = revision
        if live.startswith(revision):
            data["included_in_live"] = True
        else:
            try:
                compare = github(f"/compare/{revision}...{live}?per_page=1")
                data["included_in_live"] = compare["status"] in ("ahead","identical")
            except (HTTPError, URLError, TimeoutError):
                data["included_in_live"] = None
    return data


def reviews():
    db = sqlite3.connect(Path(os.environ["HERMES_HOME"]) / "blueland-reviews.sqlite", timeout=5)
    db.execute("CREATE TABLE IF NOT EXISTS reviews (room TEXT PRIMARY KEY,base TEXT,head TEXT,expires INTEGER)")
    db.execute("CREATE TABLE IF NOT EXISTS game_files (room TEXT,path TEXT,base TEXT,content TEXT,PRIMARY KEY(room,path))")
    db.execute("CREATE TABLE IF NOT EXISTS game_reviews (room TEXT PRIMARY KEY,head TEXT)")
    return db


def operator(platform, actor, room):
    allowed = os.environ.get("DISCORD_ALLOWED_USERS","").split(",")
    if platform != "discord" or actor not in allowed or not room.isdecimal():
        raise ValueError("النشر متاح للحسابين المخوّلين في ديسكورد.")


def publisher(action, room, base, **payload):
    with socket.socket(socket.AF_UNIX) as conn:
        conn.settimeout(210)
        conn.connect("/run/blueland-games.sock")
        conn.sendall(json.dumps(dict(action=action, room=room, base=base, **payload), ensure_ascii=False).encode() + b"\n")
        with conn.makefile("rb") as stream:
            result = json.loads(stream.readline(32000))
    if "error" in result:
        raise ValueError(result["error"])
    return result


def invalidate(db, room):
    db.execute("DELETE FROM reviews WHERE room=?", (room,))
    db.execute("DELETE FROM game_reviews WHERE room=?", (room,))


def draft_files(db, room, live):
    draft = {}
    for path, base, content in db.execute("SELECT path,base,content FROM game_files WHERE room=?", (room,)):
        if path not in GAME_FILES or not SHA.fullmatch(base):
            raise ValueError("تعذّر قراءة تعديل اللعبة.")
        if base != live:
            current = (ROOT/live/path).read_text(encoding="utf-8")
            if content == current:
                db.execute("DELETE FROM game_files WHERE room=? AND path=?", (room,path))
                continue
            if current != (ROOT/base/path).read_text(encoding="utf-8"):
                raise ValueError(f"تغيّر {path} في إصدار آخر. استخدم /release diff إن كانت له مراجعة، أو /release discard لإلغاء مسودة هذه المحادثة.")
            db.execute("UPDATE game_files SET base=? WHERE room=? AND path=?", (live,room,path))
        draft[path] = content
    return draft


def game_code(params, actor, room, platform):
    operator(platform, actor, room)
    action = params["action"]
    if action == "list":
        return {"files": sorted(GAME_FILES)}
    path = params["path"]
    if path not in GAME_FILES:
        raise ValueError("اختر ملفًا من قائمة ملفات الألعاب.")
    live = status()["live"]
    db = reviews()
    try:
        with db:
            db.execute("BEGIN IMMEDIATE")
            files = draft_files(db,room,live)
            original = (ROOT/live/path).read_text(encoding="utf-8")
            content = files.get(path,original)
            digest = hashlib.sha256(content.encode()).hexdigest()
            if action == "read":
                return {"base": live, "sha256": digest, "path": path, "content": content}
            if action != "replace" or params.get("sha256") != digest:
                raise ValueError("اقرأ أحدث محتوى للملف ثم عدّل النسخة المقروءة.")
            old, new = params["old"], params["new"]
            if not old or old == new or content.count(old) != 1:
                raise ValueError("حدّد مقطعًا واحدًا مطابقًا ومختلفًا عن النص البديل.")
            updated = content.replace(old,new,1)
            if not 0 < len(updated.encode()) <= 120000 or "\x00" in updated:
                raise ValueError("حجم الملف أو محتواه غير صالح.")
            if updated == original:
                db.execute("DELETE FROM game_files WHERE room=? AND path=?", (room,path))
            else:
                db.execute("INSERT OR REPLACE INTO game_files VALUES(?,?,?,?)",(room,path,live,updated))
            invalidate(db,room)
            return {"edited": path, "sha256": hashlib.sha256(updated.encode()).hexdigest(), "saved": True}
    finally:
        db.close()


def preview(actor, room, platform):
    operator(platform,actor,room)
    data = status()
    head = github("/commits/main")["sha"]
    if not SHA.fullmatch(head):
        raise ValueError("تعذّر التحقق من main.")
    data["main"] = head
    db = reviews()
    try:
        with db:
            db.execute("BEGIN IMMEDIATE")
            files = draft_files(db,room,data["live"])
            if files and head == data["live"]:
                candidate = publisher("prepare",room,head,files=files)
                head = candidate["head"]
                data["game_files"] = candidate["files"]
                data["diff_command"] = "/release diff 1"
                data["first_page"] = publisher("diff",room,data["live"],head=head,page=1)
            invalidate(db,room)
            if data["live"] != head:
                if "game_files" in data:
                    db.execute("INSERT INTO game_reviews VALUES(?,?)",(room,head))
                else:
                    data["changes"] = f"{WEB}/compare/{data['live']}...{head}"
                    if files:
                        data["pending_files"] = sorted(files)
                db.execute("INSERT INTO reviews VALUES(?,?,?,?)",(room,data["live"],head,int(time.time())+1800))
                data["confirm"] = "/release confirm " + head[:12]
    finally:
        db.close()
    return data


def can_publish(actor):
    from tools.discord_tool import _discord_request
    token = os.environ["DISCORD_BOT_TOKEN"]
    guild = os.environ["BLUELAND_GUILD_ID"]
    if str(_discord_request("GET",f"/guilds/{guild}",token)["owner_id"]) == actor:
        return True
    member = _discord_request("GET",f"/guilds/{guild}/members/{actor}",token)
    held = set(member["roles"]) | {guild}
    return any(r["id"] in held and int(r["permissions"]) & 8
               for r in _discord_request("GET",f"/guilds/{guild}/roles",token))


def confirm(actor, room, platform, prefix):
    operator(platform,actor,room)
    if not re.fullmatch(r"(?:[0-9a-f]{12}|[0-9a-f]{40})",prefix) or not can_publish(actor):
        raise ValueError("التأكيد يحتاج صلاحية المسؤول ومعرّف النسخة المعروضة.")
    db = reviews()
    try:
        db.execute("BEGIN IMMEDIATE")
        row = db.execute("SELECT base,head FROM reviews WHERE room=? AND expires>?",(room,int(time.time()))).fetchone()
        if not row or not row[1].startswith(prefix):
            raise ValueError("اطلب /release deploy لمراجعة الإصدار الحالي أولًا.")
        base, head = row
        before = status()
        if before["live"] == head:
            return before
        if before["live"] != base:
            raise ValueError("تغيّر الإصدار بعد العرض. راجع التغييرات مجددًا بأمر /release deploy.")
        if db.execute("SELECT 1 FROM game_reviews WHERE room=? AND head=?",(room,head)).fetchone():
            publisher("publish",room,base,head=head)
        elif github("/commits/main")["sha"] != head:
            raise ValueError("تغيّر main. راجع التغييرات مجددًا بأمر /release deploy.")
        db.commit()
        result = subprocess.run(["/usr/bin/systemctl","--no-ask-password","start",
                                 "blueland-release@" + head + ".service"],timeout=380,
                                capture_output=True,check=False)
        after = status()
        if result.returncode or after["live"] != head:
            raise ValueError("تعذّر نشر النسخة المؤكدة. " + describe(after))
        with db:
            db.execute("DELETE FROM reviews WHERE room=? AND head=?",(room,head))
            db.execute("DELETE FROM game_reviews WHERE room=? AND head=?",(room,head))
            for path, content in db.execute("SELECT path,content FROM game_files WHERE room=?", (room,)).fetchall():
                if path in GAME_FILES and content == (ROOT/head/path).read_text(encoding="utf-8"):
                    db.execute("DELETE FROM game_files WHERE room=? AND path=?", (room,path))
        return after
    finally:
        db.close()


def describe(data):
    text = f"الإصدار الشغّال `{data['live'][:12]}` · آخر عملية: {PHASES.get(data['last_operation'],data['last_operation'])}"
    if data["last_target"] and data["last_target"] != data["live"]:
        text += f" للنسخة `{data['last_target'][:12]}`"
    text += " · " + data["updated"]
    if "included_in_live" in data:
        verdict = {True:"موجود",False:"غير موجود",None:"تعذّر التحقق منه"}
        text += f"\nالتحديث `{data['revision']}`: {verdict[data['included_in_live']]} في الإصدار الشغّال."
    if "game_files" in data:
        text += "\n" + "، ".join(data["game_files"]) + "\n" + format_diff(data["first_page"])
        text += f"\nللتأكيد: {data['confirm']}"
    elif "changes" in data:
        text += f"\n{data['changes']}\nللنشر بعد المراجعة: `{data['confirm']}`"
        if data.get("pending_files"):
            text += "\nيوجد تعديل محفوظ للألعاب. راجعه بعد تفعيل main."
    elif data.get("main") == data["live"]:
        text += "\nآخر تحديث على main شغّال بالفعل."
    return text


def format_diff(data):
    fence = chr(96) * 3
    return f"صفحة {data['page']}/{data['pages']} · /release diff رقم_الصفحة\n{fence}diff\n{data['patch']}\n{fence}"


def game_tool(params, **kwargs):
    from gateway.session_context import get_session_env
    try:
        data = game_code(params, get_session_env("HERMES_SESSION_USER_ID"),get_session_env("HERMES_SESSION_CHAT_ID"),
                         get_session_env("HERMES_SESSION_PLATFORM"))
        return json.dumps(data,ensure_ascii=False)
    except (OSError, KeyError, TypeError, ValueError, sqlite3.Error) as err:
        return json.dumps({"error":str(err)},ensure_ascii=False)


def tool(params, **kwargs):
    from gateway.session_context import get_session_env
    try:
        if params.get("action","status") == "preview":
            data = preview(get_session_env("HERMES_SESSION_USER_ID"),get_session_env("HERMES_SESSION_CHAT_ID"),
                           get_session_env("HERMES_SESSION_PLATFORM"))
        else:
            data = status(params.get("revision",""))
        return json.dumps(data,ensure_ascii=False)
    except (OSError, KeyError, ValueError, sqlite3.Error) as err:
        return json.dumps({"error":str(err)},ensure_ascii=False)


def command(raw_args, *, source=None, platform=""):
    args = raw_args.split()
    try:
        actor, room = str(source.user_id), str(source.chat_id)
        operator(platform,actor,room)
        if not args or args[0]=="status" and len(args)<=2:
            return describe(status(args[1] if len(args)==2 else ""))
        if args==["deploy"]:
            return describe(preview(actor,room,platform))
        if args==["discard"] or args and args[0]=="diff" and len(args)<=2:
            db = reviews()
            try:
                if args==["discard"]:
                    with db:
                        db.execute("DELETE FROM game_files WHERE room=?", (room,))
                        invalidate(db,room)
                    return "أُلغيت مسودة الألعاب في هذه المحادثة."
                row = db.execute("SELECT r.base,r.head FROM reviews r JOIN game_reviews g USING(room,head) WHERE room=? AND expires>?",
                                 (room,int(time.time()))).fetchone()
                if not row:
                    raise ValueError("اعرض تعديلات الألعاب بأمر /release deploy أولًا.")
                return format_diff(publisher("diff", room, row[0],head=row[1],page=int(args[1]) if len(args)==2 else 1))
            finally:
                db.close()
        if len(args)==2 and args[0]=="confirm":
            return describe(confirm(actor,room,platform,args[1]))
        return "/release status [SHA] | deploy | diff [page] | confirm SHA | discard"
    except ValueError as err:
        return str(err)
    except (OSError, KeyError, AttributeError, RuntimeError, sqlite3.Error, subprocess.TimeoutExpired):
        return "تعذّر التحقق من خدمة النشر. افحص الحالة بأمر /release status."


def register(ctx):
    ctx.register_tool(name="blueland_game_code",toolset="blueland_release",handler=game_tool,schema={
        "name":"blueland_game_code","description":"List, read and edit the actual BlueLand game source in this Discord room. Read returns content and sha256. Replace one exact unique old snippet with new text using that sha256. Edits persist until approved and deployed. Use blueland_release preview when asked to publish.",
        "parameters":{"type":"object","properties":{"action":{"type":"string","enum":["list","read","replace"]},
        "path":{"type":"string","enum":sorted(GAME_FILES)},"sha256":{"type":"string"},"old":{"type":"string"},"new":{"type":"string"}},"required":["action"]}})
    ctx.register_tool(name="blueland_release",toolset="blueland_release",handler=tool,schema={
        "name":"blueland_release","description":"Read live VPS status, or preview the current room's saved game code edits or a newer main commit. For requests to change games, first use blueland_game_code to implement the change. Show changed files, diff and the exact human confirmation command returned by preview.",
        "parameters":{"type":"object","properties":{"action":{"type":"string","enum":["status","preview"]},
                      "revision":{"type":"string","description":"Optional Git commit ID for status."}},"required":["action"]}})
    ctx.register_command("release",command,"عرض تعديلات البوت وتأكيد نشر النسخة المراجعة",args_hint="status [SHA] | deploy | diff [page] | confirm SHA | discard")
