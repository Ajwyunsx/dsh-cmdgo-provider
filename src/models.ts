/**
 * Command Code Go model discovery: pull the live catalog from the public
 * `/provider/v1/models` endpoint and keep only the models a Go-plan
 * subscription can actually call.
 *
 * The listing endpoint is open (no auth required, and a Go key would be
 * refused here anyway — Go has no Provider-API access). It discloses only
 * `id` / `name` / `context_length`; reasoning-effort support is NOT part of
 * the Provider API, so effort metadata is merged from the model catalog the
 * official `command-code` CLI ships (`dist/bundled/command-code-knowledge/
 * reference/models.md`), fetched live from jsDelivr so it tracks the `latest`
 * release instead of a checked-in snapshot.
 *
 * Input modalities are NOT in the listing either, and the catalog's prose
 * column is not a usable signal (cross-checked: 39 of 70 rows disagree with
 * the registry — Claude / GPT / Qwen all accept images without ever saying
 * "vision"). The authoritative source is the CLI's own model registry, whose
 * `inputModalities` field is what makes the CLI strip images or not. It is
 * snapshotted into `KNOWN_MODALITIES` below and refreshed live when the
 * catalog grows an id the snapshot has never seen.
 *
 * The Go membership rule mirrors the official plans/go page and the opencode
 * commandcode-go plugin:
 * - All open-source models (deepseek, moonshotai, zai-org, MiniMaxAI, xiaomi,
 *   Qwen, stepfun, tencent, nvidia, thinkingmachines, poolside).
 * - A few premium exceptions included outright: GPT-5.6 Luna, Grok 4.5, and
 *   Muse Spark 1.2 Contributor.
 * - Everything else premium (Claude, other GPTs, Gemini, Grok 4.6, Fugu
 *   Ultra, Muse Spark 1.1 / standard 1.2) is excluded.
 *
 * @module commandcode-go/models
 */

/** Input modalities the harness models (`text` is always present). */
export type ModelInputModality = 'text' | 'image'

export interface GoModel {
  id: string
  name: string
  contextWindow: number
  /** Reasoning-effort ids the gateway accepts for this model, in display order. */
  efforts?: string[]
  /**
   * 该模型接受的输入模态。缺省视为纯文本——声明 `image` 会让 harness 把图片
   * 原样交给适配器，声明缺失/纯文本则会被 harness 换成占位文字（见 usage
   * 上游 `projectImagesForTextModel`）。
   */
  inputModalities?: readonly ModelInputModality[]
}

/** Context capacity assumed when the listing discloses none. */
const FALLBACK_CONTEXT_WINDOW = 262_144

/** 官方 CLI 模型注册表快照：模型 id -> 是否接受图像输入。 */
const KNOWN_MODALITIES: Readonly<Record<string, ModelInputModality>> = {

  "claude-fable-5": "image",
  "claude-fable-5-1": "image",
  "claude-haiku-4-5-20251001": "image",
  "claude-opus-4-7": "image",
  "claude-opus-4-8": "image",
  "claude-opus-5": "image",
  "claude-sonnet-4-6": "image",
  "claude-sonnet-5": "image",
  "deepseek/deepseek-v4-flash": "text",
  "deepseek/deepseek-v4-flash-fast": "text",
  "deepseek/deepseek-v4-flash-vision-exp": "image",
  "deepseek/deepseek-v4-pro": "text",
  "deepseek/deepseek-v4.1-flash": "image",
  "google/gemini-3.1-flash-lite": "image",
  "google/gemini-3.5-flash": "image",
  "google/gemini-3.5-flash-lite": "image",
  "google/gemini-3.6-flash": "image",
  "google/gemini-3.7-flash": "image",
  "google/gemini-3.8-flash": "image",
  "gpt-5.3-codex": "image",
  "gpt-5.4": "image",
  "gpt-5.4-mini": "image",
  "gpt-5.5": "image",
  "gpt-5.6-luna": "image",
  "gpt-5.6-sol": "image",
  "gpt-5.6-terra": "image",
  "gpt-6-astra": "image",
  "inclusionai/ling-3.0-flash-free": "text",
  "inclusionai/ling-3.0-flash-sante:free": "text",
  "meituan/LongCat-2.0:free": "text",
  "meta/muse-spark-1.1": "image",
  "meta/muse-spark-1.2": "image",
  "meta/muse-spark-1.2-contributor": "image",
  "meta/muse-spark-1.3": "image",
  "meta/muse-spark-1.3-contributor": "image",
  "minimax/minimax-m2.7-free": "text",
  "minimax/minimax-m3-free": "image",
  "MiniMaxAI/MiniMax-M2.5": "text",
  "MiniMaxAI/MiniMax-M2.7": "text",
  "MiniMaxAI/MiniMax-M3": "image",
  "moonshotai/Kimi-K2.5": "image",
  "moonshotai/Kimi-K2.6": "image",
  "moonshotai/Kimi-K2.7-Code": "image",
  "moonshotai/Kimi-K2.7-Code-Highspeed": "image",
  "moonshotai/Kimi-K3": "image",
  "nvidia/nemotron-3-ultra-550b-a55b": "text",
  "poolside/laguna-s-2.1-free": "text",
  "Qwen/Qwen3.6-Max-Preview": "text",
  "Qwen/Qwen3.6-Plus": "image",
  "Qwen/Qwen3.7-Flash": "image",
  "Qwen/Qwen3.7-Max": "text",
  "Qwen/Qwen3.7-Plus": "image",
  "Qwen/Qwen3.8-27B": "image",
  "Qwen/Qwen3.8-Flash": "image",
  "Qwen/Qwen3.8-Max": "image",
  "Qwen/Qwen3.8-Max-0902": "image",
  "sakana/fugu-ultra": "image",
  "stepfun/Step-3.5-Flash": "text",
  "stepfun/Step-3.7-Flash": "image",
  "tencent/Hy3": "text",
  "tencent/hy3-paid": "text",
  "tencent/hy4-preview": "text",
  "thinkingmachines/inkling": "image",
  "thinkingmachines/inkling-small": "image",
  "xai/grok-4.5": "image",
  "xai/grok-4.6": "image",
  "xiaomi/mimo-v2.5": "image",
  "xiaomi/mimo-v2.5-pro": "text",
  "z-ai/glm-5.3-flash": "image",
  "zai-org/GLM-5": "text",
  "zai-org/GLM-5.1": "text",
  "zai-org/GLM-5.2": "text",
  "zai-org/GLM-5.2-Fast": "text",
  "zai-org/GLM-5.3": "text",
}

