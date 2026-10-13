#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
"""LocalTeX: native local projects, selectable TeX targets and offline PDF viewing."""
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from socketserver import TCPServer
from pathlib import Path
from urllib.parse import urlparse, parse_qs, quote
import hashlib
import codecs
from collections import OrderedDict
import json
import math
import mimetypes
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import uuid
import webbrowser
import time
import argparse
import errno
import stat
import base64
import socket
import signal
import zipfile
import ipaddress
import unicodedata
import zlib

HOST, PORT = "127.0.0.1", 8765
ALLOWED_HOSTS = {"127.0.0.1", "localhost", "::1"}
REMOTE_MODE = False
ORIGINAL_PATH = os.environ.get("PATH", "")
TEX_DIR = ""
WORKSPACE = Path.home() / "MyLocalTexProjects"
ZIP_UPLOAD_LIMIT = 50 * 1024 * 1024
ZIP_EXPANDED_LIMIT = 200 * 1024 * 1024
ZIP_ENTRY_LIMIT = 10000

def is_within(path, parent):
    """Component-aware containment, including on Python 3.8 pathlib."""
    try:
        path.relative_to(parent)
        return True
    except ValueError:
        return False

def pdf_version(path):
    info=path.stat()
    return str(info.st_size)+":"+str(info.st_mtime_ns)

def check_pdf_version(path, expected):
    if expected and expected!=pdf_version(path):
        error=ValueError("PDF changed on disk. Reload it before using SyncTeX.")
        error.code="STALE_PDF"
        raise error

def portable_zip_parts(name):
    """Reject ambiguous names on every OS, before touching the filesystem."""
    if not name or "\\" in name or name.startswith("/"):
        raise ValueError("ZIP contains an unsafe path.")
    parts = name.rstrip("/").split("/")
    for part in parts:
        if not part or part in {".", ".."} or part.endswith((".", " ")) or any(ord(c)<32 or c in '<>:"|?*' for c in part):
            raise ValueError("ZIP contains a path that is unsafe or incompatible across operating systems.")
        if part.split(".")[0].upper() in {"CON", "PRN", "AUX", "NUL", *(f"COM{i}" for i in range(1,10)), *(f"LPT{i}" for i in range(1,10))}:
            raise ValueError("ZIP contains a reserved Windows filename.")
    return parts

def import_project_zip(archive, filename):
    """Validate completely, extract privately, then publish without overwriting."""
    try:
        with zipfile.ZipFile(archive) as z:
            entries = z.infolist()
            if len(entries)>ZIP_ENTRY_LIMIT or sum(i.file_size for i in entries)>ZIP_EXPANDED_LIMIT:
                raise ValueError("ZIP exceeds 10,000 entries or 200 MiB of extracted data.")
            checked=[]; names={}; spellings={}
            for info in entries:
                # orig_filename retains NUL characters otherwise truncated by zipfile.
                parts=portable_zip_parts(info.orig_filename)
                kind=stat.S_IFMT(info.external_attr >> 16)
                if kind not in {0, stat.S_IFREG, stat.S_IFDIR} or (info.external_attr & 0x400):
                    raise ValueError("ZIP symbolic links and special files are not supported.")
                if info.flag_bits & 1:raise ValueError("Password-protected ZIP files are not supported.")
                if info.compress_type not in {zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED}:
                    raise ValueError("ZIP must use standard stored or deflate compression.")
                if "__MACOSX" in parts or parts[-1]==".DS_Store" or parts[-1].startswith("._"):continue
                key=tuple(unicodedata.normalize("NFC",p).casefold() for p in parts)
                for n in range(1,len(parts)+1):
                    if key[:n] in spellings and spellings[key[:n]]!=tuple(parts[:n]):
                        raise ValueError("ZIP contains case-conflicting or Unicode-conflicting paths.")
                    spellings[key[:n]]=tuple(parts[:n])
                if key in names:raise ValueError("ZIP contains duplicate or case-conflicting paths.")
                names[key]=info.is_dir()
                checked.append((info, parts))
            for key in names:
                if any(names.get(key[:n]) is False for n in range(1,len(key))):
                    raise ValueError("ZIP contains conflicting file and directory paths.")
            tex=[parts for info,parts in checked if not info.is_dir() and parts[-1].lower().endswith('.tex') and not any(p.startswith('.') for p in parts)]
            if not tex:raise ValueError("ZIP does not contain a .tex source file.")
            WORKSPACE.mkdir(parents=True,exist_ok=True)
            with tempfile.TemporaryDirectory(prefix=".localtex-import-",dir=WORKSPACE) as temporary:
                stage=Path(temporary)
                expanded=0
                for info,parts in checked:
                    destination=stage.joinpath(*parts)
                    if info.is_dir():destination.mkdir(parents=True,exist_ok=True);continue
                    destination.parent.mkdir(parents=True,exist_ok=True)
                    with z.open(info) as source, destination.open('xb') as output:
                        while True:
                            chunk=source.read(1024*1024)
                            if not chunk:break
                            expanded+=len(chunk)
                            if expanded>ZIP_EXPANDED_LIMIT:raise ValueError("ZIP extracted data is too large.")
                            output.write(chunk)
                children=list(stage.iterdir())
                payload=children[0] if len(children)==1 and children[0].is_dir() else stage
                stem=Path(str(filename).replace('\\','/')).stem
                name=re.sub(r'[<>:"/\\|?*\x00-\x1f]', '_', stem).strip(' .')[:100] or 'Imported project'
                try:portable_zip_parts(name)
                except ValueError:name='Imported project'
                # Exclusive mkdir also protects simultaneous imports in different processes.
                number=1
                while True:
                    target=WORKSPACE / (name if number==1 else f"{name} ({number})")
                    try:target.mkdir();break
                    except FileExistsError:number+=1
                try:
                    for child in payload.iterdir():child.rename(target/child.name)
                    sources=sorted(p for p in target.rglob('*') if p.is_file() and p.suffix.lower()=='.tex' and not any(v.startswith('.') for v in p.relative_to(target).parts))
                    main=next((p for p in sources if p.parent==target and p.name.lower()=='main.tex'),None)
                    if main is None:
                        for source in sources:
                            with source.open('rb') as f:head=f.read(65536)
                            if re.search(rb'(?m)^[^%\r\n]*\\documentclass\b',head):main=source;break
                    main=main or sources[0]
                    return register_project(target,main.relative_to(target).as_posix())
                except Exception:
                    shutil.rmtree(target)
                    raise
    except (zipfile.BadZipFile, RuntimeError, NotImplementedError, EOFError, zlib.error) as e:
        raise ValueError("Invalid, corrupted or unsupported ZIP archive.") from e

def configure_tex_path(folder):
    global TEX_DIR
    if folder:
        p=Path(folder).expanduser().resolve()
        if not p.is_dir():raise ValueError("Choose an existing TeX binaries directory on the server.")
        TEX_DIR=str(p)
    else:TEX_DIR=""
    os.environ["PATH"]=(TEX_DIR+os.pathsep if TEX_DIR else "")+ORIGINAL_PATH

def capabilities(remote_access=False):
    tools={name:shutil.which(name) for name in ("latexmk","pdflatex","xelatex","lualatex","synctex")}
    warnings=[]
    try:
        import tkinter
        tk_available=True
    except ImportError:
        tk_available=False
    reason=""
    tk_guidance="Tkinter/Tcl-Tk is missing from the Python installation running LocalTeX. Enable Tcl/Tk support using your Python installer's optional components, your operating system's package manager, or your Python environment manager. Check it with: python -m tkinter (use the same interpreter that starts LocalTeX). Then restart LocalTeX. The browser picker remains available without Tcl/Tk."
    remote=REMOTE_MODE or remote_access or any(os.environ.get(k) for k in ("SSH_CONNECTION","SSH_CLIENT","SSH_TTY"))
    if remote:
        reason="Remote session detected. Native dialogs open on the server, so the browser picker is used."
    elif not tk_available:
        reason=tk_guidance
    elif sys.platform.startswith("linux") and not (os.environ.get("DISPLAY") or os.environ.get("WAYLAND_DISPLAY")):
        reason="No graphical desktop is available to the server. The browser picker is used."
    if reason:warnings.append(reason)
    if not tk_available and reason!=tk_guidance:warnings.append(tk_guidance)
    if not any(tools[name] for name in ("pdflatex","xelatex","lualatex")):
        warnings.append("No TeX engine was found on PATH. Install a TeX distribution to compile documents. If already installed, use --tex-path DIR or Apply TeX path in the UI to specify its binaries directory. Editing and browsing still work.")
    elif not tools["latexmk"]:
        warnings.append("latexmk was not found. Install it for automatic multi-pass builds; the installed TeX engine remains available.")
    if not tools["synctex"]:
        warnings.append("SyncTeX was not found on PATH. Install your TeX distribution's SyncTeX utility to enable source/PDF navigation.")
    return {"nativePicker":not reason,"pickerReason":reason,"remote":remote,"tkinter":tk_available,"tools":tools,"warnings":warnings,"texPath":TEX_DIR,"workspace":str(WORKSPACE),"zipUploadLimit":ZIP_UPLOAD_LIMIT}

def source_format(data):
    bom = data.startswith(b"\xef\xbb\xbf")
    try:
        text = data.decode("utf-8-sig" if bom else "utf-8")
    except UnicodeDecodeError:
        raise ValueError("Source is not valid UTF-8. Convert a copy to UTF-8 before editing; the original has not been changed.")
    newline = "\r\n" if "\r\n" in text else "\r" if "\r" in text else "\n"
    return text.replace("\r\n", "\n").replace("\r", "\n"), bom, newline

