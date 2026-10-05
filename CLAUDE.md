# Wicked Code — working notes

## Shipping changes (always do this)
- Push every finished change to **`main`** (the owner wants all updates, builds and workflows pushed there so the in-app "Check for updates" button sees them).
- **Bump `version` in `package.json`** for every app change you push to `main` (patch for fixes, minor for features); docs-only changes don't need a bump. The Release workflow (`.github/workflows/release.yml`) only publishes when the version is new; it tests, builds Windows/macOS/Linux installers and publishes a GitHub Release, which installed apps update from.
- After pushing, check the Release workflow run succeeds and report the installer link:
  `https://github.com/trendlinepros-afk/Wicked-code/releases/latest/download/Wicked-Code-Setup.exe`
- Keep the Windows artifact name `Wicked-Code-Setup.exe` (no version) so that link stays stable.

## Never break user settings on update
- Settings live in the user-data folder pinned in `electron/main.cjs` (`app.setPath('userData', …/Wicked Code)`). Don't change `productName`, `appId` or that path.
- `electron/config.cjs` merges saved values over `DEFAULTS`: add new settings to `DEFAULTS`, never rename or drop existing keys, never overwrite saved values with new defaults.
- The NSIS installer keeps app data (`deleteAppDataOnUninstall: false`). Chats/code sessions live in the user's Obsidian vault.

## Checks before pushing
- `npm run typecheck`, `npm test` (main-process unit tests incl. agent loop), `npm run build`.
