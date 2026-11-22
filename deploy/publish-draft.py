#!/usr/bin/env python3
"""Commit a validated Discord feature manifest after verifying the human message with Discord."""
import datetime
import fcntl
import json
import os
from pathlib import Path
import re
import shlex
import sqlite3
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
sys.path.insert(0,str(Path(__file__).resolve().parent))
from check_client import test_revision

STATE = Path("/var/lib/blueland-publish")
MIRROR = STATE / "refs.git"
REPO = "git@github.com:zackmsa777-a11y/blueland-manager.git"
FEATURES = "config/discord-features.json"
GUILD = "1573975432838127708"
BOT = "1573988210185347223"


class PublishError(Exception):
    pass


def configure_ssh():
    identity = Path(os.environ["CREDENTIALS_DIRECTORY"]) / "github_key"
    os.environ["GIT_SSH_COMMAND"] = shlex.join(["/usr/bin/ssh","-F","/dev/null","-o","BatchMode=yes",
        "-o","IdentitiesOnly=yes","-o","ConnectTimeout=10","-o","StrictHostKeyChecking=yes",
        "-o","UserKnownHostsFile=/etc/blueland-publish/known_hosts","-i",str(identity)])


def git(args, data=None, env=None):
    result = subprocess.run(["/usr/bin/git", "-c", "core.hooksPath=/dev/null", "--git-dir", str(MIRROR), *args],
                            input=data, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=40, check=True, env=env)
    return result.stdout


def authorized(request, fetch, now):
    channel, message, actor = (request[key] for key in ("channel", "message", "actor"))
    if not all(isinstance(value,str) and re.fullmatch(r"[0-9]{17,20}",value) for value in (channel,message,actor)):
        return False
    if actor not in {os.environ["OPERATOR_ID"],os.environ["OWNER_ID"]}: return False
    if fetch("/channels/"+channel).get("guild_id")!=GUILD: return False
    entry=fetch(f"/channels/{channel}/messages/{message}")
    author=entry["author"]
    if (entry["id"]!=message or entry["channel_id"]!=channel or author["id"]!=actor or
        author.get("bot") or entry.get("webhook_id") or entry.get("type") not in (0,19) or entry.get("edited_timestamp")):
        return False
    age=(now-datetime.datetime.fromisoformat(entry["timestamp"])).total_seconds()
    if not 0<=age<=300: return False
    text=re.sub(r"<@!?"+BOT+">","",entry["content"]).strip()
    if request.get("op","preview")=="preview":
        if text not in {"انشر","انشر التعديلات","+نشر","+vps deploy"}: return False
    elif request.get("op")=="confirm":
        ref=entry.get("message_reference") or {}
        if (text.casefold() not in {"تأكيد","confirm"} or not re.fullmatch(r"[0-9]{17,20}",request.get("preview","")) or
            ref.get("message_id")!=request["preview"] or ref.get("channel_id")!=channel or ref.get("guild_id",GUILD)!=GUILD):
            return False
    else: return False
    return current_operator(actor,fetch)


def current_operator(actor,fetch):
    guild=fetch("/guilds/"+GUILD)
    if actor==os.environ["OWNER_ID"]: return actor==guild["owner_id"]
    member=fetch(f"/guilds/{GUILD}/members/{actor}")
    roles=set(member["roles"])|{GUILD}
    return any(role["id"] in roles and int(role["permissions"])&8 for role in guild["roles"])


def discord_client():
    lines=(Path(os.environ["CREDENTIALS_DIRECTORY"])/"bot.env").read_text().splitlines()
    token=next(line.partition("=")[2].strip().strip("\"'") for line in lines if line.startswith("DISCORD_BOT_TOKEN="))
    def api(path,*,message=None,attachment=None):
        headers={"Authorization":"Bot "+token,"User-Agent":"DiscordBot (https://github.com/zackmsa777-a11y/blueland-manager, 1.1)"}
        data=None
        if message is not None:
            data=json.dumps(message,ensure_ascii=False).encode()
            headers["Content-Type"]="application/json"
        if attachment is not None:
            name,blob=attachment
            boundary="blueland"+os.urandom(20).hex()
            data=(f'--{boundary}\r\nContent-Disposition: form-data; name="payload_json"\r\nContent-Type: application/json\r\n\r\n'.encode()+
                  data+f'\r\n--{boundary}\r\nContent-Disposition: form-data; name="files[0]"; filename="{name}"\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n'.encode()+
                  blob+f"\r\n--{boundary}--\r\n".encode())
            headers["Content-Type"]="multipart/form-data; boundary="+boundary
        req=urllib.request.Request("https://discord.com/api/v10"+path,data=data,headers=headers)
        with urllib.request.urlopen(req,timeout=12) as response:
            return json.load(response)
    return api

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