def encode_source(text, original):
    stripped=original.replace(b"\r\n",b"")
    if sum((b"\r\n" in original,b"\n" in stripped,b"\r" in stripped))>1:
        raise ValueError("Source has mixed newline styles. Normalize a copy before saving; the original has not been changed.")
    _, bom, newline = source_format(original)
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    return (b"\xef\xbb\xbf" if bom else b"") + text.replace("\n", newline).encode("utf-8")

class LocalServer(ThreadingHTTPServer):
    allow_reuse_address = os.name != "nt"
    daemon_threads = True
    def server_bind(self):
        if os.name == "nt" and hasattr(socket,"SO_EXCLUSIVEADDRUSE"):
            self.socket.setsockopt(socket.SOL_SOCKET,socket.SO_EXCLUSIVEADDRUSE,1)
        # HTTPServer.server_bind performs getfqdn(), which can block in the OS
        # resolver even for loopback (seen on macOS CI). No DNS is needed here.
        TCPServer.server_bind(self)
        self.server_name=self.server_address[0]
        self.server_port=self.server_address[1]

def bind_server(port):
    try:
        return LocalServer((HOST, port), Handler)
    except OSError as e:
        if e.errno != errno.EADDRINUSE and getattr(e, "winerror", None) != 10048:
            raise
        server = LocalServer((HOST, 0), Handler)
        print(f"Port {port} is busy; using {server.server_port}.")
        return server
WEB_ROOT = Path(__file__).resolve().parent / "web"
TEXT_EXTENSIONS = {".tex", ".bib", ".sty", ".cls", ".txt", ".md", ".csv", ".tikz", ".bst", ".cfg", ".def"}
PROJECTS = {}
DEFAULT_PROJECT = None
FILE_LOCK, BUILD_LOCK, PICKER_LOCK = threading.Lock(), threading.Lock(), threading.Lock()
RECENT_LOCK = threading.Lock()
RECENT_FILE = Path(os.environ.get("LOCALTEX_RECENTS", str(
    Path(os.environ.get("LOCALAPPDATA", str(Path.home() / ".config"))) / "LocalTeX" / "recent-projects.json")))

def recent_projects():
    try:
        records = json.loads(RECENT_FILE.read_text(encoding="utf-8"))
        return records[:20] if isinstance(records, list) else []
    except (OSError, ValueError):
        return []

def remember_project(root, main):
    identity = hashlib.sha256((str(root) + "\0" + (main or "")).encode()).hexdigest()[:24]
    record = {"id": identity, "path": str(root), "main": main,
              "name": root.name or str(root)}
    try:
        with RECENT_LOCK:
            records = [record] + [r for r in recent_projects() if r.get("id") != identity]
            RECENT_FILE.parent.mkdir(parents=True, exist_ok=True)
            with tempfile.NamedTemporaryFile(dir=RECENT_FILE.parent, delete=False, mode="w", encoding="utf-8") as f:
                json.dump(records[:20], f, ensure_ascii=False)
                temporary = f.name
            os.replace(temporary, RECENT_FILE)
    except OSError as e:
        print(f"Could not update recent projects: {e}")

def parse_diagnostics(root, source, text):
    """Parse TeX log records, retaining safe project-relative source locations."""
    initial = source.relative_to(root).as_posix()
    def resolve(name):
        name = name.strip().strip('"').replace("\\", "/")
        try:
            path = (source.parent / name).resolve()
            return path.relative_to(root).as_posix() if is_within(path, root) else None
        except (OSError, ValueError):
            return None
    records, seen = [], set()
    stack, depth = [(0, initial)], 0
    lines = text.replace("\r\n", "\n").splitlines()
    i = 0
    while i < len(lines):
        raw = lines[i]
        current = stack[-1][1] if stack else initial
        explicit = re.match(r'^(.+?\.(?:tex|tikz|sty|cls|bib|bbl|cfg|def|aux)):(\d+):\s*(.*)', raw, re.I)
        warning = re.match(r'^(?:LaTeX(?: Font)?|Package .+?|Class .+?|(?:pdf|Lua|Xe)TeX)\s+Warning:\s*(.*)', raw)
        box = re.match(r'^(Overfull|Underfull)\s+\\[hv]box\b.*', raw)
        engine = re.search(r'\b(WARN|ERROR)\s+-\s*(.+)', raw)
        severity, message, line, end_line, path = None, "", None, None, current
        if explicit:
            path, line, message, severity = resolve(explicit[1]), int(explicit[2]), explicit[3], "error"
            if "Warning:" in message:
                severity = "warning"
        elif raw.startswith("!"):
            severity, message = "error", raw.lstrip("! ").strip()
        elif warning:
            severity, message = "warning", raw.strip()
        elif box:
            severity, message = "warning", raw.strip()
        elif engine:
            severity, message, path = ("warning" if engine[1] == "WARN" else "error"), engine[2], None
        if severity:
            # TeX wraps diagnostics across lines; package continuations have a prefix.
            j = i + 1
            while j < min(len(lines), i + 12):
                following = lines[j]
                if re.match(r'^l\.(\d+)\s', following):
                    if line is None:
                        line = int(re.match(r'^l\.(\d+)', following)[1])
                    break
                continuation = severity == "warning" and re.match(r"^\([a-zA-Z0-9 ._-]+\)\s+\S", following)
                if not following.strip() or (following.startswith(("!", "(", ")", "Overfull", "Underfull")) and not continuation):
                    break
                if re.match(r'^.+\.(?:tex|sty|cls|tikz|bbl):\d+:|^(?:LaTeX|Package|Class).*Warning:', following):
                    break
                if following.startswith(("See the", "Type ", "For immediate", "Here is", "Output written", "Transcript", "LaTeX Font Info")):
                    break
                if severity == "error":
                    # Error descriptions can be followed by TeX's help paragraph.
                    if line is not None or j > i + 3:
                        break
                    if following.startswith(" "):
                        break
                message += " " + re.sub(r'^\([^)]+\)\s*', "", following).strip()
                j += 1
            # File-line errors often precede a help block and then an l.N record.
            if severity == "error" and line is None:
                for following in lines[i+1:i+12]:
                    m = re.match(r'^l\.(\d+)\b', following)
                    if m:
                        line = int(m[1]); break
                    if following.startswith("!"):
                        break
            location = re.search(r'(?:on input li\s*ne|at li\s*nes?)\s+(\d+)(?:--(\d+))?', message)
            if location:
                line = line or int(location[1])
                end_line = int(location[2]) if location[2] else None
            identity = (severity, path, line, message)
            if identity not in seen:
                seen.add(identity)
                records.append({"severity": severity, "path": path, "line": line,
                                "endLine": end_line, "message": message})
        # Track TeX's nested "(./file.tex ...)" inclusions, including whitespace paths.
        for token in re.finditer(r'\(|\)', raw):
            if token[0] == "(":
                depth += 1
                m = re.match(r'\(?("?[^()\n]*?\.(?:tex|tikz|sty|cls|bib|bbl|cfg|def|aux)"?)(?=\s|\)|$)',
                             raw[token.end():], re.I)
                if m:
                    candidate = resolve(m[1])
                    if candidate:
                        stack.append((depth, candidate))
            else:
                while len(stack) > 1 and stack[-1][0] >= depth:
                    stack.pop()
                depth = max(0, depth - 1)
        i += 1
    return records


def tikz_symbols(text):
    text = re.sub(r"(?<!\\)%[^\n]*", "", text)
    colors = set(re.findall(r"\\(?:definecolor|providecolor|colorlet)\s*\{([^{}]+)\}", text))
    nodes = set(re.findall(r"\\(?:node|coordinate)\b(?:\s*\[[^\]]*\])?\s*\(([^()]+)\)", text))
    nodes.update(re.findall(r"\bnode(?:\s*\[[^\]]*\])?\s*\(([^()]+)\)", text))
    styles = set(re.findall(r"([^{}\[\],=\n]+?)/\.(?:style|append style|style args|code|code args)\s*=", text))
    styles.update(re.findall(r"\\tikzstyle\s*\{([^{}]+)\}", text))
    pics = set(re.findall(r"(?:pics/|pics\s*=\s*\{\s*)([^{}\n,=]+?)/\.style", text))
    return {"colors": sorted(colors), "nodes": sorted(nodes),
            "styles": sorted(s.strip() for s in styles if s.strip() and not s.strip().startswith("pics/")),
            "pics": sorted(s.strip() for s in pics)}

def completion_index(root):
    citations, labels, commands, environments = {}, set(), set(), set()
    tikz = []
    budget = 10_000_000
    for p in sorted(root.rglob("*")):
        if p.suffix.lower() not in {".tex", ".tikz", ".bib", ".sty", ".cls"} or not p.is_file():
            continue
        if any(v.startswith(".") for v in p.relative_to(root).parts) or not is_within(p.resolve(), root):
            continue
        size = p.stat().st_size
        if size > 2_000_000 or size > budget:
            continue
        budget -= size
        text = p.read_text(encoding="utf-8", errors="replace")
        if p.suffix.lower() != ".bib":
            tikz.append({"source": p.relative_to(root).as_posix(), **tikz_symbols(text)})
        if p.suffix.lower() == ".bib":
            for m in re.finditer(r"@([a-zA-Z]+)\s*[{(]\s*([^\s,{}()]+)\s*,", text):
                if m[1].lower() not in {"comment", "string", "preamble"}:
                    entry={"key":m[2],"source":p.relative_to(root).as_posix()}
                    end=text.find("\n@",m.end());body=text[m.end():end if end>=0 else len(text)]
                    for field in ("title","author","year"):
                        value=re.search(r'\b'+field+r'\s*=\s*(?:\{(.*?)\}\s*[,}]|"([^"]*)"|(\d+))',body,re.S|re.I)
                        if value:entry[field]=re.sub(r"[{}\n]","",next(x for x in value.groups() if x is not None))
                    citations[m[2]]=entry
        else:
            text = re.sub(r"(?<!\\)%[^\n]*", "", text)
            labels.update(re.findall(r"\\label\s*\{([^{}]+)\}", text))
            commands.update(re.findall(r"\\(?:newcommand|renewcommand|providecommand|DeclareMathOperator)\*?\s*\{?\\([a-zA-Z]+)", text))
            environments.update(re.findall(r"\\(?:newenvironment|renewenvironment|newtheorem)\*?\s*\{([^{}]+)\}", text))
    return {"citations": list(citations.values()), "labels": sorted(labels), "commands": sorted(commands),
            "environments": sorted(environments), "tikz": tikz}


