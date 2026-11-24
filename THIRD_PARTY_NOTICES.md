# Third-party notices

Rei itself is released under the [MIT License](LICENSE). This file lists the third-party material that is **bundled into what Rei ships**: the web app, the container images and the Android APK. Dependencies that are only used to build, test or lint the project are not listed here; every installed npm package carries its own license in `node_modules/`, and `package-lock.json` pins the exact versions.

Versions below are the ones pinned in `package-lock.json`, `apps/web/package.json` and `apps/android/app/build.gradle.kts` at the time of writing. When you change a pinned version, update this file together with it.

## Vendored files in the repository

| Material | Where | License |
| --- | --- | --- |
| Static stylesheet from shadcn 4.23.0 | `apps/web/src/styles/vendor/shadcn.css` | MIT, copyright (c) 2023 shadcn. The license text is kept next to the file in `shadcn.LICENSE.md`. |
| A2UI v1.0 JSON schemas (unchanged copy) | `packages/protocol/vendor/a2ui-v1_0/` | Apache License 2.0, kept as `LICENSE` in that folder. `SOURCE.md` records the upstream commit. |

## Web app and container images

The web app is built from the npm packages in `apps/web/package.json`. The runtime packages that end up in the production bundle:

| Package | License |
| --- | --- |
| React and React DOM 19 | MIT |
| Radix UI primitives (`radix-ui`) | MIT |
| Tailwind CSS 4 (`tailwindcss`, `@tailwindcss/vite`) | MIT |
| `tw-animate-css` | MIT |
| `class-variance-authority` | Apache-2.0 |
| `cn` | MIT |
| `lucide-react` (icons) | ISC; some icons derive from Feather and are MIT |
| `highlight.js` (code highlighting) | BSD-3-Clause |
| `masonic` | MIT |
| `qrcode` | MIT |
| `fflate` | MIT |
| `@simplewebauthn/browser` | MIT |
| `mermaid` 12.3.0 (diagrams) and the libraries it bundles | see below |
| `@file-viewer/*` 3.3.3 and `styled-exceljs` (Office and PDF viewer) | Apache-2.0; see below |

Services in `apps/server`, `apps/gateway`, `apps/reader`, `apps/egress` and `packages/*` run from their npm dependencies, each under its own permissive license (MIT, ISC, BSD or Apache-2.0). The container images (`containers/`) are built on top of other projects, which keep their own licenses; the images carry them:

- Node.js (official `node` images, MIT) and Debian packages. The `exec` image adds LibreOffice (MPL-2.0), poppler, ripgrep and the fonts `fonts-liberation` (SIL OFL 1.1) and `fonts-noto-cjk` (SIL OFL 1.1); the `browser` image adds Chromium (BSD-style, with bundled components under their own licenses), Xvfb, socat, tini and the fonts `fonts-dejavu-core`, `fonts-liberation`, `fonts-noto-cjk` and `fonts-noto-color-emoji`. The `reader` image also installs Chromium from Debian.
- Moli 1.1.25 (Apache-2.0), the headless page renderer in the `reader` image, downloaded as a pinned release binary and verified against its checksum.
- uv (Apache-2.0 or MIT), copied into the `exec` image.
- Garage (AGPL-3.0) and Qdrant (Apache-2.0) run as separate, unmodified containers in the `dodai` Compose project and are pulled from their own images. They are not linked into or distributed with Rei's code.

### Mermaid

`mermaid` 12.3.0 is MIT licensed. The distributable `mermaid.min.js` includes its own dependencies, which are mostly MIT, ISC or BSD licensed. Exceptions:

- `chevrotain` is Apache-2.0.
- `dompurify` is available under MPL-2.0 or Apache-2.0; Rei uses it under Apache-2.0.
- `elkjs` is available under EPL-2.0 or GPL-3.0-or-later; Rei uses it under EPL-2.0.

The Android APK ships Mermaid's license text as `assets/mermaid/LICENSE-mermaid.txt`.

### Office and PDF viewers

The in-browser previews for PDF, Word, spreadsheet and presentation files use the `@file-viewer` packages (Apache-2.0, copyright Flyfish) at 3.3.3. The Vite plugin copies these runtime assets into the build as `file-viewer/` (generated, not committed to this repository), and the same renderers are packaged into the Android APK as `assets/viewer/`:

| Asset | Source | License |
| --- | --- | --- |
| PDF worker, character maps | PDF.js (`pdfjs-dist` 5.4.624) | Apache-2.0 |
| JBIG2 decoder (WebAssembly) | PDF.js and PDFium | Apache-2.0 / BSD-3-Clause (PDFium) |
| JPEG 2000 decoder (WebAssembly) | PDF.js and OpenJPEG | Apache-2.0 / BSD-2-Clause (OpenJPEG) |
| Color management (`qcms`, WebAssembly) | Mozilla `qcms`, based on lcms | MIT |
| PDF standard fonts (`standard_fonts/`) | Foxit fonts (PDFium) and Liberation Sans | BSD-3-Clause (Foxit); SIL Open Font License 1.1 (Liberation) |
| Noto Sans SC Variable (`fonts/`), via `@fontsource-variable/noto-sans-sc` 5.3.1 | Google Fonts | SIL Open Font License 1.1 |
| Word renderer, including JSZip 3.10.2 and its pako dependency | `@file-viewer/renderer-word` and JSZip | Apache-2.0; JSZip is dual-licensed MIT or GPL-3.0 and Rei uses it under MIT; pako is MIT and zlib |
| Legacy PowerPoint (`.ppt`) renderer | `@file-viewer/ppt` 1.0.2 | Apache-2.0 (its `NOTICE.md` describes its provenance) |
| Spreadsheet worker | `@file-viewer/renderer-spreadsheet` and `styled-exceljs` | Apache-2.0 |

Each of these folders ships with its original license file (`LICENSE_*`, `OFL-1.1.txt`, `LICENSE`) in the built output.

### Fonts

Rei's web app does not download or embed a web font for its interface. It uses the system font stacks defined in `apps/web/src/index.css`. The only bundled fonts are the PDF viewer fonts above.

## Android app

The APK (`apps/android`) is built with Gradle from the dependencies in `apps/android/app/build.gradle.kts`:

| Dependency | License |
| --- | --- |
| Jetpack Compose, Material 3, AndroidX (activity, core, lifecycle, navigation, browser, webkit, credentials) | Apache-2.0 |
| Google Play services Credential Manager support (`credentials-play-services-auth`) | Android Software Development Kit License and the Google Play services terms |
| Firebase Cloud Messaging (`firebase-messaging`), compiled in **only** for builds with a Firebase configuration | Apache-2.0, and the Google Play services terms |
| OkHttp and OkHttp SSE 4.12.0 | Apache-2.0 |
| Kotlin standard library, `kotlinx-coroutines`, `kotlinx-serialization` | Apache-2.0 |
| CommonMark Java 0.24.0, with the autolink, strikethrough, tables and task-list extensions | BSD-2-Clause |
| Mermaid and the Office and PDF viewers | as described above |

The launcher icons and the splash images under `apps/android/app/src/main/res` are Rei's own artwork, generated by the scripts in `apps/android/tools/`, and fall under Rei's MIT license.

## Agent runtime

Rei's agent runtime is built on [Pi](https://github.com/earendil-works/pi) (`@earendil-works/*` packages), which is MIT licensed.