def candidate(base, patch):
    if not isinstance(patch,str) or not 0<len(patch.encode())<=480000:
        raise PublishError("حجم فرق الكود خارج حد المعاينة.")
    head=refresh()
    if not re.fullmatch("[0-9a-f]{40}",base) or base!=head:
        raise PublishError("تغيّر main عن أساس المسودة. زامن نسخة التطوير ثم اطلب مراجعة جديدة.")
    with tempfile.TemporaryDirectory() as tmp:
        env=dict(os.environ,GIT_INDEX_FILE=str(Path(tmp)/"index"),GIT_AUTHOR_NAME="BlueLand Publisher",
                 GIT_AUTHOR_EMAIL="blueland-publisher@users.noreply.github.com",
                 GIT_COMMITTER_NAME="BlueLand Publisher",GIT_COMMITTER_EMAIL="blueland-publisher@users.noreply.github.com")
        git(["read-tree",head],env=env)
        try: git(["apply","--cached","--whitespace=nowarn","-"],data=patch.encode(),env=env)
        except subprocess.CalledProcessError: raise PublishError("تعذّر تطبيق فرق الكود على أساس المسودة.") from None
        tree=git(["write-tree"],env=env).decode().strip()
        paths=git(["diff","--no-renames","--name-only","-z",head,tree]).decode().split("\0")[:-1]
        if not 1<=len(paths)<=100: raise PublishError("عدد ملفات التعديل خارج حد المعاينة.")
        for name in paths:
            if not (re.fullmatch(r"(?:src|test)/(?:[\w-]+/)*[\w.-]+\.js",name) or
                    re.fullmatch(r"config/(?:[\w-]+/)*[\w.-]+\.json",name) or
                    re.fullmatch(r"public/(?:[\w-]+/)*[\w.-]+\.(?:html|css|js|json|txt)",name) or name=="README.md") or any(p.startswith(".") for p in name.split("/")):
                raise PublishError("هذا الملف خارج كود التطبيق القابل للنشر من ديسكورد: "+name[:180])
            entry=git(["ls-tree",tree,"--",name])
            if entry:
                if not entry.startswith(b"100644 blob "): raise PublishError("يجب أن تكون الملفات نصية عادية.")
                data=git(["show",tree+":"+name])
                if len(data)>250000 or b"\x00" in data: raise PublishError("ملف ثنائي أو كبير في المسودة.")
                data.decode("utf-8")
                if name==FEATURES: validate(data.decode())
        diff=git(["-c","core.quotePath=false","diff","--no-ext-diff","--no-textconv","--no-renames","--full-index",head,tree])
        if len(diff)>520000 or re.search(rb"-----BEGIN [^\n]*PRIVATE KEY-----|cfat_[a-zA-Z0-9]{25,}|[a-zA-Z0-9_-]{23,30}\.[a-zA-Z0-9_-]{6}\.[a-zA-Z0-9_-]{27,}",diff):
            raise PublishError("تعذّر عرض الفرق كاملًا أو ظهر فيه نمط بيانات اعتماد.")
        revision=git(["commit-tree",tree,"-p",head,"-m","Deploy reviewed BlueLand application changes"],env=env).decode().strip()
        # Hold the exact commit locally until approval, including across process restarts.
        git(["update-ref","refs/reviews/"+revision,revision])
        return revision,paths,diff


def database(db):
    db.row_factory=sqlite3.Row
    db.execute("""CREATE TABLE IF NOT EXISTS app_reviews(
        trigger TEXT PRIMARY KEY, channel TEXT NOT NULL, base TEXT NOT NULL, revision TEXT NOT NULL,
        created INTEGER NOT NULL, caption TEXT NOT NULL, diff BLOB NOT NULL, preview TEXT UNIQUE,
        attachment TEXT, status TEXT NOT NULL DEFAULT 'preview', confirmed_by TEXT, confirmation TEXT)""")
    db.execute("""CREATE TABLE IF NOT EXISTS review_copies(
        trigger TEXT NOT NULL, actor TEXT NOT NULL, channel TEXT NOT NULL, message TEXT NOT NULL,
        attachment TEXT NOT NULL, PRIMARY KEY(trigger,actor))""")
    db.commit()


