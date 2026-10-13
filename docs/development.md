# Development and verification

## Architecture

`server.py` owns the standard-library HTTP server, project registry, filesystem/history operations, TeX process management and startup. `web/app.js` coordinates document state and UI. Focused modules implement source rendering, grouped cursors, editor views, completion, navigation, recovery, diagnostics, build controls, file picking and log search. `web/storage.js` makes optional browser persistence non-fatal.

Source editing deliberately remains a native textarea rather than an embedded third-party editor, for browser/desktop writing-assistant compatibility. A separate source-color layer and measurement cache provide syntax rendering and cursor geometry. PDF.js renders PDFs; vendor files are pinned, unmodified and served locally.

This is a single-user application. Filesystem/build locks serialize sensitive operations across its sessions. POST JSON responses unwind operation locks before writing to the socket; build GET responses copy state before transmission. Connections use a 30-second socket inactivity timeout. Compiler cancellation/timeout and server shutdown perform bounded process-tree cleanup.

No framework or database is required. The backend and app orchestrator are still large; future refactoring should separate HTTP, storage/history and compiler services while preserving the regression suite.

## Tests

Backend tests use the Python standard library:

```sh
python -m unittest discover -s tests -v
```

Browser tests require Node.js and Playwright **for development only**:

```sh
npm ci
npx playwright install chromium
npm run test:browser
npm run test:stability
npm run test:log
npm run test:storage
```

Set `PYTHON` if your interpreter is named differently. `BROWSER_EXECUTABLE` can select a local Chromium executable. The suites create temporary projects and clean them afterward. Real TeX/SyncTeX checks run when those tools are installed and otherwise skip; a green run without TeX is not proof of native compilation compatibility.

The GitHub Actions configuration covers Python on Windows/Linux/macOS, Python 3.8 compatibility on Linux, and Chromium browser checks on Linux. It has not yet run on GitHub. Recent local automated verification was performed on Linux, including real pdflatex/latexmk/SyncTeX where available. Windows cleanup-failure paths are simulated; physical Windows/macOS picker, trackpad and Grammarly behavior require manual checks. The user has exercised the app on Windows and Ubuntu, but that does not replace a release matrix.

Important regressions include conflict-safe saves, ZIP validation/collisions, compiler timeout/cancellation, HTTP responses without operation locks, Ctrl+C cleanup, suspended/offline requests, obsolete source/PDF responses, SyncTeX, search focus/native paging, large diagnostics/logs, and editing with denied/quota-limited browser storage.

## Demo screenshot

With TeX installed, run `node tools/capture-demo.cjs` from the project directory after installing the development dependencies. It builds a temporary copy of the synthetic demo and captures the real UI. The header identifies the demo rather than displaying a temporary machine path; no Grammarly UI or suggestions are fabricated.

## Vendored assets

See [third-party notices](../THIRD_PARTY_NOTICES.md) and [vendor hashes](vendor-manifest.json). Asset upgrades must preserve upstream notices, include each applicable license, update the manifest and rerun PDF/search/SyncTeX tests. Review upstream security advisories before upgrading; do not enable PDF scripting/evaluation without a separate security review. The app disables PDF evaluation and does not install a scripting manager.

## Release checklist

1. Run backend and all browser suites; record skips and runtime versions.
2. Run the GitHub OS matrix and manually check native Windows/macOS startup, picker, TeX builds and shutdown.
3. Verify README examples, CLI help, internal links, vendor hashes and license inclusion.
4. Generate screenshots from synthetic demo content, with no personal projects or Grammarly account data.
5. Package source, docs, tests, demo, license/NOTICE files and vendor assets. Exclude caches, node_modules, generated TeX output, private project metadata and local credentials.
6. Publish a beta tag until the supported-platform checks and outstanding limitations have been evaluated.

A normal server shutdown cleans up owned builds; forced process termination and OS/disk failures remain outside that guarantee. Never use developer tests or a source ZIP as a substitute for project backups.
