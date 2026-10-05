# Wicked Code

A simplified, local-first take on the Claude Code desktop app. It has two workspaces, **Chat** and **Code**, plus Settings. It runs local models through [Ollama](https://ollama.com) and can also use **Anthropic**, **Google Gemini**, **DeepSeek** and **xAI Grok** through their APIs.

## Features

- **Obsidian vault first.** On first launch you pick your Obsidian vault. Every chat and code session is saved there as a Markdown note:
  ```
  <vault>/Wicked Code/
  ├── Chats/              one note per chat
  ├── Code Sessions/      one note per code session
  ├── Memory.md           long-term memory, sent to the AI in every session
  └── .sessions/          full session data (hidden from Obsidian)
  ```
- **Chat.** A general assistant. Use **Add folder** to give the model read-only access to folders (it can list, read and search files).
- **Code.** An agentic coding session. Each session starts from a **local working folder** or a **GitHub repository**. The agent works in a **build → run → test → fix loop**:
  - reads, searches, edits and writes files (sandboxed to the folder)
  - runs commands and tests (`run_command`)
  - launches servers and apps in the background (`start_process`), reads their logs and stops them
  - tests what it built with `http_request` (local servers) and `browser_check` (a real headless browser that reports page text, console errors and failed requests, and can run a script such as clicking a button)
  - `browser_check` also takes a screenshot: vision models are shown it and asked "does this look like what my owner asked for?", then check the console for errors, fix and re-test
  - built-in **preview panel** next to the chat shows the page it builds (no external browser); **Screenshot** attaches the preview to your next message
- **Lessons Learned** (top bar): the model reviews the open chat / code session, posts what failed and exactly what made it work, and saves one note per lesson to `Vault/Lessons Learned/<model>/<model>-<lesson, max 5 words>.md`
- **Notes window** (sidebar → Notes): an app-wide note plus a note per chat / code session, auto-saved to `Vault/Wicked Code/Notes`
- **VRAM safety buffer** (Settings → General): big models put only as many layers on the GPU as fit below total VRAM minus the buffer; the rest runs from system RAM
  - reads failures, fixes the code and re-runs until it passes; long loops are kept inside the model's context window automatically

  Edits show as diffs. You approve changes and commands, or click **Allow all for this session**. Approval level and max agent steps are in Settings → General.
- **GitHub (like Claude Code).** Connect a fine-grained token in Settings → GitHub. In **Code → New code session → GitHub repository**:
  1. Pick a repository and base branch.
  2. Wicked Code clones it and works on a new branch.
  3. The agent can commit, push and open pull requests. Use the **Commit, push & open PR** shortcut, or just ask.

  Git is authenticated through environment variables, so the token is never written to disk. Requires git.
- **Ollama starts with the app.** If Ollama isn't running, Wicked Code launches `ollama serve` and stops it again on exit (only if it started it). Both are toggles in Settings → General.
- **Model load/unload + VRAM meter** in the top bar. The meter shows used vs. available VRAM: NVIDIA via `nvidia-smi`, AMD via `rocm-smi`, Apple Silicon via unified memory.
- **Automatic model lifecycle:**
  - The selected local model loads as soon as you start typing.
  - After 30 seconds with no chatting or coding activity it unloads itself. The timeout can be changed.
  - Switching models from the picker at the bottom right of the chat box unloads the old model from memory before loading the new one.
- **Settings:**
  - **API Keys.** Add, test, replace or remove keys for Anthropic, Gemini, DeepSeek and Grok. Keys are encrypted with the OS keychain via Electron `safeStorage`.
  - **Local Model Management.** Lists your downloaded models. Each one shows strengths and weaknesses, the VRAM it needs, a **1–5 star rating** for how well it should run on *your* hardware (no stars = won't run), your own **notes**, and a red **Delete** button that asks for Yes/No confirmation. Below that is a **model store** of popular models. Each **Download** asks for Yes/No confirmation and shows live progress. **Qwen 3.8 27B** (`qwen3.8:27b`) is the featured default model.

- **Light / dark mode.** Settings → General → Appearance has *Use system*, *Light* and *Dark*. *Use system* follows your OS setting live.
- **Updates.** Settings → General → **Check for updates** looks for a newer release on GitHub and downloads it in the background (progress also shows in the bottom status bar). When the download finishes, a popup offers **Install & restart** or **I'll do this later**. If you choose later, the update installs the next time you close the app.
- **Version number** is shown at the very bottom left of the window.

### How the star rating works

Each model's memory need (from the catalog, or estimated from its file size) is compared with your GPU's VRAM:

| Stars | Meaning |
|---|---|
| ★★★★★ | uses ≤ 60% of VRAM |
| ★★★★ | ≤ 80% of VRAM |
| ★★★ | fits, but tight |
| ★★ | spills into system RAM (slower) |
| ★ | mostly CPU, very slow |
| *none* | needs more than VRAM + available RAM: won't run |

## Getting started

Prerequisites: [Node.js 20+](https://nodejs.org) and [Ollama](https://ollama.com/download) running locally.

```bash
npm install
ollama pull qwen3.8:27b     # or download it from Settings → Local Model Management
npm run dev                 # starts Vite + Electron with hot reload
```

Build an installer:

```bash
npm run dist:win     # or dist:mac / dist:linux → ./release
```

### Download

**Windows installer (always the latest):** https://github.com/trendlinepros-afk/Wicked-code/releases/latest/download/Wicked-Code-Setup.exe

The macOS (`.dmg`) and Linux (`.AppImage`) builds are on the [Releases page](https://github.com/trendlinepros-afk/Wicked-code/releases/latest).

### Publishing updates

Updates are served from this repo's GitHub Releases by `electron-updater`. Every push to `main` runs the **Release** workflow:
1. It tests and builds the app.
2. If the `version` in `package.json` hasn't been released yet, it builds Windows, macOS and Linux installers and publishes them as a release.

To ship, bump the version (`npm version patch --no-git-tag-version`) and push to `main`. Installed copies get the update from **Check for updates**. Settings are kept across updates.

Notes:
- The repository must be **public**, or the app can't download private release assets.
- macOS auto-update requires the app to be code-signed.
- In dev mode (`npm run dev`) the button reports that updates only work in the installed app.

Other scripts: `npm test` runs the main-process unit tests and `npm run typecheck` runs TypeScript.

## Project layout

```
electron/            Electron main process (CommonJS)
  main.cjs           window + IPC
  preload.cjs        secure bridge exposed as window.wicked
  config.cjs         settings + encrypted API keys
  ollama.cjs         Ollama REST client (list, pull, delete, load/unload, chat)
  modelManager.cjs   active model, auto-load on typing, idle unload, model switching
  gpu.cjs            VRAM detection
  providers.cjs      streaming + tool calling for Ollama, Anthropic, Gemini, DeepSeek, Grok
  agent.cjs          agent loop and file/command tools (sandboxed to session folders)
  vault.cjs          Obsidian vault persistence
src/                 React + TypeScript UI (Vite)
  components/        top bar, chat/code workspace, model picker, onboarding
  settings/          General, API Keys, Local Model Management
  lib/catalog.ts     model store catalog (descriptions, VRAM needs)
  lib/rating.ts      star rating logic
```
