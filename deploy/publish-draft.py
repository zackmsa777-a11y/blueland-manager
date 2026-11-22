#!/usr/bin/env python3
"""Commit a validated Discord feature manifest after verifying the human message with Discord."""
import datetime
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import subprocess
import sys
import tempfile
import urllib.request

STATE = Path("/var/lib/blueland-publish")
MIRROR = STATE / "refs.git"
REPO = "git@github.com:zackmsa777-a11y/blueland-manager.git"
FEATURES = "config/discord-features.json"
GUILD = "1573975432838127708"
BOT = "1573988210185347223"


class PublishError(Exception):
    pass


def git(args, data=None, env=None):
    result = subprocess.run(["/usr/bin/git", "-c", "core.hooksPath=/dev/null", "--git-dir", str(MIRROR), *args],
                            input=data, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=40, check=True, env=env)
    return result.stdout


def authorized(request, fetch, now):
    channel, message, actor = (request[key] for key in ("channel", "message", "actor"))
    if not all(isinstance(value, str) and re.fullmatch(r"[0-9]{17,20}", value) for value in (channel,message,actor)):
        return False
    if actor not in {os.environ["OPERATOR_ID"], os.environ["OWNER_ID"]}:
        return False
    if fetch("/channels/" + channel).get("guild_id") != GUILD:
        return False
    entry = fetch(f"/channels/{channel}/messages/{message}")
    author = entry["author"]
    if (entry["id"] != message or entry["channel_id"] != channel or author["id"] != actor or
            author.get("bot") or entry.get("webhook_id") or entry.get("type") not in (0,19) or entry.get("edited_timestamp")):
        return False
    age = (now - datetime.datetime.fromisoformat(entry["timestamp"])).total_seconds()
    text = re.sub(r"<@!?" + BOT + ">", "", entry["content"]).strip()
    if not (0 <= age <= 300 and text in {"انشر", "انشر التعديلات", "+نشر", "+vps deploy"}):
        return False
    guild = fetch("/guilds/" + GUILD)
    if actor == os.environ["OWNER_ID"]:
        return actor == guild["owner_id"]
    member = fetch(f"/guilds/{GUILD}/members/{actor}")
    roles = set(member["roles"]) | {GUILD}
    return any(role["id"] in roles and int(role["permissions"]) & 8 for role in guild["roles"])


def discord_client():
    lines = (Path(os.environ["CREDENTIALS_DIRECTORY"]) / "bot.env").read_text().splitlines()
    token = next(line.partition("=")[2].strip().strip("\"'") for line in lines if line.startswith("DISCORD_BOT_TOKEN="))
    def fetch(path):
        req = urllib.request.Request("https://discord.com/api/v10" + path, headers={
            "Authorization":"Bot "+token, "User-Agent":"DiscordBot (https://github.com/zackmsa777-a11y/blueland-manager, 1.1)"})
        with urllib.request.urlopen(req,timeout=8) as response:
            return json.load(response)
    return fetch


def validate(content):
    if not isinstance(content,str) or len(content.encode()) > 22000:
        raise PublishError("ملف المزايا أكبر من حد النشر.")
    def unique(items):
        result = dict(items)
        if len(result) != len(items):
            raise PublishError("ملف المزايا يحتوي على مفتاح مكرر.")
        return result
    try:
        value = json.loads(content,object_pairs_hook=unique)
        if not isinstance(value,dict) or set(value) != {"activity","commands"}:
            raise ValueError()
        fields = {"rank":{"member","level","points","remaining"}, "top":{"rows"},
                  "row":{"position","member","points"}, "empty":set()}
        if set(value["activity"]) != set(fields):
            raise ValueError()
        for key, allowed in fields.items():
            item = value["activity"][key]
            if not isinstance(item,str) or not 1 <= len(item) <= (130 if key=="row" else 500):
                raise ValueError()
            if set(re.findall(r"\{(\w+)\}",item)) - allowed:
                raise ValueError()
        commands = value["commands"]
        if not isinstance(commands,dict) or len(commands) > 40:
            raise ValueError()
        for name, command in commands.items():
            if not re.fullmatch(r"[\w-]{1,32}",name) or name.startswith("_") or not isinstance(command,dict):
                raise ValueError()
            if not {"instruction"} <= set(command) <= {"instruction","source"}:
                raise ValueError()
            if not isinstance(command["instruction"],str) or not 1 <= len(command["instruction"].strip()) <= 1800:
                raise ValueError()
            if not isinstance(command.get("source",""),str) or len(command.get("source","")) > 6000:
                raise ValueError()
    except (ValueError,TypeError,KeyError):
        raise PublishError("صيغة أوامر البوت أو قوالب النشاط غير صالحة.") from None
    if re.search(r"-----BEGIN .*PRIVATE KEY-----|cfat_[A-Za-z0-9]{25,}|[A-Za-z\d_-]{23,30}\.[A-Za-z\d_-]{6}\.[A-Za-z\d_-]{27,}", content):
        raise PublishError("توجد بيانات اعتماد في المسودة. احذفها قبل النشر.")


