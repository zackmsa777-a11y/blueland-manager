#!/usr/bin/env python3
"""File operations and known development commands in the offline BlueLand project copy."""
import fcntl
import json
import os
import pathlib
import re
import subprocess
import sys
import tempfile

ROOT = pathlib.Path.cwd()
NODE = "/usr/local/bin/node"
EXTENSIONS = {".js", ".json", ".md", ".css", ".html", ".txt"}
SKIP_DIRS = {"node_modules", "data", "deploy"}

def filename(name):
    path = pathlib.PurePosixPath(name)
    if (not name or path.is_absolute() or name != str(path) or len(name)>180 or
        any(not re.fullmatch(r"[\w-][\w. -]*", part) for part in path.parts) or
        any(part in SKIP_DIRS for part in path.parts) or path.suffix not in EXTENSIONS):
        raise ValueError("Unsupported workspace path")
    target = ROOT / path
    if target.resolve() != target: raise ValueError("Symbolic link is not editable")
    return target

def perform(item):
    op = item["op"]
    if op in {"release_patch","release_synced","release_refresh"}:
        # If the bot restarted during activation, advance the baseline without touching later edits.
        wanted=pathlib.Path("/var/lib/blueland-publish/wanted")
        rev=item.get("revision") if op!="release_patch" else (wanted.read_text().strip() if wanted.is_file() else None)
        if rev and re.fullmatch(r"[0-9a-f]{40}",rev):
            mirror="/var/lib/blueland-publish/refs.git"
            git=["/usr/bin/git","-c","core.hooksPath=/dev/null","-c","core.fsmonitor=false"]
            env=dict(os.environ,GIT_CONFIG_COUNT="1",GIT_CONFIG_KEY_0="safe.directory",GIT_CONFIG_VALUE_0=mirror)
            head=subprocess.check_output(git+["rev-parse","HEAD"],text=True).strip()
            if head!=rev:
                subprocess.run(git+["fetch","--quiet","--no-tags",mirror,"refs/heads/main"],check=True,env=env)
                if op=="release_refresh":
                    if subprocess.check_output(git+["rev-parse","FETCH_HEAD"],text=True).strip()!=rev:
                        return {"error":True,"text":"تغيّر main مرة أخرى. اطلب المعاينة من جديد."}
                    merge=subprocess.run(git+["merge","--quiet","--ff-only",rev],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
                    if merge.returncode: return {"error":True,"text":"تتعارض المسودة مع إصدار أحدث. احتُفظ بتعديلاتك للمراجعة."}
                    return {"synced":True}
                if (subprocess.run(git+["merge-base","--is-ancestor",rev,"FETCH_HEAD"]).returncode==0 and
                    subprocess.check_output(git+["rev-parse",rev+"^"],text=True).strip()==head and
                    subprocess.run(git+["diff","--cached","--quiet","HEAD"]).returncode==0):
                    subprocess.run(git+["reset","--quiet","--mixed",rev],check=True)
        if op!="release_patch": return {"synced":True}
    if op in {"patch","release_patch"}:
        git = ["/usr/bin/git", "--literal-pathspecs", "-c", "core.fsmonitor=false"]
        changes = subprocess.check_output(git + ["diff","--no-renames","--name-only","-z","HEAD"])
        changes += subprocess.check_output(git + ["ls-files", "-z", "--others", "--exclude-standard"])
        names = sorted(set(os.fsdecode(changes).split("\0")) - {""})
        if not names:
            return {"text": ""}
        if len(names) > 100:
            raise ValueError("Too many files in the draft")
        total = 0
        for name in names:
            path = filename(name)
            if path.exists():
                if not path.is_file():
                    raise ValueError("Unsupported file in the draft")
                total += path.stat().st_size
        if total > 2_000_000:
            raise ValueError("Draft exceeds the export size limit")
        with tempfile.TemporaryDirectory() as tmp:
            env = dict(os.environ, GIT_INDEX_FILE=os.path.join(tmp, "index"))
            subprocess.run(git + ["read-tree", "HEAD"], env=env, check=True)
            subprocess.run(git + ["add", "-A", "--", *names], env=env, check=True)
            patch = subprocess.check_output(git + ["diff", "--cached", "--no-ext-diff", "--no-textconv", "--binary", "HEAD"], env=env)
        limit=480000 if op=="release_patch" else 55000
        if len(json.dumps(patch.decode("utf-8"),ensure_ascii=False).encode()) > limit:
            raise ValueError("Draft exceeds the Discord patch export size limit")
        return {"text":patch.decode("utf-8"),"base":subprocess.check_output(git+["rev-parse","HEAD"],text=True).strip()}
    if op=="files":
        paths = []
        for base, dirs, names in os.walk(ROOT):
            dirs[:] = sorted(d for d in dirs if d not in SKIP_DIRS and not d.startswith("."))
            for name in sorted(names):
                path = pathlib.Path(base) / name
                if not name.startswith(".") and path.suffix in EXTENSIONS and not path.is_symlink():
                    paths.append(str(path.relative_to(ROOT)))
                    if len(paths) == 350:
                        return {"text": "\n".join(paths)}
        return {"text": "\n".join(paths)}
    if op=="command":
        options={"git status":["/usr/bin/git","status","--short"],"node version":[NODE,"--version"]}
        if item["target"]=="check": cmd=[NODE,"--check",str(filename(item["value"]))]
        elif item["target"]=="tests": cmd=[NODE,"--test",*[str(p) for p in sorted((ROOT/"test").glob("*.test.js"))]]
        else: cmd=options[item["target"]]
        with tempfile.TemporaryFile() as output:
            try:
                completed=subprocess.run(cmd,stdin=subprocess.DEVNULL,stdout=output,stderr=subprocess.STDOUT,
                                         env={"PATH":"/usr/local/bin:/usr/bin:/bin","HOME":"/tmp","GIT_OPTIONAL_LOCKS":"0"},timeout=40)
                code=completed.returncode
            except subprocess.TimeoutExpired: code=124
            output.seek(max(0,output.tell()-2600))
            return {"text":output.read(2600).decode(errors="replace"),"ran":True,"exit":code}
    path=filename(item["target"])
    if path.exists() and path.stat().st_size>250000: raise ValueError("File too large")
    if op=="read":
        start=int(item.get("value") or 1)
        if start<1: raise ValueError("Invalid line")
        lines=path.read_text().splitlines()
        return {"text":"\n".join(f"{i+1}: {lines[i]}" for i in range(start-1,min(len(lines),start+59)))[:5200]}
    if op!="edit": raise ValueError("Unknown operation")
    old=item["value"]
    new=item["extra"]
    original=path.read_text() if path.exists() else ""
    if path.exists() and (not old or original.count(old)!=1): raise ValueError("Expected exactly one matching old block")
    if not path.exists() and old: raise ValueError("New files require an empty old block")
    result=original.replace(old,new,1) if old else new
    if result==original: return {"text":"No change"}
    if len(result.encode())>250000: raise ValueError("File too large")
    path.parent.mkdir(parents=True,exist_ok=True)
    with tempfile.NamedTemporaryFile(mode="w",dir=path.parent,delete=False) as fh:
        fh.write(result)
    os.replace(fh.name,path)
    return {"text":"Saved "+item["target"],"edited":item["target"]}

try:
    raw=sys.stdin.buffer.readline(50001)
    if len(raw)>50000: raise ValueError("Request too large")
    with open(ROOT/".blueland-lock","a") as lock:
        fcntl.flock(lock,fcntl.LOCK_EX)
        print(json.dumps({"ok":True,"value":perform(json.loads(raw))},ensure_ascii=False),flush=True)
except Exception as error:
    print(json.dumps({"ok":True,"value":{"text":"Workspace error: "+str(error)[:240],"error":True}}),flush=True)
