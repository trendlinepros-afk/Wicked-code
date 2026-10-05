// Curated catalog of Ollama models for the model store.
// vramGB is an estimate for the default quantization with an ~8K token context.

export interface CatalogModel {
  name: string // Ollama tag
  display: string
  sizeGB: number // download size
  vramGB: number // memory needed to run fully on GPU
  released: string // YYYY-MM the model was released
  tags: string[]
  strengths: string
  weaknesses: string
  featured?: boolean
}

export const CATALOG: CatalogModel[] = [
  {
    name: 'qwen3.8:27b',
    released: '2026-08',
    display: 'Qwen 3.8 27B',
    sizeGB: 18,
    vramGB: 21,
    tags: ['coding', 'agentic', 'reasoning', 'vision'],
    strengths: 'Top-tier open model at its size for coding and long agentic tasks; strong tool calling, reasoning and vision.',
    weaknesses: 'Needs a 24 GB-class GPU to run fully on GPU; slower than smaller models and can over-think simple questions.',
    featured: true,
  },
  {
    name: 'qwen3.6:27b',
    released: '2026-04',
    display: 'Qwen 3.6 27B',
    sizeGB: 17,
    vramGB: 20,
    tags: ['coding', 'agentic', 'reasoning'],
    strengths: 'Previous Qwen generation; dependable coder and tool user with good multilingual skills.',
    weaknesses: 'Outclassed by Qwen 3.8 at the same memory cost; still needs ~20 GB VRAM.',
  },
  {
    name: 'qwen3-coder:30b',
    released: '2025-07',
    display: 'Qwen3 Coder 30B (MoE)',
    sizeGB: 19,
    vramGB: 21,
    tags: ['coding', 'agentic'],
    strengths: 'Mixture-of-experts coding specialist: only ~3B active params, so it generates very fast for its size. Great at repo-level edits.',
    weaknesses: 'Weaker at general chat and creative writing; full weights still need ~20 GB of memory.',
  },
  {
    name: 'qwen3:32b',
    released: '2025-04',
    display: 'Qwen3 32B',
    sizeGB: 20,
    vramGB: 23,
    tags: ['reasoning', 'general', 'coding'],
    strengths: 'Strong all-rounder with switchable thinking mode for hard math and logic.',
    weaknesses: 'Heavy for 24 GB cards once context grows; thinking mode is slow.',
  },
  {
    name: 'qwen3:14b',
    released: '2025-04',
    display: 'Qwen3 14B',
    sizeGB: 9.3,
    vramGB: 11,
    tags: ['general', 'reasoning', 'coding'],
    strengths: 'Sweet spot for 12–16 GB GPUs; good reasoning and tool use.',
    weaknesses: 'Noticeably less capable than 27B+ models on complex multi-file coding.',
  },
  {
    name: 'qwen3:8b',
    released: '2025-04',
    display: 'Qwen3 8B',
    sizeGB: 5.2,
    vramGB: 6.5,
    tags: ['general', 'fast'],
    strengths: 'Fast and capable for everyday chat on 8 GB GPUs; supports tools.',
    weaknesses: 'Limited depth on hard coding or research questions; more hallucinations.',
  },
  {
    name: 'qwen3:4b',
    released: '2025-04',
    display: 'Qwen3 4B',
    sizeGB: 2.5,
    vramGB: 3.5,
    tags: ['fast', 'small'],
    strengths: 'Runs on almost anything, including laptops; surprisingly good reasoning for its size.',
    weaknesses: 'Small knowledge base; not reliable for serious coding.',
  },
  {
    name: 'qwen2.5-coder:32b',
    released: '2024-11',
    display: 'Qwen2.5 Coder 32B',
    sizeGB: 20,
    vramGB: 23,
    tags: ['coding'],
    strengths: 'Mature, well-tested code model with excellent code completion and generation.',
    weaknesses: 'Older generation; weaker agentic/tool use than Qwen3 coders.',
  },
  {
    name: 'qwen2.5-coder:7b',
    released: '2024-09',
    display: 'Qwen2.5 Coder 7B',
    sizeGB: 4.7,
    vramGB: 6,
    tags: ['coding', 'fast'],
    strengths: 'Fast code helper for small GPUs; good for snippets and explanations.',
    weaknesses: 'Struggles with large codebases and multi-step agent tasks.',
  },
  {
    name: 'devstral:24b',
    released: '2025-05',
    display: 'Devstral 24B',
    sizeGB: 14,
    vramGB: 16,
    tags: ['coding', 'agentic'],
    strengths: 'Mistral’s agentic coding model, tuned for exploring codebases and editing files with tools.',
    weaknesses: 'Less polished for general conversation; needs 16 GB+ VRAM.',
  },
  {
    name: 'gpt-oss:20b',
    released: '2025-08',
    display: 'gpt-oss 20B',
    sizeGB: 14,
    vramGB: 16,
    tags: ['reasoning', 'agentic', 'general'],
    strengths: 'OpenAI open-weight MoE model; strong reasoning and tool use with fast generation.',
    weaknesses: 'Text-only; can be terse and has more conservative refusals.',
  },
  {
    name: 'gpt-oss:120b',
    released: '2025-08',
    display: 'gpt-oss 120B',
    sizeGB: 65,
    vramGB: 70,
    tags: ['reasoning', 'agentic', 'general'],
    strengths: 'Near frontier-level reasoning in an open model.',
    weaknesses: 'Needs workstation-class memory (80 GB GPU or large unified memory).',
  },
  {
    name: 'gemma3:27b',
    released: '2025-03',
    display: 'Gemma 3 27B',
    sizeGB: 17,
    vramGB: 20,
    tags: ['general', 'vision', 'writing'],
    strengths: 'Google’s strongest Gemma: great writing quality, multilingual and image understanding.',
    weaknesses: 'No native tool calling in Ollama, so code mode cannot edit files directly.',
  },
  {
    name: 'gemma3:12b',
    released: '2025-03',
    display: 'Gemma 3 12B',
    sizeGB: 8.1,
    vramGB: 10,
    tags: ['general', 'vision', 'writing'],
    strengths: 'Good writer and summarizer with vision support on mid-range GPUs.',
    weaknesses: 'No tool calling; average at coding.',
  },
  {
    name: 'gemma3:4b',
    released: '2025-03',
    display: 'Gemma 3 4B',
    sizeGB: 3.3,
    vramGB: 4.5,
    tags: ['fast', 'small', 'vision'],
    strengths: 'Tiny, fast and multimodal — handy for quick questions.',
    weaknesses: 'Shallow reasoning; no tool calling.',
  },
  {
    name: 'llama3.3:70b',
    released: '2024-12',
    display: 'Llama 3.3 70B',
    sizeGB: 43,
    vramGB: 48,
    tags: ['general', 'writing'],
    strengths: 'Very knowledgeable generalist with natural conversational style.',
    weaknesses: 'Huge memory needs (two 24 GB GPUs or 64 GB+ unified memory); older for coding.',
  },
  {
    name: 'llama3.1:8b',
    released: '2024-07',
    display: 'Llama 3.1 8B',
    sizeGB: 4.9,
    vramGB: 6.5,
    tags: ['general', 'fast'],
    strengths: 'Widely supported, quick, decent tool calling for basic tasks.',
    weaknesses: 'Dated knowledge and weaker reasoning than newer 8B models.',
  },
  {
    name: 'llama3.2:3b',
    released: '2024-09',
    display: 'Llama 3.2 3B',
    sizeGB: 2.0,
    vramGB: 3,
    tags: ['fast', 'small'],
    strengths: 'Very light; good for summaries and simple chat on low-end hardware.',
    weaknesses: 'Limited reasoning and coding ability.',
  },
  {
    name: 'deepseek-r1:32b',
    released: '2025-01',
    display: 'DeepSeek R1 32B (distill)',
    sizeGB: 20,
    vramGB: 23,
    tags: ['reasoning'],
    strengths: 'Shows its chain of thought; strong on math and logic puzzles.',
    weaknesses: 'Slow due to long thinking; poor tool use, so weak in code mode.',
  },
  {
    name: 'deepseek-r1:14b',
    released: '2025-01',
    display: 'DeepSeek R1 14B (distill)',
    sizeGB: 9.0,
    vramGB: 11,
    tags: ['reasoning'],
    strengths: 'Reasoning model that fits on 12 GB GPUs.',
    weaknesses: 'Verbose; not good at tool calling or long conversations.',
  },
  {
    name: 'deepseek-r1:8b',
    released: '2025-05',
    display: 'DeepSeek R1 8B (distill)',
    sizeGB: 5.2,
    vramGB: 6.5,
    tags: ['reasoning', 'fast'],
    strengths: 'Lightweight thinking model for step-by-step problems.',
    weaknesses: 'Small model reasoning can still go off the rails; no tools.',
  },
  {
    name: 'mistral-small3.2:24b',
    released: '2025-06',
    display: 'Mistral Small 3.2 24B',
    sizeGB: 15,
    vramGB: 17,
    tags: ['general', 'vision', 'agentic'],
    strengths: 'Balanced, fast, follows instructions well, supports tools and images.',
    weaknesses: 'Less capable at hard coding than dedicated coder models.',
  },
  {
    name: 'mistral:7b',
    released: '2024-05',
    display: 'Mistral 7B',
    sizeGB: 4.1,
    vramGB: 5.5,
    tags: ['general', 'fast'],
    strengths: 'Classic fast small model; light on resources.',
    weaknesses: 'Old; weaker than newer 7–8B models across the board.',
  },
  {
    name: 'phi4:14b',
    released: '2024-12',
    display: 'Phi-4 14B',
    sizeGB: 9.1,
    vramGB: 11,
    tags: ['reasoning', 'general'],
    strengths: 'Microsoft model trained on high-quality data; good at math and structured reasoning.',
    weaknesses: '16K context; limited tool calling and world knowledge.',
  },
  {
    name: 'phi4-mini:3.8b',
    released: '2025-02',
    display: 'Phi-4 Mini 3.8B',
    sizeGB: 2.5,
    vramGB: 3.5,
    tags: ['fast', 'small'],
    strengths: 'Very small and quick, supports function calling.',
    weaknesses: 'Small model limitations on knowledge and code quality.',
  },
]

const BY_NAME = new Map(CATALOG.map((m) => [m.name, m]))

/** Find catalog info for an installed model (exact tag, or ":latest" alias). */
export function catalogInfo(name: string): CatalogModel | undefined {
  return BY_NAME.get(name) ?? BY_NAME.get(name.replace(/:latest$/, ''))
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** "2026-08" → "Aug 2026" */
export function formatReleased(yyyymm: string): string {
  const [y, m] = yyyymm.split('-').map(Number)
  return `${MONTHS[m - 1]} ${y}`
}

/** Estimate the VRAM an installed model needs from its file size. */
export function estimateVramGB(sizeBytes: number): number {
  const gb = sizeBytes / 1024 ** 3
  return Math.round((gb * 1.1 + 1.5) * 10) / 10
}