JOBS, JOB_LOCK = {}, threading.Lock()
SHUTTING_DOWN = threading.Event()

def private_dir(root, name):
    base = root / ".localtex"
    if base.is_symlink():
        raise ValueError("LocalTeX metadata directory must not be a symbolic link.")
    path = base / name
    if path.is_symlink():
        raise ValueError("LocalTeX metadata must not be a symbolic link.")
    path.mkdir(parents=True, exist_ok=True)
    return path

def atomic_json(path, data):
    if path.is_symlink():
        raise ValueError("Metadata files must not be symbolic links.")
    temp = None
    try:
        with tempfile.NamedTemporaryFile(dir=path.parent, mode="w", encoding="utf-8", delete=False) as f:
            json.dump(data, f, ensure_ascii=False)
            temp = f.name
            f.flush(); os.fsync(f.fileno())
        os.replace(temp, path)
    finally:
        if temp and os.path.exists(temp): os.unlink(temp)

def project_settings(root):
    path = root / ".localtex" / "settings.json"
    if path.is_symlink() or path.parent.is_symlink():
        raise ValueError("Invalid settings path.")
    try:
        result = json.loads(path.read_text(encoding="utf-8"))
        return result if isinstance(result, dict) else {"targets": {}}
    except (OSError, ValueError):
        return {"targets": {}}

def validate_target_options(root, target, options):
    source = safe_path(root, target)
    if not source.is_file() or source.suffix.lower() != ".tex":
        raise ValueError("Choose an existing .tex target.")
    engine = options.get("engine", "pdflatex")
    if engine not in {"pdflatex", "xelatex", "lualatex"}:
        raise ValueError("Choose pdfLaTeX, XeLaTeX or LuaLaTeX.")
    timeout = int(options.get("timeout", 120))
    if not 10 <= timeout <= 1800: raise ValueError("Timeout must be 10–1800 seconds.")
    dependencies = options.get("dependencies", [])
    if not isinstance(dependencies, list) or len(dependencies) > 50:
        raise ValueError("Use at most 50 dependency targets.")
    for rel in dependencies:
        p = safe_path(root, rel)
        if not p.is_file() or p.suffix.lower() != ".tex": raise ValueError("Dependencies must be existing .tex files.")
        if p == source: raise ValueError("A target cannot depend on itself.")
    return {"engine":engine,"stopOnError":bool(options.get("stopOnError")),
            "timeout":timeout,"dependencies":list(dict.fromkeys(dependencies))}

def build_order(root, target, settings):
    result, visiting, done = [], set(), set()
    def visit(rel):
        if rel in visiting: raise ValueError("Build dependency cycle: " + rel)
        if rel in done: return
        visiting.add(rel)
        options = validate_target_options(root, rel, settings.get("targets", {}).get(rel, {}))
        for dependency in options["dependencies"]: visit(dependency)
        visiting.remove(rel);done.add(rel);result.append((rel,options))
    visit(target)
    return result

def read_snapshot(path):
    if path.is_symlink(): raise ValueError("Invalid snapshot path.")
    entry = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(entry, dict) or not isinstance(entry.get("text"), str):
        raise ValueError("Invalid snapshot contents.")
    if not isinstance(entry.get("path"), str) or not isinstance(entry.get("time"), (int,float)):
        raise ValueError("Invalid snapshot metadata.")
    if entry.get("id")!=path.stem or not re.fullmatch(r"(?:[a-f0-9]{32}|[a-f0-9]{64})",path.stem):
        raise ValueError("Invalid snapshot identifier; original record has been preserved.")
    if entry.get("textDigest") and hashlib.sha256(entry["text"].encode("utf-8")).hexdigest() != entry["textDigest"]:
        raise ValueError("Snapshot checksum failed; original record has been preserved.")
    return entry

LEGACY_SNAPSHOT_INDEX = OrderedDict()

def legacy_snapshot_index(folder, rel):
    # Older UUID snapshots remain authoritative. This small, rebuildable index
    # avoids decoding all their source texts on each save (including after restart).
    index_path=folder/".legacy-index"
    try:
        if index_path.is_symlink(): return {}
        stamp=index_path.stat().st_mtime_ns
    except OSError: stamp=None
    key=str(folder)
    cached=LEGACY_SNAPSHOT_INDEX.get(key)
    if cached and cached[0]==stamp:
        LEGACY_SNAPSHOT_INDEX.move_to_end(key);return cached[1]
    entries=None
    if stamp is not None:
        try:
            index=json.loads(index_path.read_text(encoding="utf-8"))
            if index.get("schema")==1 and index.get("path")==rel and isinstance(index.get("entries"),dict):
                entries={digest:token for digest,token in index["entries"].items()
                    if re.fullmatch(r"[a-f0-9]{64}",digest) and isinstance(token,str) and re.fullmatch(r"[a-f0-9]{32}",token)}
        except (OSError,ValueError,AttributeError,TypeError): pass
    if entries is None:
        entries={}
        for path in folder.glob("*.json"):
            if not re.fullmatch(r"[a-f0-9]{32}",path.stem): continue
            try:
                entry=read_snapshot(path);digest=entry.get("digest","")
                if entry["path"]==rel and isinstance(digest,str) and re.fullmatch(r"[a-f0-9]{64}",digest):
                    entries.setdefault(digest,path.stem)
            except (OSError,ValueError,KeyError,TypeError): pass
        try:
            atomic_json(index_path,{"schema":1,"path":rel,"entries":entries})
            stamp=index_path.stat().st_mtime_ns
        except (OSError,ValueError): pass # Index failure must never discard source or history.
    LEGACY_SNAPSHOT_INDEX[key]=(stamp,entries)
    if len(LEGACY_SNAPSHOT_INDEX)>128: LEGACY_SNAPSHOT_INDEX.popitem(last=False)
    return entries

def add_snapshot(root, rel, data, digest=None):
    folder = private_dir(root, "history") / hashlib.sha256(rel.encode()).hexdigest()
    if folder.is_symlink(): raise ValueError("Invalid history directory.")
    folder.mkdir(exist_ok=True)
    digest = digest or hashlib.sha256(data).hexdigest()
    destination=folder/(digest+".json")
    if destination.is_symlink(): raise ValueError("Invalid snapshot path.")
    if destination.exists():
        try:
            entry=read_snapshot(destination)
            if entry["path"]==rel and entry.get("digest")==digest and entry.get("textDigest")==digest:
                return digest
        except (OSError,ValueError,KeyError,TypeError): pass
        # Retain damaged records for manual recovery instead of overwriting them.
        destination.rename(folder/("corrupt-"+uuid.uuid4().hex+".json"))
    text=data.decode("utf-8")
    legacy_token=legacy_snapshot_index(folder,rel).get(digest)
    if legacy_token:
        try:
            entry=read_snapshot(folder/(legacy_token+".json"))
            if entry["path"]==rel and entry.get("digest")==digest and (entry["text"]==text or entry["text"]==text.replace("\r\n","\n")):
                return digest
        except (OSError,ValueError,KeyError,TypeError): pass
    atomic_json(destination,{"id":digest,"path":rel,"time":time.time(),"digest":digest,
        "textDigest":digest,"text":text})
    # Recovery is a last resort: never silently prune old versions or skip large files.
    return digest

def history_records(root, rel, token=None):
    safe_path(root,rel)
    folder = private_dir(root,"history") / hashlib.sha256(rel.encode()).hexdigest()
    if folder.is_symlink(): raise ValueError("Invalid history directory.")
    if token:
        if not re.fullmatch(r"(?:[a-f0-9]{32}|[a-f0-9]{64})",token): raise ValueError("Invalid snapshot.")
        entry = read_snapshot(folder/(token+".json"))
        if entry["path"] != rel: raise ValueError("Snapshot belongs to another file.")
        entry["text"] = source_format(entry["text"].encode("utf-8"))[0]
        return entry
    versions={}; unreadable=0
    if folder.is_dir():
        for p in folder.glob("*.json"):
            try:
                entry=read_snapshot(p)
                if entry["path"] != rel: raise ValueError("Wrong snapshot path.")
                content_key=(entry.get("digest"),hashlib.sha256(entry["text"].encode("utf-8")).hexdigest())
                entry.pop("text",None)
                if content_key not in versions or entry["time"]<versions[content_key]["time"]: versions[content_key]=entry
            except (OSError,ValueError,KeyError,TypeError): unreadable+=1
    return {"snapshots":sorted(versions.values(),key=lambda r:r["time"],reverse=True), "unreadable":unreadable}


def project_texts(root):
    budget=20_000_000
    for p in sorted(root.rglob("*")):
        rel=p.relative_to(root)
        if not p.is_file() or p.suffix.lower() not in TEXT_EXTENSIONS or any(x.startswith(".") for x in rel.parts):
            continue
        if not is_within(p.resolve(), root) or p.stat().st_size>2_000_000:continue
        budget-=p.stat().st_size
        if budget<0:break
        yield rel.as_posix(),p.read_text(encoding="utf-8",errors="replace").replace("\r\n","\n")

