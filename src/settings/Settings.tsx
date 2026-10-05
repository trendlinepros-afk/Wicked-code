import { Icon } from '../components/ui'
import { ApiKeys } from './ApiKeys'
import { General } from './General'
import { LocalModels } from './LocalModels'

export type SettingsPage = 'general' | 'keys' | 'models'

export function SettingsView({ page, onPage, onClose }: { page: SettingsPage; onPage(p: SettingsPage): void; onClose(): void }) {
  const nav: { id: SettingsPage; label: string; icon: string }[] = [
    { id: 'general', label: 'General', icon: 'sliders' },
    { id: 'keys', label: 'API Keys', icon: 'key' },
    { id: 'models', label: 'Local Model Management', icon: 'cpu' },
  ]
  return (
    <div className="settings">
      <aside className="settings-nav">
        <div className="settings-nav-title">Settings</div>
        {nav.map((n) => (
          <button key={n.id} className={page === n.id ? 'active' : ''} onClick={() => onPage(n.id)}>
            <Icon name={n.icon} size={16} /> {n.label}
          </button>
        ))}
        <div className="topbar-spacer" />
        <button className="btn settings-back" onClick={onClose}>
          <Icon name="x" size={14} /> Close settings
        </button>
      </aside>
      <main className="settings-main">
        {page === 'general' && <General />}
        {page === 'keys' && <ApiKeys />}
        {page === 'models' && <LocalModels />}
      </main>
    </div>
  )
}
