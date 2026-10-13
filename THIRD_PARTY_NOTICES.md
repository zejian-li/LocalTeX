# Third-party notices

LocalTeX's original code, documentation and demo are licensed under [Apache-2.0](LICENSE). Bundled third-party files remain under their respective licenses; the project license does not relicense them.

| Component | Bundled location | License and attribution |
| --- | --- | --- |
| PDF.js / PDF.js viewer 4.10.38, including viewer images | `web/vendor/pdf*.mjs`, `pdf_viewer.css`, `images/` | Apache-2.0; Copyright 2024 Mozilla Foundation; [full license](web/vendor/LICENSE). Original source notices retained. |
| Adobe CMaps | `web/vendor/cmaps/` | Adobe BSD-style three-clause notice; Copyright 1990–2009 Adobe Systems Incorporated; [full notice](web/vendor/cmaps/LICENSE). |
| Foxit/PDFium standard fonts | `web/vendor/standard_fonts/Foxit*.pfb` | BSD-style three-clause notice; Copyright 2014 PDFium Authors; [full notice](web/vendor/standard_fonts/LICENSE_FOXIT). |
| Liberation Sans fonts | `web/vendor/standard_fonts/LiberationSans*.ttf` | SIL Open Font License 1.1; Google/Red Hat copyrights and reserved font names; [full license](web/vendor/standard_fonts/LICENSE_LIBERATION). Unmodified fonts retain their original names. |

## Provenance and redistribution

The files above were verified byte-for-byte against the official npm `pdfjs-dist@4.10.38` archive. No vendor modifications were found. The upstream archive has no separate NOTICE file. The previously omitted CMap license has been restored from that archive. [Vendor manifest](docs/vendor-manifest.json) records the archive and bundled-file SHA-256 hashes. Preserve these notices, upstream source headers and all adjacent license files when redistributing LocalTeX. The bundled fonts are assets of the application, not a separately sold font package.

Upstream: <https://github.com/mozilla/pdf.js> and <https://www.npmjs.com/package/pdfjs-dist/v/4.10.38>.

## Development tools and external applications

Playwright and playwright-core are Apache-2.0 development dependencies installed through npm; their source/binaries are not bundled in this release. Optional npm dependencies retain their upstream licenses. Python, browsers, TeX distributions, latexmk, BibTeX/Biber, SyncTeX, and Tkinter/Tcl-Tk are installed separately and are not relicensed or distributed by LocalTeX.

Grammarly is optional, proprietary third-party software. It is not bundled, required or affiliated with LocalTeX. Overleaf and Grammarly names describe workflow inspiration and compatibility; they do not imply endorsement. No Overleaf source code or branding is bundled. Toolbar symbols are defined directly in application source; source-editor font names refer to fonts installed on the user's computer, not bundled fonts.
