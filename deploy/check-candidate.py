#!/usr/bin/env python3
"""Run application tests in the offline socket worker; only a result leaves the worker."""
import io
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tarfile
import tempfile

RELEASES=Path("/var/lib/blueland-releases")
MIRROR=Path("/var/lib/blueland-publish/refs.git")
NODE="/usr/local/bin/node"


def check(request):
    sha=request["revision"]
    if not re.fullmatch("[0-9a-f]{40}",sha):
        raise ValueError()
    if "stage" in request:
        name=request["stage"]
        if not re.fullmatch(r"\.build-[a-z0-9_]{8}",name): raise ValueError()
        source=RELEASES/name/"app"
        if source.resolve()!=source: raise ValueError()
        repo=source/".git"
        dependencies=source
    else:
        repo=MIRROR
        dependencies=RELEASES/"current"
    git=["/usr/bin/git","-c","safe.directory="+str(repo.parent),"-c","safe.directory="+str(repo),"--git-dir",str(repo)]
    archive=subprocess.check_output(git+["archive","--format=tar",sha],timeout=15)
    with tempfile.TemporaryDirectory() as temp:
        root=Path(temp)
        with tarfile.open(fileobj=io.BytesIO(archive)) as tar:
            tar.extractall(root,filter="data")
        if (root/"package-lock.json").read_bytes() != (dependencies/"package-lock.json").read_bytes():
            return {"ok":False,"detail":"اختلفت التبعيات عن النسخة المركبة."}
        (root/"node_modules").symlink_to((dependencies/"node_modules").resolve(),target_is_directory=True)
        env={"PATH":"/usr/local/bin:/usr/bin:/bin","HOME":temp,"LANG":"C.UTF-8"}
        with tempfile.TemporaryFile() as log:
            for file in sorted((root/"src").rglob("*.js")):
                if subprocess.run([NODE,"--check",str(file)],cwd=root,env=env,stdin=subprocess.DEVNULL,
                                  stdout=log,stderr=log,timeout=10).returncode:
                    return {"ok":False,"detail":"فشل فحص JavaScript في "+str(file.relative_to(root))}
            result=subprocess.run([NODE,"--test"],cwd=root,stdin=subprocess.DEVNULL,stdout=log,stderr=log,env=env,timeout=65)
            log.seek(0,os.SEEK_END)
            log.seek(max(0,log.tell()-4000))
            summary=log.read().decode(errors="replace")
            count=re.search(r"(?:ℹ|#) tests (\d+)",summary)
            ok=result.returncode==0 and count is not None and int(count[1])>0
            return {"ok":ok,"detail":("اختبارات ناجحة: "+count[1]) if ok else "فشلت اختبارات التطبيق."}


if __name__=="__main__":
    try:
        response=check(json.loads(sys.stdin.buffer.readline(700)))
    except Exception as err:
        print("Isolated test:",type(err).__name__,file=sys.stderr)
        response={"ok":False,"detail":"تعذّر إكمال اختبار النسخة المعروضة."}
    print(json.dumps(response,ensure_ascii=False),flush=True)
