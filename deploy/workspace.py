#!/usr/bin/env python3
"""File operations and known development commands in the offline BlueLand project copy."""
import fcntl
import hashlib
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
    if op in {"feature_snapshot","feature_merged"}:
        feature = "config/discord-features.json"
        git = ["/usr/bin/git","-c","core.hooksPath=/dev/null","-c","core.fsmonitor=false"]
        state = ROOT/".git"/"blueland-feature-base"
        head = subprocess.check_output(git+["rev-parse","HEAD"],text=True).strip()
        if op=="feature_snapshot":
            changed = subprocess.check_output(git+["diff","--name-only","-z","HEAD"])
            untracked = subprocess.check_output(git+["ls-files","--others","--exclude-standard","-z"])
            names = (set(os.fsdecode(changed+untracked).split("\0")) - {"",feature})
            if names:
                return {"blocked":sorted(names)[:12]}
            path = filename(feature)
            if path.stat().st_size>22000:
                raise ValueError("Feature file too large")
            original = hashlib.sha256(subprocess.check_output(git+["show","HEAD:"+feature])).hexdigest()
            if state.exists():
                memo=json.loads(state.read_text())
                if memo["head"]==head: original=memo["original"]
            return {"original":original,"content":path.read_bytes().decode("utf-8")}
        revision=item["revision"]
        if not re.fullmatch(r"[a-f0-9]{40}",revision): raise ValueError("Invalid revision")
        mirror="/var/lib/blueland-publish/refs.git"
        env=dict(os.environ,GIT_CONFIG_COUNT="1",GIT_CONFIG_KEY_0="safe.directory",GIT_CONFIG_VALUE_0=mirror)
        subprocess.run(git+["fetch","--quiet","--no-tags",mirror,"refs/heads/main"],check=True,env=env)
        subprocess.run(git+["merge-base","--is-ancestor",revision,"FETCH_HEAD"],check=True)
        subprocess.run(git+["merge-base","--is-ancestor",head,revision],check=True)
        paths=subprocess.check_output(git+["diff","--name-only",head,revision],text=True).splitlines()
        if set(paths)<={feature}:
            subprocess.run(git+["reset","--quiet","--mixed",revision],check=True)
            state.unlink(missing_ok=True)
        else:
            blob=subprocess.check_output(git+["show",revision+":"+feature])
            state.write_text(json.dumps({"head":head,"original":hashlib.sha256(blob).hexdigest()}))
        return {"synced":True}
    if op == "patch":
        git = ["/usr/bin/git", "--literal-pathspecs", "-c", "core.fsmonitor=false"]
        changes = subprocess.check_output(git + ["ls-files", "-z", "--modified", "--deleted", "--others", "--exclude-standard"])
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
        if len(json.dumps(patch.decode("utf-8"),ensure_ascii=False).encode()) > 55000:
            raise ValueError("Draft exceeds the Discord patch export size limit")
        return {"text": patch.decode("utf-8")}
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
