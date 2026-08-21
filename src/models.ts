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

export interface GoModel {
  id: string
  name: string
  contextWindow: number
  /** Reasoning-effort ids the gateway accepts for this model, in display order. */
  efforts?: string[]
}

/** Context capacity assumed when the listing discloses none. */
const FALLBACK_CONTEXT_WINDOW = 262_144

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
/** Single-request fetch budget for the catalog (the API listing is separate). */
const CATALOG_TIMEOUT_MS = 30_000

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

/** Fetch the full catalog and filter to Go-usable models. */
export async function fetchGoModels(
  url: string = DEFAULT_MODELS_URL,
  fetchImpl: typeof fetch = fetch,
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
    models.push({ id, name, contextWindow })
  }
  // Stable order keeps the diff against a persisted catalog deterministic.
  models.sort((a, b) => a.id.localeCompare(b.id))
  return models
}
