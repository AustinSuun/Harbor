# Third-party components

This distribution includes Python, Playwright, Chromium, FastAPI, Uvicorn, Pydantic and their dependencies. Their respective licenses continue to apply. This document does not replace those licenses.

- Python: PSF License and historical notices. See `third-party-licenses/Python-LICENSE.txt` in the distribution.
- Playwright: Apache-2.0. Package metadata and license files are copied into `_internal`.
- Chromium: Chromium/BSD-style and third-party licenses. Original browser distribution files are preserved under `_internal/bundled-browsers`. Chromium's `chrome://credits` lists included components and notices.
- FastAPI, Uvicorn, Pydantic, Starlette and AnyIO: see the copied package `.dist-info` directories, including their license material where supplied by the original wheels.
- PyInstaller: its bootloader exception permits redistribution of packaged applications subject to the applicable component licenses. See https://pyinstaller.org/en/stable/license.html.

The application has not been code-signed. A build artifact is not a claim that the program has passed clean-machine runtime acceptance or that its site automation will remain compatible with future website changes.