def search_project(root, data):
    query = data.get("query","")
    if not isinstance(query,str) or len(query)>500: raise ValueError("Use a query of at most 500 characters.")
    if not query:return {"matches":[],"truncated":False}
    overrides=data.get("drafts",{})
    matches=[]
    for rel,disk in project_texts(root):
        text=overrides.get(rel,disk)
        pattern=re.compile(re.escape(query),0 if data.get("caseSensitive") else re.I)
        for match in pattern.finditer(text):
            found=match.start()
            line=text.count("\n",0,found)+1
            line_start=text.rfind("\n",0,found)+1
            line_end=text.find("\n",found)
            snippet=text[line_start:line_end if line_end>=0 else len(text)]
            matches.append({"path":rel,"line":line,"column":found-line_start+1,"text":snippet[:300]})
            if len(matches)>=500:return {"matches":matches,"truncated":True}
    return {"matches":matches,"truncated":False}

def project_symbols(root, overrides=None):
    records=[]
    for rel,text in project_texts(root):
        text=(overrides or {}).get(rel,text)
        if rel.lower().endswith(".bib"):
            for m in re.finditer(r"@([a-zA-Z]+)\s*[{(]\s*([^\s,{}()]+)\s*,",text):
                if m[1].lower() in {"comment","string","preamble"}:continue
                end=text.find("\n@",m.end());body=text[m.end():end if end>=0 else len(text)]
                fields={}
                for field in ("title","author","year"):
                    field_match=re.search(r'\b'+field+r'\s*=\s*(?:\{([^"]*?)\}\s*[,}]|"([^"]*)"|(\d+))',body,re.I|re.S)
                    if field_match:fields[field]=re.sub(r"[{}\n]","",next(x for x in field_match.groups() if x is not None)).strip()
                records.append({"kind":"citation","key":m[2],"path":rel,"line":text.count("\n",0,m.start())+1,**fields})
        else:
            text=re.sub(r"(?<!\\)%[^\n]*","",text)
            for m in re.finditer(r"\\label\s*\{([^{}]+)\}",text):
                records.append({"kind":"label","key":m[1],"path":rel,"line":text.count("\n",0,m.start())+1})
            for m in re.finditer(r"\\(?:newcommand|renewcommand|providecommand|DeclareMathOperator)\*?\s*\{?\\([a-zA-Z]+)",text):
                records.append({"kind":"command","key":m[1],"path":rel,"line":text.count("\n",0,m.start())+1})
    return records

def terminate_build(job, force_tree=False):
    process=job.get("process")
    notes=[]
    if not process or not force_tree and process.poll() is not None:return notes
    if os.name=="nt":
        try:
            result=subprocess.run(["taskkill","/PID",str(process.pid),"/T","/F"],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,
                                  timeout=5,creationflags=getattr(subprocess,"CREATE_NO_WINDOW",0))
            if result.returncode and process.poll() is None:notes.append("Windows process-tree cleanup failed.")
        except (OSError,subprocess.TimeoutExpired) as e:
            notes.append("Windows process-tree cleanup failed: "+str(e))
    else:
        import signal
        try:os.killpg(process.pid,signal.SIGKILL)
        except ProcessLookupError:pass
        except OSError as e:notes.append("Process-group cleanup failed: "+str(e))
    if process.poll() is None:
        try:process.kill()
        except OSError as e:notes.append("Process cleanup failed: "+str(e))
    return notes

def streamed_command(cmd,cwd,timeout,job):
    options={"creationflags":getattr(subprocess,"CREATE_NO_WINDOW",0)} if os.name=="nt" else {"start_new_session":True}
    proc=subprocess.Popen(cmd,cwd=cwd,stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,**options)
    job["process"]=proc
    output=[""];stop_reader=threading.Event();notes=[]
    def emit(value):
        if not value:return
        with job["lock"]:
            output[0]=(output[0]+value)[-200000:]
            job["output"]=(job["output"]+value)[-200000:]
    def read():
        decoder=codecs.getincrementaldecoder("utf-8")("replace")
        try:
            while not stop_reader.is_set():
                chunk=proc.stdout.read1(4096)
                if stop_reader.is_set():break
                if not chunk:
                    emit(decoder.decode(b"",final=True));break
                emit(decoder.decode(chunk))
        except (OSError,ValueError) as e:
            if not stop_reader.is_set():emit("\n! Could not read compiler output: "+str(e)+"\n")
    reader=threading.Thread(target=read,daemon=True);reader.start()
    started=time.monotonic();timed_out=False
    try:
        while proc.poll() is None:
            if job["cancel"].is_set() or time.monotonic()-started>timeout:
                timed_out=not job["cancel"].is_set();notes.extend(terminate_build(job));break
            job["cancel"].wait(.1)
        try:proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            notes.extend(terminate_build(job))
            try:proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                job["cleanupFailed"]=proc
                raise RuntimeError("Compiler process "+str(proc.pid)+" could not be stopped. Stop it in the OS task manager before rebuilding.")
        reader.join(2)
        if reader.is_alive():
            # A descendant may hold stdout after latexmk exits. Never wait for
            # pipe EOF indefinitely, and clean the remaining process group.
            notes.extend(terminate_build(job,force_tree=True));reader.join(1)
            if reader.is_alive():notes.append("A compiler child still holds the output pipe; check for leftover TeX/Biber processes.")
        if notes:emit("\n! "+"\n! ".join(notes)+"\n")
        with job["lock"]:stdout=output[0]
        if timed_out:raise subprocess.TimeoutExpired(cmd,timeout,output=stdout)
        return subprocess.CompletedProcess(cmd,proc.returncode,stdout)
    finally:
        stop_reader.set();job["process"]=None
        if not reader.is_alive():proc.stdout.close()

def clean_target(root, source):
    # Move only known helper files for this basename; preserve sources, PDFs and .bbl.
    suffixes=[".aux",".log",".out",".toc",".lof",".lot",".fls",".fdb_latexmk",".bcf",".run.xml",".synctex.gz",".synctex",".xdv",".nav",".snm"]
    destination=private_dir(root,"clean-backups")/uuid.uuid4().hex
    for suffix in suffixes:
        path=source.parent/(source.stem+suffix)
        if path.is_file() and not path.is_symlink():
            destination.mkdir(exist_ok=True)
            path.rename(destination/path.name)
    return str(destination.relative_to(root)) if destination.exists() else None

def start_build(handler, key, root, target, clean=False):
    if SHUTTING_DOWN.is_set():raise ValueError("Server is shutting down; no new builds can start.")
    settings=project_settings(root)
    order=build_order(root,target,settings)
    if not BUILD_LOCK.acquire(blocking=False):raise ValueError("Another build is running. Try again after it finishes.")
    token=uuid.uuid4().hex
    job={"id":token,"project":key,"state":"running","target":target,"output":"","cancel":threading.Event(),
         "lock":threading.Lock(),"process":None,"result":None,"steps":[]}
    with JOB_LOCK:
        if SHUTTING_DOWN.is_set():
            BUILD_LOCK.release()
            raise ValueError("Server is shutting down; no new builds can start.")
        for previous in JOBS.values():
            process=previous.get("cleanupFailed")
            if process and process.poll() is None:
                BUILD_LOCK.release()
                raise ValueError("A previous compiler process could not be stopped. Stop process "+str(process.pid)+" in the OS task manager before rebuilding.")
        for old in [k for k,v in JOBS.items() if v["state"]!="running"][:-20]:JOBS.pop(old,None)
        JOBS[token]=job
    def work():
        try:
            diagnostics=[];last=None
            for rel,options in order:
                if job["cancel"].is_set():break
                with job["lock"]:job["output"]+="\n=== Building "+rel+" ("+options["engine"]+") ===\n"
                last=handler.compile(root,rel,options,job,clean)
                job["steps"].append({"target":rel,"ok":last["ok"]})
                diagnostics.extend(last["diagnostics"])
                if not last["ok"]:break
            if job["cancel"].is_set():
                job["result"]={"ok":False,"cancelled":True,"target":target,"diagnostics":diagnostics,"output":job["output"]};job["state"]="cancelled"
            else:
                if last is None:raise ValueError("No target compiled.")
                last["diagnostics"]=diagnostics;last["steps"]=job["steps"];last["output"]=job["output"][-50000:];job["result"]=last
                job["state"]="done"
        except Exception as e:
            job["result"]={"ok":False,"target":target,"output":job["output"],"diagnostics":[{"severity":"error","path":None,"line":None,"message":str(e)}]}
            job["state"]="done"
        finally:BUILD_LOCK.release()
    job["thread"]=threading.Thread(target=work,daemon=True)
    job["thread"].start()
    return token

def native_pick(kind, initial=None):
    # In a separate process when called from HTTP, so Tk owns its main thread.
    import tkinter as tk
    from tkinter import filedialog
    root = tk.Tk()
    root.withdraw()
    root.attributes("-topmost", True)
    try:
        options = {"parent": root, "initialdir": initial or str(Path.home())}
        if kind == "folder":
            return filedialog.askdirectory(title="Open LocalTeX project folder", **options)
        return filedialog.askopenfilename(title="Open a TeX document", filetypes=[("TeX documents", "*.tex"), ("All files", "*.*")], **options)
    finally:
        root.destroy()

def shutdown_builds(timeout=20):
    """Stop owned compiler trees before exiting; never leave cleanup unbounded."""
    with JOB_LOCK:
        SHUTTING_DOWN.set()
        jobs=list(JOBS.values())
        for job in jobs:
            if job["state"]=="running":job["cancel"].set()
    deadline=time.monotonic()+timeout
    for job in jobs:
        worker=job.get("thread")
        if worker and worker.is_alive():worker.join(max(0,deadline-time.monotonic()))
        process=job.get("process") or job.get("cleanupFailed")
        if process and process.poll() is None:
            for note in terminate_build({"process":process}):print(note)
            try:process.wait(timeout=5)
            except subprocess.TimeoutExpired:print("Compiler process "+str(process.pid)+" did not stop; terminate it in the OS task manager.")