/** 该 id 是否出现在离线快照里（用于判断要不要去拉实时注册表）。 */
export function hasKnownModality(id: string): boolean {
  return KNOWN_MODALITIES[id] !== undefined
}

/**
 * 一个模型最终生效的输入模态。
 * 优先用实时注册表；它没有该 id 时回退到离线快照；都查不到则按纯文本处理
 * （保守：宁可让 harness 换成占位文字，也不要静默丢图或误报能力）。
 */
export function modalitiesFor(
  id: string,
  live?: ReadonlyMap<string, readonly string[]>,
): ModelInputModality[] {
  const remote = live?.get(id)
  if (remote !== undefined) {
    return remote.includes('image') ? ['text', 'image'] : ['text']
  }
  return KNOWN_MODALITIES[id] === 'image' ? ['text', 'image'] : ['text']
}

/** Premium models included on the Go plan outright (from docs/plans/go). */
const GO_PREMIUM_EXCEPTIONS: ReadonlySet<string> = new Set([
  'gpt-5.6-luna',
  'xai/grok-4.5',
  'meta/muse-spark-1.2-contributor',
])

/** Providers whose every model is premium and therefore absent from Go. */
const PREMIUM_ONLY_PREFIXES = ['google/', 'sakana/', 'anthropic/']

function hasPremiumPrefix(id: string): boolean {
  for (const prefix of PREMIUM_ONLY_PREFIXES) {
    if (id.startsWith(prefix)) return true
  }
  return false
}

