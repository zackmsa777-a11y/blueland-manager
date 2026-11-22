#!/usr/bin/python3
"""Build immutable application revisions and promote a reviewed revision through the offline checker."""
import fcntl
import json
import os
from pathlib import Path
import re
import shlex
import subprocess
import sys
import tempfile

# Installed beside this file. Do not import from the candidate.
sys.path.insert(0, str(Path(__file__).resolve().parent))
from check_client import test_revision
sys.path.insert(0, str(Path(__file__).resolve().parent / "hermes-release"))
from source_files import MAX_BYTES, editable

MIRROR = Path("/var/lib/blueland-publish/refs.git")
REMOTE = "git@github.com:zackmsa777-a11y/blueland-manager.git"
SHA = re.compile(r"[0-9a-f]{40}")


def git(*args, data=None, env=None):
    command = ["/usr/bin/git", "-c", "core.hooksPath=/dev/null", "--git-dir", str(MIRROR), *args]
    return subprocess.run(command, input=data, text=True, encoding="utf-8", env=env,
                          capture_output=True, timeout=45, check=True).stdout


def handle(request):
    action, room, base = (request[k] for k in ("action", "room", "base"))
    if not re.fullmatch(r"[0-9]{1,22}", room) or not SHA.fullmatch(base):
        raise ValueError("بيانات المراجعة غير صالحة.")
    ref = "refs/blueland/games/" + room
    if action == "prepare":
        files = request["files"]
        if not isinstance(files,dict) or not files or not all(editable(path) for path in files):
            raise ValueError("التعديل خارج مجلدات كود التطبيق.")
        if any(v is not None and (not isinstance(v,str) or len(v.encode()) > MAX_BYTES or "\x00" in v)
               for v in files.values()):
            raise ValueError("حجم الملف أو محتواه غير صالح.")
        git("fetch", "--quiet", "--no-tags", REMOTE, "refs/heads/main")
        if git("rev-parse", "FETCH_HEAD").strip() != base:
            raise ValueError("تغيّر main. حدّث النسخة الشغالة وراجع التعديل عليها.")
        with tempfile.TemporaryDirectory() as temp:
            env = dict(os.environ, GIT_INDEX_FILE=str(Path(temp) / "index"))
            git("read-tree", base, env=env)
            for path, content in files.items():
                entry = git("ls-tree", "-z", base, "--", path)
                mode = entry.partition(" ")[0] if entry else "100644"
                if mode not in ("100644", "100755"):
                    raise ValueError("التعديل متاح للملفات العادية داخل مجلدات التطبيق.")
                if content is None:
                    git("update-index", "--index-info", data="0 " + "0" * 40 + "\t" + path + "\n", env=env)
                    continue
                blob = git("hash-object", "-w", "--stdin", data=content).strip()
                git("update-index", "--add", "--cacheinfo", mode + "," + blob + "," + path, env=env)
            tree = git("write-tree", env=env).strip()
        if tree == git("rev-parse", base + "^{tree}").strip():
            raise ValueError("التعديلات مطابقة للإصدار الشغّال.")
        changed = set(git("diff", "--no-renames", "--name-only", "-z", base, tree, "--").rstrip("\0").split("\0"))
        if changed != set(files):
            raise ValueError("تعارضت مسارات الملفات. راجع قائمة التعديلات قبل النشر.")
        head = git("-c", "user.name=BlueLand Manager", "-c", "user.email=blueland@localhost",
                   "commit-tree", tree, "-p", base, "-m", "Update reviewed BlueLand bot code").strip()
        git("update-ref", ref, head)
        return {"head": head, "files": sorted(files)}

    head = request["head"]
    if not SHA.fullmatch(head) or git("rev-parse", ref).strip() != head or git("rev-parse", head + "^").strip() != base:
        raise ValueError("تغيّرت النسخة المرشحة. اعرض التعديل من جديد.")
    if action == "diff":
        patch = git("diff", "--no-ext-diff", "--no-color", "--no-renames", base, head, "--")
        # Escape Discord fences, mentions and markdown links are inert inside the fence.
        patch = patch.replace(chr(96)*3, chr(96)*2 + "\u200b" + chr(96)).replace("@", "@\u200b")
        page = int(request.get("page", 1))
        pages = max(1, (len(patch) + 1199) // 1200)
        if not 1 <= page <= pages:
            raise ValueError(f"اختر صفحة من 1 إلى {pages}.")
        return {"patch": patch[(page-1)*1200:page*1200], "page": page, "pages": pages}
    if action != "publish":
        raise ValueError("عملية غير معروفة.")
    current = git("ls-remote", "--exit-code", REMOTE, "refs/heads/main").split()[0]
    if current == head:
        return {"head": head}
    if current != base:
        raise ValueError("تغيّر main بعد المراجعة. اطلب معاينة جديدة.")
    outcome = test_revision(head)
    if not outcome["ok"]:
        raise ValueError(outcome["detail"])
    git("push", "--quiet", "--force-with-lease=refs/heads/main:" + base, REMOTE, head + ":refs/heads/main")
    return {"head": head, "tests": outcome["detail"]}


if __name__ == "__main__":
    try:
        os.environ["GIT_SSH_COMMAND"] = shlex.join([
            "/usr/bin/ssh", "-F", "/dev/null", "-o", "BatchMode=yes", "-o", "IdentitiesOnly=yes",
            "-o", "StrictHostKeyChecking=yes", "-o", "ConnectTimeout=10",
            "-o", "UserKnownHostsFile=/etc/blueland-publish/known_hosts",
            "-i", str(Path(os.environ["CREDENTIALS_DIRECTORY"]) / "github_key")])
        request = json.loads(sys.stdin.buffer.readline(4000000))
        with (MIRROR.parent / ".games.lock").open("a") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            result = handle(request)
    except ValueError as err:
        result = {"error": str(err)}
    except (OSError, KeyError, TypeError, subprocess.SubprocessError) as err:
        print("Game publisher:", type(err).__name__, file=sys.stderr)
        result = {"error": "تعذّر إكمال عملية Git أو الاختبار. راجع سجل خدمة نشر الألعاب."}
    print(json.dumps(result, ensure_ascii=False), flush=True)
