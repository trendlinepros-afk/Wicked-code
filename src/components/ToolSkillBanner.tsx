import { useState } from 'react'
import { parseModelId } from '../lib/api'
import { CATALOG, toolSkill, vramNeededGB } from '../lib/catalog'
import { fitsNow } from '../lib/rating'
import { useApp } from '../lib/store'
import { Icon } from './ui'

/**
 * Code sessions need a model that reliably calls tools (to create files, run and test code).
 * Warn when the selected model isn't one, and suggest models that fit this machine right now.
 */
export function ToolSkillBanner({ onManageModels }: { onManageModels(): void }) {
  const { settings, localModels, gpu, selectModel } = useApp()
  const [dismissed, setDismissed] = useState<string | null>(null)
  const id = settings.selectedModel
  if (!id || dismissed === id) return null
  const skill = toolSkill(id)
  if (skill === 'good') return null
  const ctx = settings.contextLength || 8192
  const installed = new Set(localModels.map((m) => m.name.replace(/:latest$/, '')))
  const suggestions = CATALOG.filter((m) => m.tags.includes('agentic') && fitsNow(vramNeededGB(m.name, ctx), gpu))
    .sort((a, b) => Number(installed.has(b.name)) - Number(installed.has(a.name)) || b.vramGB - a.vramGB)
    .slice(0, 3)
  return (
    <div className={`skill-banner ${skill}`}>
      <Icon name="code" size={16} />
      <div className="skill-text">
        <b>{parseModelId(id).model}</b>{' '}
        {skill === 'poor' ? 'often fails to use tools' : 'may not use tools reliably'} — in Code mode it might paste code instead of creating
        files, or claim it ran things it didn’t.{' '}
        {suggestions.length ? (
          <>
            Better for coding on your GPU right now:{' '}
            {suggestions.map((m, i) => (
              <span key={m.name}>
                {i > 0 && ', '}
                <button
                  className="link-btn"
                  onClick={() => (installed.has(m.name) ? selectModel(`ollama:${m.name}`, { load: false }) : onManageModels())}
                  title={installed.has(m.name) ? 'Use this model' : 'Not downloaded yet — open the model store'}
                >
                  {m.display}
                </button>
                {!installed.has(m.name) && <span className="muted"> (download)</span>}
              </span>
            ))}
            .
          </>
        ) : (
          <>Pick a model tagged “agentic” in Local Model Management.</>
        )}
      </div>
      <button className="skill-close" onClick={() => setDismissed(id)} title="Dismiss">
        <Icon name="x" size={13} />
      </button>
    </div>
  )
}
