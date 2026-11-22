#!/usr/bin/env python3
"""Publish tested GitHub main to the bot; the bot and its editor have read-only access."""
import datetime
import json
import pathlib
import re
import shutil
import subprocess
import tempfile
import time
import urllib.request

ROOT = pathlib.Path("/var/lib/blueland-releases")
CURRENT = ROOT / "current"
REPO = "https://github.com/zackmsa777-a11y/blueland-manager.git"
BASE = pathlib.Path("/opt/blueland-manager")
GIT = ["/usr/bin/git", "-c", "core.hooksPath=/dev/null"]


def output(args):
    return subprocess.check_output(args, text=True, timeout=40).strip()


def version(path):
    if path == BASE:
        return output(GIT + ["-c", "safe.directory=" + str(BASE), "-C", str(path), "rev-parse", "HEAD"])
    if path.parent == ROOT and re.fullmatch(r"[0-9a-f]{40}", path.name):
        return path.name
    raise ValueError("Invalid active release")


def report(phase, active, target):
    data = dict(phase=phase, active=active, target=target,
                updated=datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"))
    temp = ROOT / ".status.next"
    temp.write_text(json.dumps(data) + "\n")
    temp.replace(ROOT / "status.json")


def activate(path):
    pending = ROOT / ".current.next"
    pending.unlink(missing_ok=True)
    pending.symlink_to(path, target_is_directory=True)
    pending.replace(CURRENT)
    subprocess.run(["/usr/bin/systemctl", "--no-ask-password", "restart", "blueland.service"],
                   timeout=40, check=True)
    request = urllib.request.Request("http://127.0.0.1:4196/api/status", headers={"Host": "bot.najdhorizonco.shop"})
    for attempt in range(45):
        try:
            with urllib.request.urlopen(request, timeout=2) as response:
                state = json.load(response)["connection"]
            if state["code"] == "online" and state["slashReady"] == state["slashTotal"] and state["slashTotal"] > 0:
                return
        except (OSError, KeyError, ValueError):
            pass
        time.sleep(1)
    raise RuntimeError("Discord readiness timed out")


def publish():
    previous = CURRENT.resolve(strict=True)
    active = version(previous)
    target = ""
    try:
        report("checking", active, target)
        target = output(GIT + ["ls-remote", "--exit-code", REPO, "refs/heads/main"]).split()[0]
        if not re.fullmatch(r"[0-9a-f]{40}", target):
            raise ValueError("Invalid main revision")
        destination = ROOT / target
        if previous == destination:
            report("current", active, target)
            return
        report("testing", active, target)
        if not destination.exists():
            with tempfile.TemporaryDirectory(dir=ROOT, prefix=".build-") as temp:
                tree = pathlib.Path(temp) / "app"
                subprocess.run(GIT + ["clone", "--quiet", "--depth", "1", "--single-branch", "--branch", "main",
                                      "--no-tags", REPO, str(tree)], timeout=60, check=True)
                if output(GIT + ["-C", str(tree), "rev-parse", "HEAD"]) != target:
                    raise RuntimeError("GitHub main advanced during checkout; retry")
                subprocess.run(["/usr/local/bin/npm", "ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"],
                               cwd=tree, timeout=90, check=True)
                subprocess.run(["/usr/local/bin/node", "--test"], cwd=tree, timeout=60, check=True)
                shutil.rmtree(tree / ".git")
                tree.rename(destination)
        report("activating", active, target)
    except Exception:
        report("failed", active, target)
        raise
    try:
        activate(destination)
    except Exception:
        try:
            activate(previous)
        except Exception:
            report("rollback_failed", "", target)
            raise
        report("rolled_back", active, target)
        raise
    report("live", target, target)


if __name__ == "__main__":
    publish()
