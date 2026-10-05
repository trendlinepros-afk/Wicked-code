// Exposes a small, typed bridge (window.wicked) to the renderer.
const { contextBridge, ipcRenderer, webUtils } = require('electron')

const invoke = (channel) => (...args) => ipcRenderer.invoke(channel, ...args)
const subscribe = (channel) => (cb) => {
  const listener = (_e, payload) => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

contextBridge.exposeInMainWorld('wicked', {
  platform: process.platform,
  settings: { get: invoke('settings:get'), set: invoke('settings:set') },
  apiKeys: { set: invoke('apiKeys:set'), test: invoke('apiKeys:test') },
  dialog: { pickFolder: invoke('dialog:pickFolder') },
  shell: { openPath: invoke('shell:openPath') },
  files: {
    // Full path of a dropped File (File.path no longer exists in sandboxed renderers).
    pathFor: (file) => webUtils.getPathForFile(file),
    extract: invoke('files:extract'),
    pick: invoke('files:pick'),
    savePasted: invoke('files:savePasted'),
    pasteClipboardImage: invoke('files:pasteClipboardImage'),
  },
  vault: { inspect: invoke('vault:inspect'), set: invoke('vault:set'), openMemory: invoke('vault:openMemory') },
  sessions: {
    list: invoke('sessions:list'),
    load: invoke('sessions:load'),
    save: invoke('sessions:save'),
    delete: invoke('sessions:delete'),
    rename: invoke('sessions:rename'),
    generateTitle: invoke('sessions:generateTitle'),
  },
  ollama: { status: invoke('ollama:status'), start: invoke('ollama:start'), onLauncher: subscribe('ollama:launcher') },
  github: {
    user: invoke('github:user'),
    test: invoke('github:test'),
    repos: invoke('github:repos'),
    branches: invoke('github:branches'),
    clone: invoke('github:clone'),
    repoInfo: invoke('github:repoInfo'),
    suggestBranch: invoke('github:suggestBranch'),
  },
  processes: { list: invoke('processes:list'), stop: invoke('processes:stop'), onChanged: subscribe('processes:changed') },
  models: {
    listLocal: invoke('models:listLocal'),
    listCloud: invoke('models:listCloud'),
    pull: invoke('models:pull'),
    cancelPull: invoke('models:cancelPull'),
    delete: invoke('models:delete'),
    setNotes: invoke('models:setNotes'),
    onPullProgress: subscribe('models:pull-progress'),
  },
  model: {
    state: invoke('model:state'),
    set: invoke('model:set'),
    load: invoke('model:load'),
    unload: invoke('model:unload'),
    touch: invoke('model:touch'),
    forceUnload: invoke('model:forceUnload'),
    onForced: subscribe('model:forced'),
    onState: subscribe('model:state'),
  },
  gpu: { stats: invoke('gpu:stats') },
  app: { info: invoke('app:info'), openLogs: invoke('app:openLogs') },
  updater: {
    state: invoke('updater:state'),
    check: invoke('updater:check'),
    install: invoke('updater:install'),
    onStatus: subscribe('updater:status'),
  },
  agent: {
    run: invoke('agent:run'),
    stop: invoke('agent:stop'),
    approve: invoke('agent:approve'),
    setPermission: invoke('agent:setPermission'),
    onEvent: subscribe('agent:event'),
  },
})
