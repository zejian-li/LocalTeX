# Command-line reference

Run commands from the LocalTeX directory. Replace `python` with `python3` where appropriate.

```text
python server.py [project] [source] [--port PORT] [--workspace DIR]
                 [--no-browser] [--remote] [--tex-path DIR]
                 [--allow-host HOSTNAME]
```

`python server.py --help` displays the current reference. No Python packages need to be installed with pip.

## Arguments and options

| Argument / option | Behavior |
| --- | --- |
| `project` | Existing project folder or `.tex` file. Omit it for the projects landing page. A file opens its enclosing folder. |
| `source` | Optional initial `.tex` source relative to the project folder, including subdirectories. Without it, a folder selects `main.tex` if present, otherwise the first discovered `.tex`; empty folders are supported. |
| `--port PORT` | Default **8765**. An occupied port falls back to a free port. `0` explicitly requests a free port. Always use the URL printed at startup. |
| `--workspace DIR` | ZIP import destination; default `~/MyLocalTexProjects` on the server. Created on the first valid import. |
| `--no-browser` | Suppress automatic browser launch; supported native picking remains available. |
| `--remote` | Force browser-based picking and suppress browser launch on the server. Useful with SSH or a headless machine. |
| `--tex-path DIR` | Directory containing TeX executables, prepended to the original `PATH`. Overrides the saved UI choice for this launch. An empty string uses the original `PATH`. |
| `--allow-host HOSTNAME` | Repeatable trusted tunnel hostname, without scheme or port. Does not change the loopback bind address or add authentication. |
| `-h`, `--help` | Show help and exit. |

The internal `--pick` subprocess interface is used by the native picker; it is not a public project-startup option.

## Examples

```sh
python server.py
python server.py examples/demo
python server.py "/path/to/project" chapters/paper.tex --port 9000
python server.py "/path/to/paper.tex" --no-browser
python server.py --tex-path "/custom/tex/bin"
python server.py --workspace "/path/to/imports"
```

Paths with spaces must be quoted. `--tex-path` expects the **bin directory**, not the path to a single executable. Alternatively, change the TeX directory in the UI; that choice is saved for future launches. A CLI override affects this launch without replacing the saved choice.

## Private SSH forwarding

On the remote machine:

```sh
python3 server.py "/srv/my-project" --remote --port 8765
```

On your computer:

```sh
ssh -L 9000:127.0.0.1:8765 user@server
```

Open **http://localhost:9000** in your browser. If the server selected another port because 8765 was busy, substitute its actual printed port in the SSH command. The local and remote ports may differ.

Files, the TeX installation, imported ZIPs and compilation output belong to the server machine. Individual file uploads and ZIP import transfer browser-selected files to that machine. Download buttons transfer files back.

Loopback forwarding can conceal that the browser is remote, so `--remote` is the reliable way to disable a server-side native picker. `--allow-host` is only for an additional trusted forwarding hostname; do not use it to publish the unauthenticated application. See [security](../SECURITY.md).

## Dependencies and detection

Install a native TeX distribution separately. Startup prints the discovered engine, latexmk and SyncTeX paths, picker availability, and guidance for missing components. Your project may need additional TeX packages and BibTeX/Biber.

The optional native picker requires Tkinter/Tcl-Tk in the **same Python interpreter** and a graphical desktop. Enable it through your Python installer, OS package manager or environment manager. Test it with:

```sh
python -m tkinter
```

If it is unavailable, use Browse server or a CLI project path. No automatic installation occurs.

## State and shutdown

- Project settings, saved snapshots and clean-rebuild backups: `.localtex/` inside each project.
- Deleted files: `.localtex-trash/` inside the project, with UI undo support; not the OS recycle bin.
- Recent projects and saved TeX directory: `%LOCALAPPDATA%/LocalTeX/` on Windows, or `~/.config/LocalTeX/` otherwise.
- `LOCALTEX_RECENTS` overrides the recent-project JSON path; the saved TeX-directory file is stored beside it.
- Unsaved browser drafts/preferences: browser storage for the app's origin and profile, when permitted.

Save unsaved edits first, then stop the server with **Ctrl+C**. Shutdown cancels registered builds, terminates their process trees and waits for bounded cleanup. A force-killed server, OS crash or unkillable process cannot be guaranteed to clean up; inspect the OS task manager if cleanup is reported as unsuccessful.