def refresh():
    if not MIRROR.exists():
        git(["init","--bare","--quiet"])
    git(["fetch","--quiet","--no-tags",REPO,"refs/heads/main:refs/heads/main"])
    return git(["rev-parse","refs/heads/main"]).decode().strip()


def merge(request):
    content = request["content"]
    validate(content)
    encoded = content.encode()
    head = refresh()
    old = git(["show",head+":"+FEATURES])
    if old == encoded:
        return head
    if hashlib.sha256(old).hexdigest() != request["original"]:
        raise PublishError("تغيّر ملف المزايا في GitHub منذ إنشاء المسودة. يلزم توفيق النسختين قبل النشر.")
    with tempfile.TemporaryDirectory() as tmp:
        env = dict(os.environ,GIT_INDEX_FILE=str(Path(tmp)/"index"),GIT_AUTHOR_NAME="BlueLand Publisher",
                   GIT_AUTHOR_EMAIL="blueland-publisher@users.noreply.github.com",
                   GIT_COMMITTER_NAME="BlueLand Publisher",GIT_COMMITTER_EMAIL="blueland-publisher@users.noreply.github.com")
        blob = git(["hash-object","-w","--stdin"],data=encoded).decode().strip()
        git(["read-tree",head],env=env)
        git(["update-index","--add","--cacheinfo","100644",blob,FEATURES],env=env)
        tree = git(["write-tree"],env=env).decode().strip()
        commit = git(["commit-tree",tree,"-p",head,"-m","Publish approved BlueLand Discord features"],env=env).decode().strip()
        git(["push","--quiet",REPO,commit+":refs/heads/main"])
        git(["update-ref","refs/heads/main",commit,head])
        return commit


def main():
    raw = sys.stdin.buffer.readline(55001)
    if len(raw)>55000 or not raw.endswith(b"\n"):
        raise PublishError("طلب النشر أكبر من الحد.")
    request=json.loads(raw)
    if not authorized(request,discord_client(),datetime.datetime.now(datetime.timezone.utc)):
        raise PublishError("النشر يحتاج رسالة «انشر» جديدة من أحد الحسابين المخوّلين داخل BlueLand.")
    validate(request["content"])
    with (STATE/"publish.lock").open("a") as lock:
        fcntl.flock(lock,fcntl.LOCK_EX)
        with sqlite3.connect(STATE/"receipts.sqlite") as db:
            db.execute("CREATE TABLE IF NOT EXISTS receipts(message TEXT PRIMARY KEY, digest TEXT NOT NULL, revision TEXT)")
            digest=hashlib.sha256(request["content"].encode()).hexdigest()
            db.execute("INSERT OR IGNORE INTO receipts VALUES(?,?,NULL)",(request["message"],digest))
            db.commit()
            prior,revision=db.execute("SELECT digest,revision FROM receipts WHERE message=?", (request["message"],)).fetchone()
            if prior!=digest:
                raise PublishError("استُخدمت هذه الرسالة لمسودة مختلفة. اكتب «انشر» من جديد.")
            if not revision:
                revision=merge(request)
                db.execute("UPDATE receipts SET revision=? WHERE message=?", (revision,request["message"]))
                db.commit()
            marker=STATE/".wanted.next"
            marker.write_text(revision+"\n")
            marker.replace(STATE/"wanted")
            return {"revision":revision}


if __name__=="__main__":
    try:
        result=main()
    except PublishError as exc:
        result={"error":str(exc)}
    except Exception as exc:
        print("Feature publisher:",type(exc).__name__,file=sys.stderr)
        result={"error":"تعذّر التحقق من ديسكورد أو دمج المسودة في GitHub. جرّب +vps release ثم أعد المحاولة."}
    print(json.dumps({"ok":True,"value":result},ensure_ascii=False),flush=True)