def safe_path(root, rel):
    if not isinstance(rel, str) or not rel:
        raise ValueError("Choose a file first.")
    p = (root / rel).resolve()
    if not is_within(p, root):
        raise ValueError("Path escapes project folder.")
    return p

def register_project(path, main=None):
    p = Path(path).expanduser().resolve()
    if p.is_file():
        if p.suffix.lower() != ".tex":
            raise ValueError("Choose a .tex document or a project folder.")
        root, target = p.parent, p.name
    elif p.is_dir():
        root = p
        if main:
            source = safe_path(root, main)
            if not source.is_file() or source.suffix.lower() != ".tex":
                raise ValueError("The requested initial TeX document does not exist.")
            target = source.relative_to(root).as_posix()
        else:
            tex = sorted(f for f in root.rglob("*.tex") if is_within(f.resolve(), root)
                         and not any(v.startswith(".") for v in f.relative_to(root).parts))
            target = "main.tex" if (root / "main.tex").is_file() else (tex[0].relative_to(root).as_posix() if tex else None)
    else:
        raise ValueError("The selected file or folder does not exist.")
    key = uuid.uuid4().hex
    PROJECTS[key] = {"root": root, "main": target}
    remember_project(root, target)
    return key

def config_for(key):
    project = PROJECTS[key]
    return {"projectId": key, "projectRoot": str(project["root"]), "mainTex": project["main"],
            "synctex": shutil.which("synctex"),
            "compiler": shutil.which("latexmk") or shutil.which("pdflatex")}

def valid_new_path(root, rel):
    # Accept portable relative names, including nested directories and Unicode.
    if not isinstance(rel, str):
        raise ValueError("Enter a relative path.")
    rel = rel.replace("\\", "/")
    if not rel or rel.startswith("/") or any(
        part in {"", ".", "..", ".localtex", ".localtex-trash"} or part.endswith((" ", ".")) or
        re.search(r'[<>:"|?*\x00-\x1f]', part) or
        re.match(r"^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)", part, re.I)
        for part in rel.split("/")
    ):
        raise ValueError("Use a relative file/folder name without '..' or reserved filename characters.")
    return safe_path(root, rel)

def trash_operation(root, data, restore=False):
    trash = root / ".localtex-trash"
    if trash.is_symlink():
        raise ValueError("Local trash must not be a symbolic link.")
    if restore:
        token = data.get("token", "")
        if not re.fullmatch(r"[a-f0-9]{32}", token):
            raise ValueError("Invalid restore token.")
        entry = trash / token
        if entry.is_symlink() or (entry / "item").is_symlink():
            raise ValueError("Invalid trash entry.")
        meta = json.loads((entry / "info.json").read_text(encoding="utf-8"))
        destination = valid_new_path(root, meta["path"])
        if destination.exists() or destination.is_symlink():
            raise ValueError("The original path is occupied. Move that item before restoring.")
        destination.parent.mkdir(parents=True, exist_ok=True)
        (entry / "item").rename(destination)
        (entry / "info.json").unlink()
        entry.rmdir()
        return {"ok": True, "path": meta["path"], "kind": meta["kind"]}
    rel = data.get("path")
    target = valid_new_path(root, rel)
    if target == root or is_within(target, trash):
        raise ValueError("The project root and local trash cannot be deleted.")
    # Do not follow links and delete a different item from the one selected.
    raw = root / rel
    if any(p.is_symlink() for p in [raw, *raw.parents] if is_within(p, root)):
        raise ValueError("Deleting symbolic links is not supported.")
    if not target.exists():
        raise ValueError("The selected item no longer exists.")
    kind = "folder" if target.is_dir() else "file"
    token = uuid.uuid4().hex
    entry = trash / token
    entry.mkdir(parents=True)
    meta = {"path": target.relative_to(root).as_posix(), "kind": kind}
    (entry / "info.json").write_text(json.dumps(meta), encoding="utf-8")
    try:
        target.rename(entry / "item")
    except Exception:
        (entry / "info.json").unlink()
        entry.rmdir()
        raise
    return {"ok": True, "token": token, **meta}

def run_command(cmd, cwd, timeout, env=None):
    return subprocess.run(cmd, cwd=cwd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                          text=True, encoding="utf-8", errors="replace", timeout=timeout, env=env,
                          creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))

class JsonResponse(Exception):
    """Finish dispatch, unwind operation locks, then write the HTTP response."""
    def __init__(self, payload, status):
        self.payload,self.status=payload,status

