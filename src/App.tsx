import { useCallback, useEffect, useState } from 'react'
import { api, type Mode, type PermissionControl, type Settings } from './lib/api'
import { AppProvider, useApp } from './lib/store'
import { Onboarding } from './components/Onboarding'
import { TopBar } from './components/TopBar'
import { Workspace } from './components/Workspace'
import { SettingsView, type SettingsPage } from './settings/Settings'
import { useTheme } from './lib/theme'
import { ForceUnloadToast, StatusBar, UpdateReadyDialog } from './components/Updates'

export function App() {
  const [settings, setSettings] = useState<Settings | null>(null)
  // Before the main shell mounts (boot + onboarding); the shell applies the theme afterwards.
  useTheme(settings?.theme, !settings?.vaultPath)
  useEffect(() => {
    api().settings.get().then(setSettings)
  }, [])
  if (!settings) return <div className="boot" />
  if (!settings.vaultPath) return <Onboarding onDone={setSettings} />
  return (
    <AppProvider initial={settings}>
      <Shell />
    </AppProvider>
  )
}

function Shell() {
  const { ollamaRunning, settings, launcher } = useApp()
  useTheme(settings.theme)
  const [mode, setMode] = useState<Mode>('chat')
  const [settingsPage, setSettingsPage] = useState<SettingsPage | null>(null)
  const [permissionCtl, setPermissionCtl] = useState<PermissionControl | null>(null)
  const registerPermission = useCallback((c: PermissionControl | null) => setPermissionCtl(c), [])

  // Ctrl+U force-unload. The main process catches real key presses first (and stops them here);
  // this is a fallback for any that reach the page.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'u') {
        e.preventDefault()
        api().model.forceUnload()
      }
    }
    window.addEventListener('keydown', onKey)
    // Dropping a file outside the chat area must not navigate the window to it.
    const stop = (e: Event) => e.preventDefault()
    window.addEventListener('dragover', stop)
    window.addEventListener('drop', stop)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('dragover', stop)
      window.removeEventListener('drop', stop)
    }
  }, [])

  return (
    <div className="app">
      <TopBar
        permission={settingsPage ? null : permissionCtl}
        mode={mode}
        onMode={(m) => {
          setMode(m)
          setSettingsPage(null)
        }}
      />
      {!ollamaRunning && !settingsPage && (
        <div className="banner">
          {launcher?.status === 'starting' ? (
            <>Starting Ollama…</>
          ) : launcher?.status === 'not-installed' ? (
            <>
              Ollama isn’t installed, so local models are unavailable (cloud models still work).{' '}
              <a href="https://ollama.com/download" target="_blank" rel="noreferrer">
                Download Ollama
              </a>{' '}
              then{' '}
              <button className="link-btn" onClick={() => api().ollama.start()}>
                start it
              </button>
              .
            </>
          ) : (
            <>
              Ollama isn’t reachable at {settings.ollamaUrl}
              {launcher?.error ? ` (${launcher.error})` : ''}. Local models are unavailable — cloud models still work.{' '}
              <button className="link-btn" onClick={() => api().ollama.start()}>
                Start Ollama
              </button>
            </>
          )}
        </div>
      )}
      <div className="app-body">
        <Workspace
          mode="chat"
          visible={!settingsPage && mode === 'chat'}
          onManageModels={() => setSettingsPage('models')}
          onOpenGithubSettings={() => setSettingsPage('github')}
          onOpenSettings={() => setSettingsPage('general')}
          onPermissionControl={registerPermission}
        />
        <Workspace
          mode="code"
          visible={!settingsPage && mode === 'code'}
          onManageModels={() => setSettingsPage('models')}
          onOpenGithubSettings={() => setSettingsPage('github')}
          onOpenSettings={() => setSettingsPage('general')}
          onPermissionControl={registerPermission}
        />
        {settingsPage && <SettingsView page={settingsPage} onPage={setSettingsPage} onClose={() => setSettingsPage(null)} />}
      </div>
      <StatusBar />
      <UpdateReadyDialog />
      <ForceUnloadToast />
    </div>
  )
}
