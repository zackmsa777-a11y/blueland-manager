"""Application source shared by the Discord editor and the Git publisher."""
import os
from pathlib import Path, PurePosixPath
import re

ROOTS = ("src", "public", "config", "scripts", "test")
REFERENCES = ("package.json", "package-lock.json", "README.md")
EXTENSIONS = {".js", ".cjs", ".mjs", ".ts", ".json", ".html", ".css", ".svg", ".csv", ".sql", ".md", ".txt"}
MAX_BYTES = 256_000


def editable(path):
    if not isinstance(path, str) or len(path) > 240:
        return False
    parts = path.split("/")
    return (len(parts) >= 2 and parts[0] in ROOTS and PurePosixPath(path).suffix in EXTENSIONS
            and all(re.fullmatch(r"[\w-][\w. -]*", part) and part not in {"node_modules", "__pycache__"}
                    and not part.endswith((" ", ".")) for part in parts))


def read_source(root, path):
    if path not in REFERENCES and not editable(path):
        raise ValueError("اختر ملفًا من مجلدات التطبيق.")
    target = root
    for part in path.split("/"):
        target = target / part
        if target.is_symlink():
            raise ValueError("المسار يحتوي على رابط رمزي.")
    if not target.exists():
        return None
    if not target.is_file() or target.stat().st_size > MAX_BYTES:
        raise ValueError("الملف أكبر من حد المحرّر أو ليس ملفًا نصيًا عاديًا.")
    return target.read_text(encoding="utf-8")


def list_sources(root):
    paths = set()
    for folder in ROOTS:
        start = root / folder
        if start.is_symlink():
            continue
        for parent, dirs, files in os.walk(start):
            parent = Path(parent)
            dirs[:] = [d for d in dirs if not d.startswith(".") and d not in {"node_modules","__pycache__"}
                       and not (parent/d).is_symlink()]
            for name in files:
                file = parent/name
                path = file.relative_to(root).as_posix()
                if editable(path) and not file.is_symlink() and file.is_file():
                    paths.add(path)
    return paths