class Handler(SimpleHTTPRequestHandler):
    def setup(self):
        super().setup()
        self.connection.settimeout(30)

    def picker_capabilities(self):
        try:remote=not ipaddress.ip_address(self.client_address[0]).is_loopback
        except ValueError:remote=True
        hostname=urlparse("http://"+self.headers.get("Host","")).hostname
        if hostname not in {"localhost","127.0.0.1","::1"}:remote=True
        return capabilities(remote)
    def log_message(self, fmt, *args):
        print("[%s] %s" % (self.log_date_time_string(), fmt % args))

    def send_json(self, obj, status=200):
        if getattr(self,"_defer_json",False):raise JsonResponse(obj,status)
        return self._write_json(obj,status)

    def _write_json(self, obj, status=200):
        data = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def allowed(self):
        authority = self.headers.get("Host", "")
        try:
            parsed = urlparse("http://" + authority)
            valid = parsed.hostname in ALLOWED_HOSTS and parsed.port is not None and parsed.username is None and not parsed.path and not parsed.query and not parsed.fragment
        except ValueError:
            valid = False
        if not valid:
            self.send_error(403, "Invalid host")
            return False
        origin = self.headers.get("Origin")
        if origin and origin != "http://" + authority:
            self.send_error(403, "Cross-origin request denied")
            return False
        return True

    def project(self):
        qs = parse_qs(urlparse(self.path).query)
        key = self.headers.get("X-LocalTeX-Project") or qs.get("project", [DEFAULT_PROJECT])[0]
        if key not in PROJECTS:
            raise ValueError("This project session has ended. Reopen the project.")
        return key, PROJECTS[key]["root"]

    def do_GET(self):
        if not self.allowed():
            return
        parsed = urlparse(self.path)
        try:
            static = {"/": "index.html" if DEFAULT_PROJECT else "home.html", "/editor": "index.html",
                      "/projects": "home.html", "/home.js": "home.js", "/autocomplete.js": "autocomplete.js",
                      "/diagnostics.js": "diagnostics.js", "/tikz-completions.js": "tikz-completions.js", "/app.js": "app.js", "/style.css": "style.css"}
            if parsed.path == "/api/projects":
                return self.send_json({"projects": recent_projects()})
            if parsed.path == "/api/capabilities":
                return self.send_json(self.picker_capabilities())
            if parsed.path == "/api/browse":
                qs = parse_qs(parsed.query)
                p = Path(qs.get("path", [str(Path.home())])[0]).expanduser().resolve()
                if not p.is_dir(): raise ValueError("Choose an existing server directory.")
                entries = []
                for child in p.iterdir():
                    if child.name.startswith("."): continue
                    try:
                        if child.is_dir() or child.is_file() and child.suffix.lower() == ".tex":
                            entries.append({"name":child.name,"path":str(child),"directory":child.is_dir()})
                    except OSError: pass
                return self.send_json({"path":str(p),"parent":str(p.parent),"entries":sorted(entries,key=lambda e:(not e["directory"],e["name"].casefold())),
                    "roots":[str(Path(f"{letter}:\\")) for letter in "ABCDEFGHIJKLMNOPQRSTUVWXYZ" if Path(f"{letter}:\\").is_dir()] if os.name=="nt" else ["/",str(Path.home())]})
            if re.fullmatch(r"/[a-z-]+\.js",parsed.path):
                return self.serve_file(WEB_ROOT / parsed.path[1:])
            if parsed.path in static:
                return self.serve_file(WEB_ROOT / static[parsed.path])
            if parsed.path.startswith("/vendor/"):
                p = (WEB_ROOT / parsed.path.lstrip("/")).resolve()
                if not is_within(p, WEB_ROOT / "vendor"):
                    raise ValueError("Invalid resource path.")
                return self.serve_file(p)
            key, root = self.project()
            qs = parse_qs(parsed.query)
            if parsed.path == "/api/settings":
                return self.send_json(project_settings(root))
            if parsed.path == "/api/history":
                return self.send_json(history_records(root,qs.get("path",[""])[0]))
            if parsed.path == "/api/snapshot":
                return self.send_json(history_records(root,qs.get("path",[""])[0],qs.get("id",[""])[0]))
            if parsed.path == "/api/build":
                job=JOBS.get(qs.get("id",[""])[0])
                if not job or job["project"]!=key:raise ValueError("Build session not found.")
                with job["lock"]:
                    payload={k:job[k] for k in ("id","state","target","output","result")}
                    payload["steps"]=list(job["steps"])
                # A suspended/disconnected browser must never hold the lock
                # needed to drain compiler stdout and finish/cancel the build.
                return self.send_json(payload)
            if parsed.path == "/api/config":
                return self.send_json(config_for(key))
            if parsed.path == "/api/completions":
                return self.send_json(completion_index(root))
            if parsed.path == "/api/files":
                files, directories = [], []
                for p in root.rglob("*"):
                    rel = p.relative_to(root)
                    if any(v.startswith(".") for v in rel.parts) or not is_within(p.resolve(), root):
                        continue
                    if p.is_dir():
                        directories.append(rel.as_posix())
                    elif p.is_file() and (p.suffix.lower() in TEXT_EXTENSIONS | {".pdf"} or p.suffix.lower() not in {".aux",".log",".fls",".fdb_latexmk",".bbl",".blg",".out",".toc",".gz"}):
                        files.append(rel.as_posix())
                return self.send_json({"files": sorted(files), "directories": sorted(directories)})
            if parsed.path == "/api/file":
                rel = qs.get("path", [PROJECTS[key]["main"]])[0]
                p = safe_path(root, rel)
                if p.suffix.lower() not in TEXT_EXTENSIONS:
                    raise ValueError("This file is not an editable text file.")
                data = p.read_bytes()
                return self.send_json({"path": p.relative_to(root).as_posix(),
                    "text": source_format(data)[0],
                    "version": hashlib.sha256(data).hexdigest()})
            if parsed.path == "/api/pdf/state":
                p=safe_path(root,qs.get("path",[None])[0])
                if p.suffix.lower()!=".pdf" or not p.is_file():raise ValueError("PDF file not found.")
                return self.send_json({"version":pdf_version(p)})
            if parsed.path == "/api/pdf":
                rel = qs.get("path", [None])[0]
                p = safe_path(root, rel)
                if p.suffix.lower() != ".pdf":
                    raise ValueError("Choose a PDF file.")
                expected=qs.get("version",[None])[0]
                if expected and expected!=pdf_version(p):raise ValueError("PDF changed while loading. Reload after the build finishes.")
                return self.serve_file(p, "application/pdf")
            if parsed.path == "/api/asset":
                p=safe_path(root,qs.get("path",[""])[0])
                if not p.is_file():raise ValueError("File not found.")
                content=p.read_bytes();self.send_response(200)
                self.send_header("Content-Type","application/octet-stream")
                self.send_header("Content-Disposition","attachment; filename*=UTF-8''"+quote(p.name))
                self.send_header("Content-Length",str(len(content)));self.end_headers();self.wfile.write(content);return
            if parsed.path == "/api/image":
                p=safe_path(root,qs.get("path",[""])[0])
                image_types={".png":"image/png",".jpg":"image/jpeg",".jpeg":"image/jpeg",".gif":"image/gif",".webp":"image/webp",".bmp":"image/bmp",".avif":"image/avif",".ico":"image/x-icon",".svg":"image/svg+xml"}
                if p.suffix.lower() not in image_types:raise ValueError("Unsupported image format.")
                content=p.read_bytes();self.send_response(200)
                self.send_header("Content-Type",image_types[p.suffix.lower()]);self.send_header("X-Content-Type-Options","nosniff")
                self.send_header("Content-Security-Policy","default-src 'none'; style-src 'unsafe-inline'; sandbox")
                self.send_header("Content-Length",str(len(content)));self.send_header("Cache-Control","no-store");self.end_headers();self.wfile.write(content);return
            if parsed.path == "/api/project/download":
                with tempfile.SpooledTemporaryFile(max_size=8*1024*1024) as archive:
                    with BUILD_LOCK,FILE_LOCK,zipfile.ZipFile(archive,"w",zipfile.ZIP_DEFLATED) as z:
                        for p in sorted(root.rglob("*")):
                            rel=p.relative_to(root)
                            if rel.parts[0]==".localtex-trash" or rel.parts[0]==".localtex" and rel.as_posix()!=".localtex/settings.json":continue
                            if p.is_symlink() or not is_within(p.resolve(), root):continue
                            if p.is_file():z.write(p,rel.as_posix())
                            elif p.is_dir():z.writestr(rel.as_posix()+"/",b"")
                    size=archive.tell();archive.seek(0);self.send_response(200)
                    self.send_header("Content-Type","application/zip")
                    self.send_header("Content-Disposition","attachment; filename*=UTF-8''"+quote((root.name or "project")+".zip"))
                    self.send_header("Content-Length",str(size));self.end_headers()
                    shutil.copyfileobj(archive,self.wfile)
                return
            self.send_error(404)
        except Exception as e:
            self.send_json({"error": str(e)}, 400)

    def do_POST(self):
        # All JSON writes occur after dispatch has unwound its with/finally
        # blocks. A stalled client must not retain filesystem or build locks.
        response=None
        self._defer_json=True
        try:
            self.dispatch_post()
        except JsonResponse as completed:
            response=completed
        finally:
            self._defer_json=False
        if response is not None:self._write_json(response.payload,response.status)

    def dispatch_post(self):
        if not self.allowed():
            return
        try:
            n = int(self.headers.get("Content-Length", "0"))
            endpoint = urlparse(self.path).path
            if endpoint == "/api/project/import":
                if n<=0 or n>ZIP_UPLOAD_LIMIT:raise ValueError("Project ZIP must be between 1 byte and 50 MiB.")
                filename=parse_qs(urlparse(self.path).query).get("name",["Imported project.zip"])[0]
                if not filename.lower().endswith('.zip'):raise ValueError("Choose a .zip project archive.")
                # Older supported Python versions expose no seekable() on a
                # SpooledTemporaryFile, which ZipFile needs when reading entries.
                # A real binary temporary file has the complete IO interface.
                with tempfile.TemporaryFile(mode="w+b") as archive:
                    remaining=n
                    while remaining:
                        chunk=self.rfile.read(min(1024*1024,remaining))
                        if not chunk:raise ValueError("Incomplete ZIP upload.")
                        archive.write(chunk);remaining-=len(chunk)
                    archive.seek(0)
                    key=import_project_zip(archive,filename)
                return self.send_json(config_for(key))
            if n < 0 or n > 20_000_000:
                raise ValueError("Request too large.")
            data = json.loads(self.rfile.read(n).decode("utf-8")) if n else {}
            endpoint = urlparse(self.path).path
            if endpoint == "/api/tools":
                if not BUILD_LOCK.acquire(blocking=False):raise ValueError("Wait for the active build before changing TeX tools.")
                try:
                    previous=TEX_DIR
                    configure_tex_path(data.get("texPath",""))
                    try:atomic_json(RECENT_FILE.parent/"tool-path.json",{"texPath":TEX_DIR})
                    except Exception:
                        configure_tex_path(previous);raise
                    return self.send_json(self.picker_capabilities())
                finally:BUILD_LOCK.release()
            if endpoint == "/api/browse/create":
                parent = Path(data["parent"]).expanduser().resolve()
                name = data.get("name", "")
                if not name or name in {".",".."} or any(c in name for c in "/\\\0"):
                    raise ValueError("Enter a single file or folder name.")
                p = valid_new_path(parent, name)
                if data.get("kind") == "folder": p.mkdir(exist_ok=False)
                elif data.get("kind") == "file" and p.suffix.lower() == ".tex":
                    with p.open("x", encoding="utf-8", newline="") as f: f.write("")
                else: raise ValueError("Create a folder or a .tex file.")
                return self.send_json({"path":str(p)})
            if endpoint == "/api/project/recent":
                record = next((r for r in recent_projects() if r.get("id") == data.get("id")), None)
                if not record:
                    raise ValueError("This recent project is no longer listed.")
                return self.send_json(config_for(register_project(record["path"], record.get("main"))))
            if endpoint == "/api/project/open":
                if data.get("path"):
                    return self.send_json(config_for(register_project(data["path"])))
                project_key = self.headers.get("X-LocalTeX-Project") or DEFAULT_PROJECT
                root = PROJECTS[project_key]["root"] if project_key in PROJECTS else Path.home()
                available=self.picker_capabilities()
                if not available["nativePicker"]:
                    return self.send_json({"pickerUnavailable":True,"initial":str(root),"reason":available["pickerReason"]})
                if not PICKER_LOCK.acquire(blocking=False):
                    return self.send_json({"error": "A file picker is already open."}, 409)
                try:
                    kind = data.get("kind")
                    if kind not in {"file", "folder"}:
                        raise ValueError("Choose file or folder.")
                    proc = run_command([sys.executable, str(Path(__file__).resolve()),
                                        "--pick", kind, str(root)], root, 300)
                    result = json.loads(proc.stdout)
                    if result.get("error"):
                        return self.send_json({"pickerUnavailable":True,"initial":str(root),"reason":result["error"]})
                    if not result.get("path"):
                        return self.send_json({"cancelled": True})
                    return self.send_json(config_for(register_project(result["path"])))
                except (subprocess.TimeoutExpired, ValueError, OSError) as e:
                    return self.send_json({"pickerUnavailable":True,"initial":str(root),"reason":"Native picker failed: "+str(e)+". The browser picker is used."})
                finally:
                    PICKER_LOCK.release()
            key, root = self.project()
            if endpoint == "/api/search":
                return self.send_json(search_project(root,data))
            if endpoint == "/api/symbols":
                return self.send_json({"symbols":project_symbols(root,data.get("drafts",{}))})
            if endpoint == "/api/settings":
                with FILE_LOCK:
                    current=project_settings(root)
                    target=data["target"]
                    options=validate_target_options(root,target,data.get("options",{}))
                    current.setdefault("targets",{})[target]=options
                    build_order(root,target,current)
                    atomic_json(private_dir(root,"")/"settings.json",current)
                    return self.send_json(current)
            if endpoint == "/api/build/start":
                return self.send_json({"id":start_build(self,key,root,data.get("target"),bool(data.get("clean")))})
            if endpoint == "/api/build/cancel":
                job=JOBS.get(data.get("id"))
                if not job or job["project"]!=key:raise ValueError("Build session not found.")
                job["cancel"].set()
                return self.send_json({"ok":True})
            if endpoint == "/api/rename":
                if not BUILD_LOCK.acquire(blocking=False):raise ValueError("Wait for the build before moving files.")
                try:
                    with FILE_LOCK:
                        old=valid_new_path(root,data["path"]);new=valid_new_path(root,data["newPath"])
                        if old==root or is_within(old, root/".localtex") or is_within(old, root/".localtex-trash"):
                            raise ValueError("Cannot move the project root or metadata.")
                        if is_within(new, root/".localtex") or is_within(new, root/".localtex-trash"):
                            raise ValueError("Cannot move files into metadata folders.")
                        if new.exists() or new.is_symlink():raise ValueError("Destination already exists.")
                        if not new.parent.is_dir():raise ValueError("Create the destination folder first.")
                        if is_within(new, old):raise ValueError("Cannot move a folder into itself.")
                        if any(p.is_symlink() for p in [root/data["path"],*(root/data["path"]).parents] if is_within(p, root)):
                            raise ValueError("Moving symbolic links is not supported.")
                        settings=project_settings(root)
                        def remap(rel):
                            return data["newPath"]+rel[len(data["path"]):] if rel==data["path"] or rel.startswith(data["path"]+"/") else rel
                        targets={remap(k):{**v,"dependencies":[remap(d) for d in v.get("dependencies",[])]} for k,v in settings.get("targets",{}).items()}
                        old.rename(new)
                        if settings.get("targets"):
                            try:
                                settings["targets"]=targets;atomic_json(private_dir(root,"")/"settings.json",settings)
                            except Exception:
                                new.rename(old);raise
                        history=private_dir(root,"history")
                        for entry in list(history.glob("*/*.json")):
                            try: record=read_snapshot(entry)
                            except (OSError,ValueError,KeyError,TypeError): continue
                            changed=remap(record["path"])
                            if changed!=record["path"]:
                                folder=history/hashlib.sha256(changed.encode()).hexdigest()
                                folder.mkdir(exist_ok=True);record["path"]=changed
                                if folder.is_symlink(): raise ValueError("Invalid history directory.")
                                destination=folder/entry.name
                                if destination.exists() or destination.is_symlink():
                                    record["id"]=uuid.uuid4().hex;destination=folder/(record["id"]+".json")
                                atomic_json(destination,record);entry.unlink()
                                (folder/".legacy-index").unlink(missing_ok=True)
                                LEGACY_SNAPSHOT_INDEX.pop(str(folder),None)
                        return self.send_json({"ok":True,"path":data["path"],"newPath":data["newPath"]})
                finally:BUILD_LOCK.release()
            if endpoint in {"/api/delete", "/api/restore"}:
                if not BUILD_LOCK.acquire(blocking=False):
                    return self.send_json({"error": "Wait for compilation to finish before deleting or restoring files."}, 409)
                try:
                    with FILE_LOCK:
                        return self.send_json(trash_operation(root, data, endpoint.endswith("restore")))
                finally:
                    BUILD_LOCK.release()
            if endpoint == "/api/create":
                p = valid_new_path(root, data.get("path"))
                kind = data.get("kind")
                if kind == "folder":
                    p.mkdir(parents=True, exist_ok=False)
                elif kind == "file":
                    if p.suffix.lower() not in TEXT_EXTENSIONS:
                        raise ValueError("Use a supported text extension, e.g. .tex, .bib, .sty, or .txt.")
                    if not p.parent.is_dir():
                        raise ValueError("Create the parent folder first.")
                    with p.open("x", encoding="utf-8", newline="") as f:
                        f.write(data.get("text", ""))
                else:
                    raise ValueError("Choose file or folder.")
                return self.send_json({"ok": True, "path": p.relative_to(root).as_posix()})
            if endpoint == "/api/upload":
                p = valid_new_path(root, data.get("path"))
                if not p.parent.is_dir(): raise ValueError("Choose an existing project folder.")
                content = base64.b64decode(data.get("content", ""), validate=True)
                if len(content)>10*1024*1024: raise ValueError("Upload limit is 10 MiB per file.")
                with FILE_LOCK:
                    if p.exists(): return self.send_json({"error":"A file with this name already exists. Rename it before uploading; nothing was overwritten."},409)
                    created=False
                    try:
                        with p.open("xb") as f:
                            created=True;f.write(content);f.flush();os.fsync(f.fileno())
                    except Exception:
                        if created:p.unlink()
                        raise
                return self.send_json({"ok":True,"path":p.relative_to(root).as_posix()})
            if endpoint == "/api/save":
                rel = data["path"]
                p = safe_path(root, rel)
                if p.suffix.lower() not in TEXT_EXTENSIONS:
                    raise ValueError("Cannot save a binary file as source text.")
                with FILE_LOCK:
                    old = p.read_bytes()
                    old_digest=hashlib.sha256(old).hexdigest()
                    if data.get("version") != old_digest:
                        return self.send_json({"error": f"{rel} changed on disk. Your draft is kept. Copy it somewhere safe, then reload the page to read the disk version."}, 409)
                    content, temp = encode_source(data["text"], old), None
                    mode = stat.S_IMODE(p.stat().st_mode)
                    if not mode & stat.S_IWUSR or not os.access(p, os.W_OK):
                        raise ValueError("This source is read-only. Change its permissions before saving.")
                    add_snapshot(root,rel,old,old_digest)
                    content_digest=add_snapshot(root,rel,content)
                    try:
                        with tempfile.NamedTemporaryFile(dir=p.parent, prefix=".localtex-", delete=False) as f:
                            temp = f.name
                            f.write(content)
                            f.flush(); os.fsync(f.fileno())
                        os.chmod(temp, mode)
                        if hashlib.sha256(p.read_bytes()).hexdigest() != old_digest:
                            return self.send_json({"error":f"{rel} changed while saving. Your draft is kept."},409)
                        os.replace(temp, p)
                        if os.name != "nt":
                            try:
                                fd=os.open(p.parent,os.O_RDONLY)
                                try:os.fsync(fd)
                                finally:os.close(fd)
                            except OSError:pass
                    finally:
                        if temp and os.path.exists(temp):
                            os.unlink(temp)
                return self.send_json({"ok": True, "path": rel, "version": content_digest})
            if endpoint == "/api/compile":
                # Compatibility endpoint uses the same registered lifecycle as
                # asynchronous UI builds, so shutdown can cancel it too.
                token=start_build(self,key,root,data.get("target"))
                job=JOBS[token]
                job["thread"].join()
                return self.send_json(job["result"])
            if endpoint in {"/api/sync/forward", "/api/sync/reverse"}:
                if not BUILD_LOCK.acquire(blocking=False):raise ValueError("A build is running. Try SyncTeX after it finishes.")
                try:return self.send_json(self.sync(root, data, endpoint.endswith("forward")))
                finally:BUILD_LOCK.release()
            self.send_error(404)
        except subprocess.TimeoutExpired:
            self.send_json({"error": "Operation timed out. Check the terminal/compiler output."}, 500)
        except JsonResponse:
            raise
        except Exception as e:
            self.send_json({"error": str(e),"code":getattr(e,"code",None)}, 409 if getattr(e,"code",None)=="STALE_PDF" else 400)

    def compile(self, root, rel, options=None, job=None, clean=False):
        source = safe_path(root, rel)
        if not source.is_file() or source.suffix.lower() != ".tex":
            raise ValueError("Choose an existing .tex build target.")
        output = source.with_suffix(".pdf")
        options=validate_target_options(root,rel,options or project_settings(root).get("targets",{}).get(rel,{}))
        engine=options["engine"]
        latexmk, pdflatex = shutil.which("latexmk"), shutil.which(engine)
        if clean:clean_target(root,source)
        common = ["-synctex=1", "-interaction=nonstopmode", "-file-line-error",
                  "-jobname=" + source.stem]
        if options["stopOnError"]:common.append("-halt-on-error")
        if latexmk:
            cmd = [latexmk, {"pdflatex":"-pdf","xelatex":"-xelatex","lualatex":"-lualatex"}[engine], "-outdir=.", "-auxdir=.", *common, "./" + source.name]
        elif pdflatex:
            cmd = [pdflatex, "-output-directory=.", *common, "./" + source.name]
        else:
            raise ValueError(engine+" was not found in PATH.")
        started = time.time()
        try:
            proc = streamed_command(cmd,source.parent,options["timeout"],job or {"output":"","cancel":threading.Event(),"lock":threading.Lock(),"process":None})
            stdout, returncode = proc.stdout, proc.returncode
        except subprocess.TimeoutExpired as e:
            stdout = e.stdout or ""
            if isinstance(stdout, bytes):
                stdout = stdout.decode("utf-8", errors="replace")
            stdout += "\n! Compilation timed out after "+str(options["timeout"])+" seconds. Check the last command above and its .log/.blg file; use Build settings to increase the limit if needed."
            returncode = -1
        log = source.with_suffix(".log")
        # The engine log contains complete warnings, including unchanged latexmk builds.
        log_text = log.read_text(encoding="utf-8", errors="replace") if (
            log.is_file() and (returncode == 0 or log.stat().st_mtime >= started - 0.01)) else stdout
        diagnostics = parse_diagnostics(root, source, log_text)
        diagnostic_keys={(d["severity"],d["path"],d["line"],d["message"]) for d in diagnostics}
        for entry in parse_diagnostics(root, source, stdout):
            identity=(entry["severity"],entry["path"],entry["line"],entry["message"])
            if identity not in diagnostic_keys:
                diagnostics.append(entry)
                diagnostic_keys.add(identity)
        if returncode and not any(d["severity"] == "error" for d in diagnostics):
            diagnostics.insert(0, {"severity":"error","path":rel,"line":None,"endLine":None,
                                  "message":"Compilation failed. See the raw log for details."})
        return {"ok": returncode == 0 and output.is_file(), "returncode": returncode,
                "pdfExists": output.is_file(), "pdfPath": output.relative_to(root).as_posix(),
                "target": source.relative_to(root).as_posix(), "cwd": str(source.parent),
                "command": cmd, "output": stdout[-50000:], "log": log_text[-200000:], "diagnostics": diagnostics}

    def sync(self, root, data, forward):
        exe = shutil.which("synctex")
        if not exe:
            raise ValueError("synctex was not found in PATH.")
        pdf = safe_path(root, data.get("pdf"))
        if pdf.suffix.lower() != ".pdf" or not pdf.is_file():
            raise ValueError("Compile or open a PDF first.")
        check_pdf_version(pdf,data.get("pdfVersion"))
        if forward:
            source = safe_path(root, data["path"])
            line, column = max(1, int(data["line"])), max(1, int(data.get("column", 1)))
            cmd = [exe, "view", "-i", f"{line}:{column}:{source}", "-o", str(pdf)]
        else:
            page, x, y = int(data["page"]), float(data["x"]), float(data["y"])
            if page < 1 or not all(math.isfinite(v) for v in (x, y)):
                raise ValueError("Invalid PDF coordinates.")
            cmd = [exe, "edit", "-o", f"{page}:{x}:{y}:{pdf}"]
        env = os.environ.copy()
        env.pop("SYNCTEX_VIEWER", None)
        env.pop("SYNCTEX_EDITOR", None)
        proc = run_command(cmd, pdf.parent, 15, env)
        check_pdf_version(pdf,data.get("pdfVersion"))
        records, current = [], None
        for raw in proc.stdout.splitlines():
            key, sep, value = raw.partition(":")
            if key == ("Page" if forward else "Input"):
                if current:
                    records.append(current)
                current = {}
            if sep and current is not None:
                current[key] = value.strip()
        if current:
            records.append(current)
        for record in records:
            if forward and all(k in record for k in ("Page", "x", "y")):
                return {"page": int(record["Page"]), "x": float(record["x"]), "y": float(record["y"])}
            if not forward and "Input" in record and "Line" in record:
                # Relative SyncTeX inputs are relative to the compilation directory.
                source = (pdf.parent / record["Input"].strip('"')).resolve()
                if is_within(source, root) and source.is_file() and source.suffix.lower() in {".tex", ".tikz", ".sty", ".cls", ".def", ".cfg"}:
                    return {"path": source.relative_to(root).as_posix(),
                            "line": max(1, int(record["Line"])), "column": max(1, int(record.get("Column", "1")))}
        raise ValueError("No SyncTeX match in this PDF. Recompile its source first. Imported PDFs may have no SyncTeX data.")

    def serve_file(self, path, content_type=None):
        if not path.is_file():
            return self.send_error(404, "File not found")
        data = path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", content_type or ({".js":"text/javascript", ".mjs":"text/javascript", ".css":"text/css"}.get(path.suffix) or
                         mimetypes.guess_type(path.name)[0] or "application/octet-stream"))
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

