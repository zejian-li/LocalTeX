# User guide

## Projects and files

Open existing folders directly; LocalTeX does not require an imported project format. The projects page lists recent folders and supports opening another project in a new browser tab. ZIP import validates paths and archive limits before publishing a folder in the workspace; name collisions receive a number. Limits are 50 MiB uploaded, 200 MiB extracted and 10,000 archive entries. Password-protected ZIPs, links, unsafe paths and archives without a visible `.tex` file are rejected.

The file tree starts with subdirectories folded. Use expand/fold all, filtering, compact creation/upload/move/delete controls, or drag files between folders. Uploaded individual files are limited to 10 MiB and never overwrite an existing file. Deletion moves items into `.localtex-trash`; Undo restores them if the original path is available. Moves do not rewrite `\input`, bibliography or graphics references in your TeX source.

PDFs and supported images open in the UI. Unsupported formats display a message. Use explicit file download or project ZIP export when needed. Export saves opened drafts first and includes project assets/build files, excluding history/trash and symbolic links. Full filesystem backups are needed to preserve recovery metadata.

## Source views and editing

Each file has one draft inside a browser tab. Multiple editor view tabs share that draft but keep separate cursor/scroll positions. Ctrl+Alt+N adds a view beside the current view. Drag to reorder, middle-click to close, and Ctrl+Alt+Left/Right or Alt+PageUp/PageDown to switch. Separate browser tabs have independent drafts and can conflict when saving the same file.

Soft wrapping changes display, not source bytes. Syntax colors, environment indentation and completion are available for LaTeX; citation keys and project-defined TikZ names/colors/styles are indexed from project sources. Ctrl+Space opens completion. Ctrl+click adds cursors; Ctrl+D adds the next selected-word occurrence. Escape returns to a single cursor. Grouped undo/redo retains grouped selections.

Ctrl+F prefills selected source text. Enter/Shift+Enter cycles matches while search keeps focus; Escape returns to the selected source match. Ctrl+Shift+F searches project files and supports citation/label/command navigation. F12 or Alt+click follows supported definitions and inputs.

Grammarly operates through its separately installed browser/desktop software. It can inspect the native text field, but LocalTeX cannot control its service or underline placement. If underlines drift, compare with syntax colors disabled or reload after saving. Do not treat browser grammar suggestions as local/offline processing unless the writing assistant itself guarantees that.

## Builds and PDFs

The active source, build target and visible PDF are independent choices:

- Ctrl+Enter compiles the current `.tex` source.
- Ctrl+Shift+Enter or the build-target control compiles the configured target, useful while editing an included chapter.
- A build writes a PDF with the source basename in that source's directory. Standalone subprojects can therefore generate PDFs consumed by other documents.

The Build panel is at the bottom of the sidebar. Configure an engine, optional stop-on-error, timeout (10–1800 seconds; default 120 per target) and ordered target dependencies. latexmk handles reruns and bibliography tools. Without latexmk, a single engine pass may leave references/bibliographies unresolved. Clean rebuild moves known helper files into `.localtex/clean-backups` and preserves sources, the PDF and `.bbl`; it does not clear Biber's runtime cache.

Only one build runs at a time across the server. Cancel build requests process-tree termination. No-output periods can be legitimate native-tool work; a timeout identifies the last visible command. For repeated Biber failures, preserve the `.blg` file and compare a direct Biber invocation after cancellation. The previously reported intermittent Biber stall has not been conclusively diagnosed.

The PDF has independent zoom with its controls, Ctrl+wheel or supported trackpad pinch. Drag the middle divider to resize. Use the arrow controls for source/PDF navigation; PDF double-click performs reverse SyncTeX, while source double-click selects a word. Hold Shift during PDF double-click to select text without syncing. Imported/generated bibliography locations may not be editable and produce quiet status messages. A changed PDF is refreshed before retrying stale SyncTeX navigation.

## Problems and raw log

The dock shows errors/warnings with jump-to-source where a location is known. Source overlays emphasize errors; warnings remain listed. Large lists are paged and source markers are limited to visible lines.

Find in the Problems/Raw log toolbar searches literal text. Aa enables case sensitivity; Enter/Shift+Enter and arrows cycle matches. Ctrl+F works when the raw log has focus. Escape closes search without moving the whole app. Searching pauses following live output; after closing, scroll to the bottom to resume following. The counter includes all matches, while at most 1,000 nearby matches receive highlight elements to keep large logs responsive.

## Saves, history and recovery

Disk saves check the version originally loaded and refuse unexpected external changes. UTF-8, BOM/line-ending conventions and permissions are preserved; invalid UTF-8 or mixed line endings are rejected rather than silently converted. Existing/proposed content is recorded in per-file `.localtex/history` before atomic source replacement. Failure to record a snapshot aborts the save.

History deduplicates content, so repeated saves of identical text retain the original version date. It is a collection of distinct versions, not a chronological Save-click log. No automatic pruning occurs. Corrupt history records are retained and reported. A proposed snapshot can exist even if its source write subsequently failed.

Browser drafts are a separate safety net. They survive ordinary reloads only when browser storage is permitted and the same origin/profile is used. Clearing browser data, changing the app URL/port, quota exhaustion or storage blocking can make them unavailable. A notice identifies unavailable storage; editing and disk history still work. Save to disk before closing.

Restoring history creates an unsaved draft and pauses autosave. A displaced unsaved draft must first be archived in durable browser storage; restoration is blocked if that backup cannot be made. Compare recovered drafts against changed disk content before choosing a new save base. Keep independent backups of the entire project including `.localtex` when saved history matters.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Engine or SyncTeX missing | Install the required local tools, check `PATH`, or set a custom TeX bin directory. |
| Native picker unavailable | Check `python -m tkinter`, desktop availability, and `--remote`; use Browse server. |
| Invalid host through forwarding | Use the forwarded localhost URL with a port, or explicitly allow your trusted tunnel hostname. |
| Another build is running | The server still owns a job, possibly from another/refreshed tab. Cancel from its tab or wait for timeout; refreshing does not cancel it. |
| Cleanup failed | Stop the reported TeX/latexmk/Biber process in the OS task manager before rebuilding. |
| File changed on disk | Your draft is retained. Compare/copy it before reopening the newer disk version. |
| Browser backup unavailable | Save to disk. Disk snapshots remain available; unsaved browser recovery does not. |

For bug reports include OS, Python/browser/TeX versions, exact steps, build log and a minimal non-sensitive project when possible. Check logs for private paths/content before sharing.
