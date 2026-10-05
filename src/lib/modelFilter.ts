// Filtering + sorting for the Local Model Management page.

export type SortKey = 'recommended' | 'newest' | 'vram-asc' | 'vram-desc' | 'rating' | 'disk-asc' | 'name'
export type Source = 'all' | 'downloaded' | 'store'

export interface ModelFilter {
  query: string
  sort: SortKey
  source: Source
  minVramGB: number | null // null = no lower limit
  maxVramGB: number | null // null = no upper limit
  fitsOnly: boolean // must fit fully in this GPU's VRAM
  minStars: number // 0 = any
  hideWontRun: boolean
  tags: string[] // model must have every selected tag
  releasedWithinMonths: number | null // null = any release date
}

export const DEFAULT_FILTER: ModelFilter = {
  query: '',
  sort: 'recommended',
  source: 'all',
  minVramGB: null,
  maxVramGB: null,
  fitsOnly: false,
  minStars: 0,
  hideWontRun: false,
  tags: [],
  releasedWithinMonths: null,
}

export const SORT_LABELS: Record<SortKey, string> = {
  recommended: 'Recommended',
  newest: 'Newest release first',
  'vram-asc': 'VRAM: least → most',
  'vram-desc': 'VRAM: most → least',
  rating: 'Best rating for my system',
  'disk-asc': 'Smallest download / disk size',
  name: 'Name (A–Z)',
}

/** Everything the filter needs to know about one model card. */
export interface ModelFacts {
  name: string
  display: string
  vramGB: number
  sizeGB: number
  stars: number
  tags: string[]
  text: string // searchable text (descriptions etc.)
  released?: string // YYYY-MM when known
}

/** Guess capability tags for models that aren't in the catalog, from their name/family. */
export function inferTags(name: string, family: string, vramGB: number): string[] {
  const n = `${name} ${family}`.toLowerCase()
  const tags = new Set<string>()
  if (/coder|code|devstral|starcoder|codestral/.test(n)) tags.add('coding')
  if (/vl\b|vl:|vision|llava|mllama|gemma3|minicpm-v|moondream|qwen2\.5vl|qwen25vl/.test(n)) tags.add('vision')
  if (/r1|reason|think|qwq|phi4|gpt-oss/.test(n)) tags.add('reasoning')
  if (/agent|devstral|qwen3|gpt-oss/.test(n)) tags.add('agentic')
  if (vramGB <= 5) tags.add('small')
  if (vramGB <= 7) tags.add('fast')
  if (!tags.size || /instruct|chat|llama|mistral|gemma/.test(n)) tags.add('general')
  return [...tags]
}

export function matches(f: ModelFilter, m: ModelFacts, gpuVramGB: number): boolean {
  if (f.query) {
    const q = f.query.toLowerCase()
    if (!`${m.name} ${m.display} ${m.tags.join(' ')} ${m.text}`.toLowerCase().includes(q)) return false
  }
  if (f.minVramGB != null && m.vramGB < f.minVramGB) return false
  if (f.maxVramGB != null && m.vramGB > f.maxVramGB) return false
  if (f.fitsOnly && gpuVramGB > 0 && m.vramGB > gpuVramGB) return false
  if (f.minStars > 0 && m.stars < f.minStars) return false
  if (f.hideWontRun && m.stars === 0) return false
  if (f.tags.length && !f.tags.every((t) => m.tags.includes(t))) return false
  if (f.releasedWithinMonths != null) {
    if (!m.released) return false
    const [y, mo] = m.released.split('-').map(Number)
    const now = new Date()
    const ageMonths = (now.getFullYear() - y) * 12 + (now.getMonth() + 1 - mo)
    if (ageMonths > f.releasedWithinMonths) return false
  }
  return true
}

/** Comparator for the chosen sort; returns null for "recommended" (keep each section's own order). */
export function comparator(sort: SortKey): ((a: ModelFacts, b: ModelFacts) => number) | null {
  switch (sort) {
    case 'newest':
      // Unknown release dates go last.
      return (a, b) => (b.released ?? '').localeCompare(a.released ?? '') || a.name.localeCompare(b.name)
    case 'vram-asc':
      return (a, b) => a.vramGB - b.vramGB || a.name.localeCompare(b.name)
    case 'vram-desc':
      return (a, b) => b.vramGB - a.vramGB || a.name.localeCompare(b.name)
    case 'rating':
      return (a, b) => b.stars - a.stars || b.vramGB - a.vramGB
    case 'disk-asc':
      return (a, b) => a.sizeGB - b.sizeGB || a.name.localeCompare(b.name)
    case 'name':
      return (a, b) => a.display.localeCompare(b.display)
    default:
      return null
  }
}

/** Number of filters that differ from the defaults (shown as a badge on the Filter button). */
export function activeCount(f: ModelFilter): number {
  let n = 0
  if (f.sort !== DEFAULT_FILTER.sort) n++
  if (f.source !== 'all') n++
  if (f.minVramGB != null || f.maxVramGB != null) n++
  if (f.fitsOnly) n++
  if (f.minStars > 0) n++
  if (f.hideWontRun) n++
  n += f.tags.length
  if (f.releasedWithinMonths != null) n++
  return n
}

const STORAGE_KEY = 'wicked.modelFilter'

export function loadFilter(): ModelFilter {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? { ...DEFAULT_FILTER, ...JSON.parse(raw), query: '' } : DEFAULT_FILTER
  } catch {
    return DEFAULT_FILTER
  }
}

export function saveFilter(f: ModelFilter) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...f, query: '' }))
  } catch {
    /* storage unavailable */
  }
}