def main():
    global DEFAULT_PROJECT, PORT, REMOTE_MODE, WORKSPACE
    if sys.version_info < (3,8):
        raise SystemExit("LocalTeX requires Python 3.8 or newer. Start it with a supported Python interpreter.")
    args = sys.argv[1:]
    if args and args[0] == "--pick":
        try:
            print(json.dumps({"path": native_pick(args[1], args[2] if len(args) > 2 else None)}))
        except Exception as e:
            print(json.dumps({"error": f"Native picker unavailable: {e}. Use Browse server or a command-line project path."}))
        return
    try:
        parser=argparse.ArgumentParser(
            description="LocalTeX: offline browser-based LaTeX editing with native TeX tools.\nRuns on Windows, Linux and macOS using Python 3.8+; no third-party Python packages required.",
            formatter_class=argparse.RawDescriptionHelpFormatter,
            epilog="""Examples:
  python3 server.py
  python3 server.py "/path/to/project"
  python3 server.py "/path/to/project" chapters/paper.tex --port 9000
  python3 server.py "/path/to/document.tex" --no-browser
  python3 server.py --tex-path "/custom/tex/bin"
  python3 server.py "/path/to/project" --remote --port 9000

Opening projects:
  No project argument opens the projects page with recent projects and pickers.
  For a folder, main.tex is selected if present; otherwise the first .tex file.
  Empty folders are supported. Browse server works without a graphical desktop.
  Upload project ZIP imports into ~/MyLocalTexProjects on the server, or the
  --workspace directory. Imports require a .tex file and never overwrite a
  project. Limits: 50 MiB uploaded, 200 MiB extracted, 10,000 archive entries.

Dependencies:
  Editing requires Python and a modern browser. Compilation requires a TeX
  distribution with pdflatex, xelatex or lualatex; latexmk is recommended.
  SyncTeX enables source/PDF navigation. Tools are found using PATH, the saved
  UI directory setting, or --tex-path. Missing tools are reported at startup.
  The optional native picker requires Tkinter/Tcl-Tk and a graphical desktop.
  Enable Tcl/Tk through your Python installer, OS package manager, or environment
  manager; check with the same Python interpreter using: python3 -m tkinter.
  No dependencies are installed automatically; browser picking is the fallback.

Networking and remote use:
  The server listens on 127.0.0.1 only. Occupied requested ports automatically
  fall back to an OS-selected free port; use the actual URL printed at startup.
  SSH example: ssh -L 9000:127.0.0.1:8765 user@server
  Then open http://localhost:9000 locally (adjust 8765 to the actual server port).
  SSH/headless sessions skip native dialogs. A loopback tunnel can appear local;
  use --remote to force browser picking and suppress browser launch on the server.
  --allow-host trusts an additional tunnel hostname, not a network bind address.

Settings and stopping:
  UI TeX-directory changes persist beside the recent-projects file; --tex-path
  overrides them for one launch. LOCALTEX_RECENTS overrides the recents file path.
  Ctrl+C stops the server. In the editor, Ctrl+Enter builds current source and
  Ctrl+Shift+Enter builds the target. Save drafts before shutting down.
  On systems where Python is named python instead of python3, use that command.
""")
        parser.add_argument("project", nargs="?", help="Project folder or .tex file; omit to open the projects page")
        parser.add_argument("source", nargs="?", help="Initial source relative to the project folder, including subdirectories")
        parser.add_argument("--port", type=int, default=8765, metavar="PORT", help="Requested port (default: 8765); occupied ports fall back automatically; 0 selects a free port")
        parser.add_argument("--workspace", metavar="DIR", help="ZIP import workspace on the server (default: ~/MyLocalTexProjects); created on first valid import")
        parser.add_argument("--no-browser", action="store_true", help="Do not launch the default browser; native picking remains available when supported")
        parser.add_argument("--remote", action="store_true", help="Use browser picker only and suppress server-side browser launch")
        parser.add_argument("--tex-path", metavar="DIR", help="TeX executable directory on the server; overrides the saved choice for this launch; empty string uses original PATH")
        parser.add_argument("--allow-host", action="append", default=[], metavar="HOSTNAME", help="Trust an additional tunnel hostname (repeatable); no scheme or port; listening stays on loopback")
        options=parser.parse_args(args)
        WORKSPACE=Path(options.workspace).expanduser().resolve() if options.workspace else WORKSPACE.resolve()
        REMOTE_MODE=options.remote
        if options.tex_path is not None:configure_tex_path(options.tex_path)
        else:
            try:
                saved=json.loads((RECENT_FILE.parent/"tool-path.json").read_text(encoding="utf-8"))
                configure_tex_path(saved.get("texPath",""))
            except FileNotFoundError:pass
            except (OSError,ValueError,TypeError) as e:print(f"Saved TeX directory unavailable: {e}; using PATH.")
        if not 0<=options.port<=65535:parser.error("port must be between 0 and 65535")
        for hostname in options.allow_host:
            if not re.fullmatch(r"[a-zA-Z0-9.-]+",hostname):parser.error("allow-host must be a hostname without scheme or port")
            ALLOWED_HOSTS.add(hostname.lower())
        if options.project:
            DEFAULT_PROJECT = register_project(options.project, options.source)
        server = bind_server(options.port)
        PORT=server.server_port
        url = f"http://{HOST}:{PORT}/"
        print(f"LocalTeX\nOpen: {url}")
        if DEFAULT_PROJECT:
            print(f"Project: {PROJECTS[DEFAULT_PROJECT]['root']}")
        print("Ctrl+C stops the server. Ctrl+Enter builds current source; Ctrl+Shift+Enter builds the target.")
        for exe in ("latexmk","pdflatex","xelatex","lualatex","synctex"):
            print(f"{exe}: {shutil.which(exe) or 'not found on PATH'}")
        available=capabilities()
        print("Native picker: "+("available" if available["nativePicker"] else available["pickerReason"]))
        for warning in available["warnings"]:print("NOTICE: "+warning,flush=True)
        if not options.no_browser and not available["remote"]:
            # The listening socket is bound before launching the browser.
            def launch_browser():
                try:
                    if not webbrowser.open(url, new=2):
                        print(f"Open {url} in your browser.")
                except Exception as e:
                    print(f"Open {url} in your browser ({e}).")
            threading.Thread(target=launch_browser, daemon=True).start()
        previous_signals={}
        if threading.current_thread() is threading.main_thread():
            def stop_signal(signum,frame):raise KeyboardInterrupt
            # Background launchers/CI shells may pass an ignored SIGINT. Own
            # both normal stop signals explicitly once startup is complete.
            for stop in (signal.SIGINT,signal.SIGTERM):
                previous_signals[stop]=signal.signal(stop,stop_signal)
        try:
            SHUTTING_DOWN.clear()
            server.serve_forever()
        except KeyboardInterrupt:
            pass
        finally:
            shutdown_builds()
            server.server_close()
            for stop,previous in previous_signals.items():signal.signal(stop,previous)
    except Exception as e:
        print(f"Cannot start LocalTeX: {e}")
        raise SystemExit(1)

if __name__ == "__main__":
    main()
