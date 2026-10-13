# Changelog

## 0.1.0-beta.1 — release preparation

- Cancel active compiler jobs and terminate their process trees during normal server shutdown.
- Defer POST JSON responses until filesystem/build/picker locks are released; bound socket inactivity.
- Keep editing/disk saves available when browser persistence is denied/full, with a visible notice and protection against replacing unbacked unsaved drafts during recovery.
- Serve JavaScript/CSS with explicit MIME types.
- Remove a static gutter placeholder that could duplicate the first line number.
- Add Apache-2.0 licensing, third-party notices, restored Adobe CMap license, and audited vendor hashes.
- Replace the incremental README with a project overview, demo screenshot, and separate CLI, user, security and development guides.

This beta includes the local browser editor, native builds, PDF/SyncTeX navigation, source completion, grouped cursors, shared document views, file operations, recovery/history, diagnostics and raw-log search developed before release packaging. Platform validation remains in progress; see docs/development.md.
