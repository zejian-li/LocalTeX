# Changelog

## 0.1.0-beta.5 — loopback startup without DNS

- Bind the HTTP listener directly through TCPServer and assign the literal address/port, avoiding the blocking reverse-DNS lookup confirmed in macOS CI traces.
- Verify direct binding and real CLI shutdown with hostname lookup forbidden.

## 0.1.0-beta.4 — macOS shutdown harness diagnostics

- Launch the test compiler after CLI startup rather than concurrently with framework initialization.
- Bypass system/environment proxy discovery for local readiness checks.
- Capture staged startup messages and timed Python stack dumps on failures; retain shutdown assertions and deadlines.

## 0.1.0-beta.3 — shutdown CI synchronization

- Wait for HTTP readiness before the shutdown test signals the server; record the owned compiler exit result rather than probing PID existence.
- Explicitly handle SIGINT as well as SIGTERM, including inherited ignored SIGINT from background launchers.
- Cover slow startup and inherited ignored SIGINT without skipping POSIX shutdown verification.

## 0.1.0-beta.2 — Windows CI corrections

- Canonicalize temporary test roots and compare executable file identity across Windows short/long path aliases.
- Preserve malicious ZIP fixture names verbatim across operating systems, keeping unsafe-path rejection tests effective.
- Preserve audited vendor bytes with Git attributes; improve hash-failure diagnostics without relaxing integrity checks.

## 0.1.0-beta.1 — release preparation

- Cancel active compiler jobs and terminate their process trees during normal server shutdown.
- Defer POST JSON responses until filesystem/build/picker locks are released; bound socket inactivity.
- Keep editing/disk saves available when browser persistence is denied/full, with a visible notice and protection against replacing unbacked unsaved drafts during recovery.
- Serve JavaScript/CSS with explicit MIME types.
- Remove a static gutter placeholder that could duplicate the first line number.
- Add Apache-2.0 licensing, third-party notices, restored Adobe CMap license, and audited vendor hashes.
- Replace the incremental README with a project overview, demo screenshot, and separate CLI, user, security and development guides.

This beta includes the local browser editor, native builds, PDF/SyncTeX navigation, source completion, grouped cursors, shared document views, file operations, recovery/history, diagnostics and raw-log search developed before release packaging. Platform validation remains in progress; see docs/development.md.
