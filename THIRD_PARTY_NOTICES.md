# Third-party components

This distribution includes Python, Playwright, Chromium, FastAPI, Uvicorn, Pydantic and their dependencies. Their respective licenses continue to apply. This document does not replace those licenses.

- Python: PSF License and historical notices. See `third-party-licenses/Python-LICENSE.txt` in the distribution.
- Playwright: Apache-2.0. Package metadata and license files are copied into `_internal`.
- Chromium: Chromium/BSD-style and third-party licenses. Original browser distribution files are preserved under `_internal/bundled-browsers`. Chromium's `chrome://credits` lists included components and notices.
- FastAPI, Uvicorn, Pydantic, Starlette and AnyIO: see the copied package `.dist-info` directories, including their license material where supplied by the original wheels.
- PyInstaller: its bootloader exception permits redistribution of packaged applications subject to the applicable component licenses. See https://pyinstaller.org/en/stable/license.html.

The application has not been code-signed. A build artifact is not a claim that the program has passed clean-machine runtime acceptance or that its site automation will remain compatible with future website changes.

## Arena Trace Inspector 2.3.0

Runtime source supplied by the project owner and included with their explicit authorization for public distribution. Original source headers are retained; no standalone upstream license file was supplied, and inclusion does not relicense third-party code. Harbor does not claim affiliation with Arena or Trigger.dev.

Only the manifest and runtime JavaScript/HTML/CSS are bundled under `extensions/arena-trace-inspector`. Developer tests, reports, captured data and user settings are excluded. The bundled manifest adds a public extension-ID key so side-by-side Harbor updates keep a stable bundled extension identity. No private signing key is distributed and the application is not code-signed.

The extension loads automatically in managed persistent and disposable-profile environments. It uses activeTab/debugger/storage permissions and accesses Arena/Trigger.dev when operated. Loading does not start listening or drawing. Existing custom-directory records are not automatically migrated to the bundled extension identity, and their old files are not deleted.

Version 2.3.0 retains listening after a user-started drawing run and defaults automatic conversation renaming to enabled when no explicit preference exists. Harbor preserves this upstream behavior and existing preferences; it does not start listening or drawing on behalf of the user. Probe data, upstream test fixtures and research notes are not distributed.

## YesCaptcha 1.4.7

YesCaptcha is not redistributed in this repository or ZIP. On first environment launch Harbor retrieves the public official archive from the vendor documentation attachment, verifies a pinned SHA256 and stores it in the local user cache. The vendor retains its rights; no redistribution license is asserted. See https://yescaptcha.atlassian.net/wiki/spaces/YESCAPTCHA/pages/25722881.

The official manifest requests storage, contextMenus, alarms, management and all_urls host access. This is broad browser access, not a full security-audit claim. The manager encrypts the global ClientKey at rest; the extension needs the key in its own local browser storage at runtime. An absent key disables autorun; a configured key can incur vendor charges. Changes apply at the next environment launch, not to already running browsers. No paid solving was used for release testing.
