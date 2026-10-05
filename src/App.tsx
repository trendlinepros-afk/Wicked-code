import { useEffect, useState } from 'react'
import { api, type Mode, type Settings } from './lib/api'
import { AppProvider, useApp } from './lib/store'
import { Onboarding } from './components/Onboarding'
import { TopBar } from './components/TopBar'
import { Workspace } from './components/Workspace'
import { SettingsView, type SettingsPage } from './settings/Settings'
import { useTheme } from './lib/theme'
import { StatusBar, UpdateReadyDialog } from './components/Updates'

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
  const { ollamaRunning, settings } = useApp()
  useTheme(settings.theme)
  const [mode, setMode] = useState<Mode>('chat')
  const [settingsPage, setSettingsPage] = useState<SettingsPage | null>(null)

  return (
    <div className="app">
      <TopBar
        mode={mode}
        onMode={(m) => {
          setMode(m)
          setSettingsPage(null)
        }}
        onSettings={() => setSettingsPage((p) => (p ? null : 'general'))}
      />
      {!ollamaRunning && !settingsPage && (
        <div className="banner">
          Ollama isn’t reachable at {settings.ollamaUrl}. Local models are unavailable until it’s running — cloud models still work.
        </div>
      )}
      <div className="app-body">
        <Workspace mode="chat" visible={!settingsPage && mode === 'chat'} onManageModels={() => setSettingsPage('models')} />
        <Workspace mode="code" visible={!settingsPage && mode === 'code'} onManageModels={() => setSettingsPage('models')} />
        {settingsPage && <SettingsView page={settingsPage} onPage={setSettingsPage} onClose={() => setSettingsPage(null)} />}
      </div>
      <StatusBar />
      <UpdateReadyDialog />
    </div>
  )
}
