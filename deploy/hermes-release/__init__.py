"""BlueLand releases for the Hermes Discord gateway."""
import json
import os
from pathlib import Path
import re
import sqlite3
import subprocess
import time
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

ROOT = Path("/var/lib/blueland-releases")
REPO = "zackmsa777-a11y/blueland-manager"
WEB = "https://github.com/" + REPO
SHA = re.compile(r"[0-9a-f]{40}")
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
    return db


def operator(platform, actor, room):
    allowed = os.environ.get("DISCORD_ALLOWED_USERS","").split(",")
    if platform != "discord" or actor not in allowed or not room.isdecimal():
        raise ValueError("النشر متاح للحسابين المخوّلين في ديسكورد.")


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
            db.execute("DELETE FROM reviews WHERE room=? OR expires<=?",(room,int(time.time())))
            if data["live"] != head:
                db.execute("INSERT INTO reviews VALUES(?,?,?,?)",(room,data["live"],head,int(time.time())+1800))
                data["changes"] = f"{WEB}/compare/{data['live']}...{head}"
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
        row = db.execute("SELECT base,head FROM reviews WHERE room=? AND expires>?",(room,int(time.time()))).fetchone()
        if not row or not row[1].startswith(prefix):
            raise ValueError("اطلب /release deploy لمراجعة الإصدار الحالي أولًا.")
        base, head = row
        before = status()
        if before["live"] == head:
            return before
        if before["live"] != base or github("/commits/main")["sha"] != head:
            raise ValueError("تغيّر الإصدار بعد العرض. راجع التغييرات مجددًا بأمر /release deploy.")
        result = subprocess.run(["/usr/bin/systemctl","--no-ask-password","start",
                                 "blueland-release@" + head + ".service"],timeout=380,
                                capture_output=True,check=False)
        after = status()
        if result.returncode or after["live"] != head:
            raise ValueError("تعذّر نشر النسخة المؤكدة. " + describe(after))
        with db:
            db.execute("DELETE FROM reviews WHERE room=? AND head=?",(room,head))
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
    if "changes" in data:
        text += f"\n{data['changes']}\nللنشر بعد المراجعة: `{data['confirm']}`"
    elif data.get("main") == data["live"]:
        text += "\nآخر تحديث على main شغّال بالفعل."
    return text


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
        if len(args)==2 and args[0]=="confirm":
            return describe(confirm(actor,room,platform,args[1]))
        return "/release status [SHA] | /release deploy | /release confirm SHA"
    except ValueError as err:
        return str(err)
    except (OSError, KeyError, AttributeError, RuntimeError, sqlite3.Error, subprocess.TimeoutExpired):
        return "تعذّر التحقق من خدمة النشر. افحص الحالة بأمر /release status."


def register(ctx):
    ctx.register_tool(name="blueland_release",toolset="blueland_release",handler=tool,schema={
        "name":"blueland_release","description":"Read the live VPS release and latest deployment result. Supply revision to verify whether an older Git commit (for example the games update) is included. For explicit deployment requests use preview to compare main with production and get a human confirmation command if needed.",
        "parameters":{"type":"object","properties":{"action":{"type":"string","enum":["status","preview"]},
                      "revision":{"type":"string","description":"Optional Git commit ID for status."}},"required":["action"]}})
    ctx.register_command("release",command,"حالة إصدار BlueLand ومراجعة نشر main",args_hint="status [SHA] | deploy | confirm SHA")