def preview(db,request,api,now):
    row=db.execute("SELECT * FROM app_reviews WHERE trigger=?",(request["message"],)).fetchone()
    if row is None:
        head=refresh()
        if head!=request["base"]: return {"head":head}
        rev,paths,diff=candidate(request["base"],request["patch"])
        caption=(f"مراجعة نشر BlueLand · {rev[:12]}\n"+", ".join(paths)[:900]+
                 "\nالفرق الكامل في الخاص. بعد مراجعته ردّ على هذه الرسالة بـ **تأكيد** خلال 30 دقيقة لاختبار هذه النسخة ونشرها.")
        db.execute("INSERT INTO app_reviews(trigger,channel,base,revision,created,caption,diff) VALUES(?,?,?,?,?,?,?)",
                   (request["message"],request["channel"],request["base"],rev,now,caption,diff))
        db.commit()
        row=db.execute("SELECT * FROM app_reviews WHERE trigger=?",(request["message"],)).fetchone()
    if row["preview"]: return {"preview":row["preview"]}
    name=row["revision"]+".diff"
    recipients=[]
    for user in {os.environ["OPERATOR_ID"],os.environ["OWNER_ID"]}:
        if not current_operator(user,api): continue
        try:
            dm=api("/users/@me/channels",message={"recipient_id":user})
            note={"content":"فرق مراجعة BlueLand · "+row["revision"],"allowed_mentions":{"parse":[]},
                  "attachments":[{"id":0,"filename":name}],"nonce":str(int(request["message"])^int(user)),"enforce_nonce":True}
            copy=api("/channels/"+dm["id"]+"/messages",message=note,attachment=(name,row["diff"]))
        except urllib.error.HTTPError as error:
            if error.code!=403: raise
            continue
        recipients.append(user)
        db.execute("INSERT OR REPLACE INTO review_copies VALUES(?,?,?,?,?)",
                   (row["trigger"],user,dm["id"],copy["id"],copy["attachments"][0]["id"]))
    if not recipients: raise PublishError("افتح الرسائل الخاصة من البوت ثم اطلب المعاينة من جديد.")
    caption=row["caption"]
    if len(recipients)==1: caption+="\nوصل المرفق فقط إلى <@"+recipients[0]+"> ويمكنه تأكيد هذه المراجعة."
    message={"content":caption,"allowed_mentions":{"parse":[],"replied_user":False},
             "message_reference":{"message_id":request["message"]},"nonce":request["message"],"enforce_nonce":True}
    sent=api("/channels/"+row["channel"]+"/messages",message=message)
    db.execute("UPDATE app_reviews SET preview=?,caption=? WHERE trigger=?",(sent["id"],caption,request["message"]))
    db.commit()
    return {"preview":sent["id"]}


def visible_review(db,row,actor,api):
    message=api(f"/channels/{row['channel']}/messages/{row['preview']}")
    if message["author"]["id"]!=BOT or message.get("edited_timestamp") or message["content"]!=row["caption"]: return False
    copy=db.execute("SELECT * FROM review_copies WHERE trigger=? AND actor=?",(row["trigger"],actor)).fetchone()
    if not copy: return False
    dm=api(f"/channels/{copy['channel']}/messages/{copy['message']}")
    files=dm.get("attachments",[])
    return (dm["author"]["id"]==BOT and not dm.get("edited_timestamp") and dm["content"]=="فرق مراجعة BlueLand · "+row["revision"]
            and len(files)==1 and files[0]["id"]==copy["attachment"] and files[0]["filename"]==row["revision"]+".diff")


