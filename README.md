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
- **Code.** An agentic coding session. Each session starts by choosing the project's **working folder**. The agent can list, read and search files, edit and write files, and run shell commands, all inside that folder. Edits show as diffs, and you approve changes and commands. You can set the approval level in Settings → General.
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

### Publishing updates

Updates are served from this repo's GitHub Releases by `electron-updater`. To ship a new version:

```bash
npm version patch          # bumps package.json version and creates a vX.Y.Z tag
git push --follow-tags     # the Release workflow builds Windows/macOS/Linux installers and publishes them
```

Installed copies will see the new version when you click **Check for updates**. Notes:
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
