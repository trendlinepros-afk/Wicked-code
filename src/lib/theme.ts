import { useEffect } from 'react'
import type { Theme } from './api'

const media = () => window.matchMedia('(prefers-color-scheme: dark)')

export function resolveTheme(theme: Theme): 'light' | 'dark' {
  if (theme === 'light' || theme === 'dark') return theme
  return media().matches ? 'dark' : 'light'
}

/** Apply the chosen theme to <html data-theme>, following the OS when set to "system". */
export function useTheme(theme: Theme | undefined, enabled = true) {
  useEffect(() => {
    if (!enabled) return
    const t = theme ?? 'system'
    const apply = () => (document.documentElement.dataset.theme = resolveTheme(t))
    apply()
    if (t !== 'system') return
    const m = media()
    m.addEventListener('change', apply)
    return () => m.removeEventListener('change', apply)
  }, [theme, enabled])
}
