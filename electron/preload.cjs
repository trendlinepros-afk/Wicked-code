// Exposes a small, typed bridge (window.wicked) to the renderer.
const { contextBridge, ipcRenderer } = require('electron')

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
  vault: { inspect: invoke('vault:inspect'), set: invoke('vault:set'), openMemory: invoke('vault:openMemory') },
  sessions: {
    list: invoke('sessions:list'),
    load: invoke('sessions:load'),
    save: invoke('sessions:save'),
    delete: invoke('sessions:delete'),
  },
  ollama: { status: invoke('ollama:status') },
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
    onState: subscribe('model:state'),
  },
  gpu: { stats: invoke('gpu:stats') },
  agent: {
    run: invoke('agent:run'),
    stop: invoke('agent:stop'),
    approve: invoke('agent:approve'),
    onEvent: subscribe('agent:event'),
  },
})