/** Whether a model id is part of the Go plan. */
export function isGoModel(id: string): boolean {
  if (GO_PREMIUM_EXCEPTIONS.has(id)) return true
  if (hasPremiumPrefix(id)) return false
  const slash = id.indexOf('/')
  const short = slash === -1 ? id : id.slice(slash + 1)
  // Any remaining model whose short id begins with a premium brand is excluded
  // even when the full id lacks a telling prefix (defensive: keep the catalog
  // honest against upstream listing changes).
  const premiumBrands = [
    'claude-',
    'gpt-',
    'gemini-',
    'grok-',
    'fugu-',
    'muse-spark-',
  ]
  for (const brand of premiumBrands) {
    if (short.startsWith(brand)) return false
  }
  return true
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * Parse the effort column of the official CLI model catalog
 * (`reference/models.md`). The column is a comma-separated list such as
 * `low, medium, high, xhigh, max`; a dash (`—`) means the model decides its
 * own reasoning depth (no explicit effort selectors).
 */
function parseEfforts(raw: string): string[] | undefined {
  const trimmed = raw.trim()
  if (trimmed.length === 0 || trimmed === '—' || trimmed === '-') return undefined
  return trimmed
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
}

/** Parse `reference/models.md` rows into model id → effort list. */
export function parseCatalogEfforts(markdown: string): Map<string, string[]> {
  const byId = new Map<string, string[]>()
  // Row shape: | `id` | Name | Context | Efforts | $/1M … | Min plan | Best for |
  for (const line of markdown.split('\n')) {
    if (!line.trimStart().startsWith('|')) continue
    const cells = line.split('|').map((cell) => cell.trim())
    const id = cells[1]?.replace(/^`|`$/g, '')
    const efforts = cells[4]
    if (id === undefined || efforts === undefined) continue
    const parsed = parseEfforts(efforts)
    if (parsed !== undefined) byId.set(id, parsed)
  }
  return byId
}

const DEFAULT_MODELS_URL = 'https://api.commandcode.ai/provider/v1/models'
/** Official CLI catalog served from npm; `@latest` tracks new releases. */
const CATALOG_URL = 'https://cdn.jsdelivr.net/npm/command-code@latest/dist/bundled/command-code-knowledge/reference/models.md'
/** Official CLI bundle carrying the model registry (`inputModalities`). */
const REGISTRY_URL = 'https://cdn.jsdelivr.net/npm/command-code@latest/dist/cli.mjs'
/** Single-request fetch budget for the catalog (the API listing is separate). */
const CATALOG_TIMEOUT_MS = 30_000
/** The registry bundle is ~2.5 MB, so it gets a looser budget. */
const REGISTRY_TIMEOUT_MS = 60_000
/** How far back from `inputModalities` to look for the owning registry entry. */
const REGISTRY_LOOKBEHIND = 600

/** Fetch the official CLI catalog and extract per-model reasoning efforts. */
export async function fetchCatalogEfforts(
  url: string = CATALOG_URL,
  fetchImpl: typeof fetch = fetch,
): Promise<Map<string, string[]>> {
  const response = await fetchImpl(url, {
    headers: { accept: 'text/markdown' },
    signal: AbortSignal.timeout(CATALOG_TIMEOUT_MS),
  })
  if (!response.ok) {
    throw new Error(`Command Code catalog answered HTTP ${response.status}`)
  }
  return parseCatalogEfforts(await response.text())
}

/**
 * Parse the CLI's bundled model registry out of `dist/cli.mjs`.
 *
 * Each registry entry is an object literal like
 * `SONNET_5:{id:"claude-sonnet-5",inputModalities:["text","image"],…}`. The
 * bundle is minified, so instead of assuming a fixed key order we take every
 * `inputModalities:[…]` occurrence and attribute it to the nearest preceding
 * `id:"…"` inside a bounded window — which survives reordering that a strict
 * adjacency regex would miss.
 *
 * @param bundle - raw `cli.mjs` source.
 * @returns model id → declared modalities (entries without `image` are text-only).
 */
export function parseCatalogModalities(bundle: string): Map<string, string[]> {
  const byId = new Map<string, string[]>()
  const re = /inputModalities:\s*\[([^\]]*)\]/g
  let match: RegExpExecArray | null
  while ((match = re.exec(bundle)) !== null) {
    const window = bundle.slice(Math.max(0, match.index - REGISTRY_LOOKBEHIND), match.index)
    const ids = [...window.matchAll(/id:"([^"]+)"/g)]
    const id = ids[ids.length - 1]?.[1]
    if (id === undefined || byId.has(id)) continue
    const modalities = (match[1] ?? '')
      .split(',')
      .map((part) => part.trim().replace(/^"|"$/g, ''))
      .filter((part) => part.length > 0)
    byId.set(id, modalities)
  }
  return byId
}

/**
 * Fetch the CLI bundle and extract the live modality registry. Expensive
 * (~2.5 MB), so callers gate it behind the offline snapshot.
 */
export async function fetchCatalogModalities(
  url: string = REGISTRY_URL,
  fetchImpl: typeof fetch = fetch,
): Promise<Map<string, string[]>> {
  const response = await fetchImpl(url, {
    headers: { accept: 'text/javascript' },
    signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS),
  })
  if (!response.ok) {
    throw new Error(`Command Code registry answered HTTP ${response.status}`)
  }
  return parseCatalogModalities(await response.text())
}

/**
 * 用实时注册表覆盖一批已取到的模型模态。目录只拉一次，实时表只做合并。
 */
export function applyModalities(
  models: readonly GoModel[],
  live?: ReadonlyMap<string, readonly string[]>,
): GoModel[] {
  return models.map(model => ({ ...model, inputModalities: modalitiesFor(model.id, live) }))
}

/**
 * Fetch the full catalog and filter to Go-usable models.
 *
 * @param liveModalities - optional live registry map merged over the offline
 * snapshot (see `modalitiesFor`).
 */
export async function fetchGoModels(
  url: string = DEFAULT_MODELS_URL,
  fetchImpl: typeof fetch = fetch,
  liveModalities?: ReadonlyMap<string, readonly string[]>,
): Promise<GoModel[]> {
  const response = await fetchImpl(url, {
    headers: { accept: 'application/json' },
  })
  if (!response.ok) {
    throw new Error(`Command Code models endpoint answered HTTP ${response.status}`)
  }
  const payload: unknown = await response.json()
  if (!isRecord(payload) || !Array.isArray(payload.data)) {
    throw new Error('Command Code models endpoint returned an unexpected shape')
  }
  const models: GoModel[] = []
  for (const raw of payload.data) {
    if (!isRecord(raw)) continue
    const id = nonEmptyString(raw.id)
    if (id === undefined || !isGoModel(id)) continue
    const name = nonEmptyString(raw.name) ?? id.split('/').pop() ?? id
    const contextWindow = positiveNumber(raw.context_length)
      ?? positiveNumber(raw.context_window)
      ?? FALLBACK_CONTEXT_WINDOW
    models.push({ id, name, contextWindow, inputModalities: modalitiesFor(id, liveModalities) })
  }
  // Stable order keeps the diff against a persisted catalog deterministic.
  models.sort((a, b) => a.id.localeCompare(b.id))
  return models
}