def confirm(db,request,api,now,run_tests,verify_again):
    row=db.execute("SELECT * FROM app_reviews WHERE preview=? AND channel=?",(request["preview"],request["channel"])).fetchone()
    if row is None: raise PublishError("لم أجد مراجعة نشر مرتبطة بهذه الرسالة.")
    rev=row["revision"]
    if row["status"]=="merged": return {"revision":rev}
    if now-row["created"]>1800: raise PublishError("انتهت مهلة المراجعة. اكتب «انشر» لعرض نسخة جديدة.")
    if not visible_review(db,row,request["actor"],api): raise PublishError("تعذّر التحقق من مرفق المراجعة في الخاص. افتح الخاص واطلب معاينة جديدة.")
    head=refresh()
    if not (head==rev and row["status"]=="tested"):
        if head!=row["base"]: raise PublishError("تغيّر main بعد المعاينة. اطلب مراجعة جديدة.")
        result=run_tests(rev)
        if not result["ok"]: raise PublishError(result["detail"]+" لم تُدمج النسخة.")
        if not verify_again() or not visible_review(db,row,request["actor"],api): raise PublishError("تعذّر التحقق من التأكيد قبل الدمج.")
        if refresh()!=row["base"]: raise PublishError("تغيّر main أثناء الاختبار. اطلب مراجعة جديدة.")
        assert git(["rev-parse",rev+"^"]).decode().strip()==row["base"]
        wanted=STATE/"wanted"
        if wanted.exists():
            prior=wanted.read_text().strip()
            completed=Path("/var/lib/blueland-releases/approved-result")
            if prior not in {rev,""} and (not completed.exists() or completed.read_text().strip()!=prior):
                raise PublishError("يوجد إصدار سابق قيد التشغيل. أعد التأكيد بعد انتهاء النشر.")
        db.execute("UPDATE app_reviews SET status='tested',confirmed_by=?,confirmation=? WHERE trigger=?",
                   (request["actor"],request["message"],row["trigger"]))
        db.commit()
        try: git(["push","--quiet",REPO,rev+":refs/heads/main"])
        except subprocess.CalledProcessError:
            if refresh()!=rev: raise PublishError("لم يقبل GitHub الدمج. تحقّق من آخر إصدار ثم أعد المحاولة.") from None
        git(["update-ref","refs/heads/main",rev])
    marker=STATE/".wanted.next"
    marker.write_text(rev+"\n")
    marker.replace(STATE/"wanted")
    db.execute("UPDATE app_reviews SET status='merged' WHERE trigger=?",(row["trigger"],))
    db.commit()
    return {"revision":rev}


def main():
    configure_ssh()
    raw=sys.stdin.buffer.readline(560001)
    if len(raw)>560000 or not raw.endswith(b"\n"): raise PublishError("طلب النشر أكبر من الحد.")
    request=json.loads(raw)
    api=discord_client()
    def verify():
        return authorized(request,api,datetime.datetime.now(datetime.timezone.utc))
    if request.get("op") not in {"preview","confirm"} or not verify():
        raise PublishError("النشر يحتاج رسالة أصلية من أحد الحسابين المخوّلين داخل BlueLand.")
    with (STATE/"publish.lock").open("a") as lock:
        fcntl.flock(lock,fcntl.LOCK_EX)
        with sqlite3.connect(STATE/"reviews.sqlite") as db:
            (STATE/"reviews.sqlite").chmod(0o600)
            database(db)
            now=int(datetime.datetime.now(datetime.timezone.utc).timestamp())
            if request["op"]=="preview": return preview(db,request,api,now)
            result=confirm(db,request,api,now,test_revision,verify)
    rev=result["revision"]
    status=Path("/var/lib/blueland-releases/status.json")
    for _ in range(65):
        try: state=json.loads(status.read_text())
        except (OSError,ValueError): state={}
        if state.get("target")==rev and state.get("phase") in {"live","current","failed","rolled_back","rollback_failed"}:
            ok=state.get("active")==rev and state["phase"] in {"live","current"}
            text=("اجتازت النسخة الاختبارات ودُمجت ونُشرت. البوت متصل بالإصدار " if ok else
                  "اجتازت النسخة الاختبارات ودُمجت، ثم تعذّر تشغيلها. التفاصيل في +vps release. الإصدار ")+rev[:12]
            try:
                api("/channels/"+request["channel"]+"/messages",message={"content":text,"allowed_mentions":{"parse":[],"replied_user":False},
                    "message_reference":{"message_id":request["preview"]},"nonce":str(int(request["preview"])^0x70abc),"enforce_nonce":True})
                result["notified"]=True
            except OSError: pass
            break
        time.sleep(1)
    return result


if __name__=="__main__":
    try:
        result=main()
    except PublishError as exc:
        result={"error":str(exc)}
    except Exception as exc:
        print("Application publisher:",type(exc).__name__,file=sys.stderr)
        result={"error":"تعذّر إكمال طلب النشر. راجع حالة الخدمة ثم أعد المحاولة."}
    print(json.dumps({"ok":True,"value":result},ensure_ascii=False),flush=True)
