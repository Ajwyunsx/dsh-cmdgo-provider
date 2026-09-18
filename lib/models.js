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
 * The Go membership rule is two-tiered, because neither tier alone is good
 * enough:
 *
 * 1. **Fast baseline** — {@link isGoModel}'s static rule (open-source providers
 *    in, premium brands out, a short premium exception list). It needs no extra
 *    network call, so the model list can be published the moment the listing
 *    lands. Its weakness is that it goes stale: it once hardcoded
 *    `muse-spark-1.2-contributor` and silently dropped 1.3 when upstream
 *    promoted it (#7).
 * 2. **Authoritative overlay** — the catalog's own `Min plan` column, which the
 *    plugin already downloads for reasoning efforts. It is applied as an
 *    override once it arrives (in both directions: it can add a promoted model
 *    and remove a demoted one), so upstream tier changes are picked up without
 *    a plugin release. Models absent from the table keep the baseline verdict.
 *
 * Fetched live from jsDelivr so both the efforts and the plan column track the
 * `latest` release instead of a checked-in snapshot.
 *
 * @module commandcode-go/models
 */
/** Context capacity assumed when the listing discloses none. */
const FALLBACK_CONTEXT_WINDOW = 262_144;
/** 官方 CLI 模型注册表快照：模型 id -> 是否接受图像输入。 */
const KNOWN_MODALITIES = {
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
};
/** 该 id 是否出现在离线快照里（用于判断要不要去拉实时注册表）。 */
export function hasKnownModality(id) {
    return KNOWN_MODALITIES[id] !== undefined;
}
/**
 * 一个模型最终生效的输入模态。
 * 优先用实时注册表；它没有该 id 时回退到离线快照；都查不到则按纯文本处理
 * （保守：宁可让 harness 换成占位文字，也不要静默丢图或误报能力）。
 */
export function modalitiesFor(id, live) {
    const remote = live?.get(id);
    if (remote !== undefined) {
        return remote.includes('image') ? ['text', 'image'] : ['text'];
    }
    return KNOWN_MODALITIES[id] === 'image' ? ['text', 'image'] : ['text'];
}
/**
 * Premium models included on the Go plan outright (from docs/plans/go).
 *
 * This is only the **fast baseline** used before the authoritative `Min plan`
 * column arrives; it is deliberately kept small, because every entry here is a
 * promise upstream can invalidate with the next release (exactly what happened
 * when Muse Spark 1.3 replaced 1.2, issue #7). The overlay below is what keeps
 * membership correct over time.
 */
const GO_PREMIUM_EXCEPTIONS = new Set([
    'gpt-5.6-luna',
    'xai/grok-4.5',
    'meta/muse-spark-1.2-contributor',
    'meta/muse-spark-1.3-contributor',
]);
/** Providers whose every model is premium and therefore absent from Go. */
const PREMIUM_ONLY_PREFIXES = ['google/', 'sakana/', 'anthropic/'];
function hasPremiumPrefix(id) {
    for (const prefix of PREMIUM_ONLY_PREFIXES) {
        if (id.startsWith(prefix))
            return true;
    }
    return false;
}
/**
 * Whether a model id is part of the Go plan.
 *
 * @param id - exact gateway model id.
 * @param plan - authoritative `Min plan` verdicts parsed from the CLI catalog;
 * when it names this id its answer wins in both directions (promotion and
 * demotion), otherwise the static baseline decides.
 */
export function isGoModel(id, plan) {
    const authoritative = plan?.get(id);
    if (authoritative !== undefined)
        return authoritative;
    if (GO_PREMIUM_EXCEPTIONS.has(id))
        return true;
    if (hasPremiumPrefix(id))
        return false;
    const slash = id.indexOf('/');
    const short = slash === -1 ? id : id.slice(slash + 1);
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
    ];
    for (const brand of premiumBrands) {
        if (short.startsWith(brand))
            return false;
    }
    return true;
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function positiveNumber(value) {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}
function nonEmptyString(value) {
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}
/**
 * Parse the effort column of the official CLI model catalog
 * (`reference/models.md`). The column is a comma-separated list such as
 * `low, medium, high, xhigh, max`; a dash (`—`) means the model decides its
 * own reasoning depth (no explicit effort selectors).
 */
function parseEfforts(raw) {
    const trimmed = raw.trim();
    if (trimmed.length === 0 || trimmed === '—' || trimmed === '-')
        return undefined;
    return trimmed
        .split(',')
        .map((part) => part.trim())
        .filter((part) => part.length > 0);
}
/**
 * Whether a `Min plan` cell names the Go tier.
 *
 * Observed values are `Go and above` (45 rows), `GOAT and above` (6),
 * `Pro and above` (13) and `Max` (7). GOAT/Pro/Max are *higher* tiers, so only
 * the Go tier (and a hypothetical `Free`) counts. The `\b` in the pattern is
 * what keeps `GOAT and above` from matching.
 */
function parseGoPlan(raw) {
    const value = raw.trim();
    if (value.length === 0 || value === '—' || value === '-')
        return undefined;
    return /^(free|go|go and above)$/i.test(value);
}
/**
 * Split `reference/models.md` into model rows.
 *
 * Column shape: `| \`id\` | Name | Context | Efforts | $/1M … | Min plan | Best for |`.
 * The document also contains unrelated tables whose first cells are headers or
 * rules, so a row only counts when its id cell is backticked — every real model
 * id is, and that filters out `Id (use EXACTLY this)` and `---`.
 */
function catalogRows(markdown) {
    const rows = [];
    for (const line of markdown.split('\n')) {
        if (!line.trimStart().startsWith('|'))
            continue;
        const cells = line.split('|').map((cell) => cell.trim());
        const rawId = cells[1];
        if (rawId === undefined || !/^`.+`$/.test(rawId))
            continue;
        const id = rawId.replace(/^`|`$/g, '');
        if (id.length === 0)
            continue;
        rows.push({
            id,
            efforts: parseEfforts(cells[4] ?? ''),
            goPlan: parseGoPlan(cells[6] ?? ''),
        });
    }
    return rows;
}
/**
 * Parse the official CLI model catalog once into both derived maps: reasoning
 * efforts and the authoritative Go-tier verdict.
 */
export function parseCatalog(markdown) {
    const efforts = new Map();
    const plans = new Map();
    for (const row of catalogRows(markdown)) {
        if (row.efforts !== undefined && !efforts.has(row.id))
            efforts.set(row.id, row.efforts);
        if (row.goPlan !== undefined && !plans.has(row.id))
            plans.set(row.id, row.goPlan);
    }
    return { efforts, plans };
}
/** Parse `reference/models.md` rows into model id → effort list. */
export function parseCatalogEfforts(markdown) {
    return parseCatalog(markdown).efforts;
}
/** Parse `reference/models.md` rows into model id → is-Go-tier. */
export function parseCatalogPlans(markdown) {
    return parseCatalog(markdown).plans;
}
const DEFAULT_MODELS_URL = 'https://api.commandcode.ai/provider/v1/models';
/** Official CLI catalog served from npm; `@latest` tracks new releases. */
const CATALOG_URL = 'https://cdn.jsdelivr.net/npm/command-code@latest/dist/bundled/command-code-knowledge/reference/models.md';
/** Official CLI bundle carrying the model registry (`inputModalities`). */
const REGISTRY_URL = 'https://cdn.jsdelivr.net/npm/command-code@latest/dist/cli.mjs';
/** Single-request fetch budget for the catalog (the API listing is separate). */
const CATALOG_TIMEOUT_MS = 30_000;
/** The registry bundle is ~2.5 MB, so it gets a looser budget. */
const REGISTRY_TIMEOUT_MS = 60_000;
/** How far back from `inputModalities` to look for the owning registry entry. */
const REGISTRY_LOOKBEHIND = 600;
/** Fetch the official CLI catalog and extract per-model reasoning efforts. */
export async function fetchCatalogEfforts(url = CATALOG_URL, fetchImpl = fetch) {
    return (await fetchCatalog(url, fetchImpl)).efforts;
}
/**
 * Fetch the official CLI catalog once and derive both maps it carries:
 * reasoning efforts and the authoritative Go-tier verdict per model.
 */
export async function fetchCatalog(url = CATALOG_URL, fetchImpl = fetch) {
    const response = await fetchImpl(url, {
        headers: { accept: 'text/markdown' },
        signal: AbortSignal.timeout(CATALOG_TIMEOUT_MS),
    });
    if (!response.ok) {
        throw new Error(`Command Code catalog answered HTTP ${response.status}`);
    }
    return parseCatalog(await response.text());
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
export function parseCatalogModalities(bundle) {
    const byId = new Map();
    const re = /inputModalities:\s*\[([^\]]*)\]/g;
    let match;
    while ((match = re.exec(bundle)) !== null) {
        const window = bundle.slice(Math.max(0, match.index - REGISTRY_LOOKBEHIND), match.index);
        const ids = [...window.matchAll(/id:"([^"]+)"/g)];
        const id = ids[ids.length - 1]?.[1];
        if (id === undefined || byId.has(id))
            continue;
        const modalities = (match[1] ?? '')
            .split(',')
            .map((part) => part.trim().replace(/^"|"$/g, ''))
            .filter((part) => part.length > 0);
        byId.set(id, modalities);
    }
    return byId;
}
/**
 * Fetch the CLI bundle and extract the live modality registry. Expensive
 * (~2.5 MB), so callers gate it behind the offline snapshot.
 */
export async function fetchCatalogModalities(url = REGISTRY_URL, fetchImpl = fetch) {
    const response = await fetchImpl(url, {
        headers: { accept: 'text/javascript' },
        signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS),
    });
    if (!response.ok) {
        throw new Error(`Command Code registry answered HTTP ${response.status}`);
    }
    return parseCatalogModalities(await response.text());
}
/**
 * 用实时注册表覆盖一批已取到的模型模态。目录只拉一次，实时表只做合并。
 */
export function applyModalities(models, live) {
    return models.map(model => ({ ...model, inputModalities: modalitiesFor(model.id, live) }));
}
/**
 * Fetch the provider listing **without** applying the Go rule.
 *
 * Keeping the unfiltered list is what lets {@link selectGoModels} be re-run
 * once the authoritative `Min plan` column arrives and *add* a model the static
 * baseline had excluded (#7) — a pre-filtered list could never grow back.
 *
 * @param liveModalities - optional live registry map merged over the offline
 * snapshot (see `modalitiesFor`).
 */
export async function fetchAllModels(url = DEFAULT_MODELS_URL, fetchImpl = fetch, liveModalities) {
    const response = await fetchImpl(url, {
        headers: { accept: 'application/json' },
    });
    if (!response.ok) {
        throw new Error(`Command Code models endpoint answered HTTP ${response.status}`);
    }
    const payload = await response.json();
    if (!isRecord(payload) || !Array.isArray(payload.data)) {
        throw new Error('Command Code models endpoint returned an unexpected shape');
    }
    const models = [];
    for (const raw of payload.data) {
        if (!isRecord(raw))
            continue;
        const id = nonEmptyString(raw.id);
        if (id === undefined)
            continue;
        const name = nonEmptyString(raw.name) ?? id.split('/').pop() ?? id;
        const contextWindow = positiveNumber(raw.context_length)
            ?? positiveNumber(raw.context_window)
            ?? FALLBACK_CONTEXT_WINDOW;
        models.push({ id, name, contextWindow, inputModalities: modalitiesFor(id, liveModalities) });
    }
    return models;
}
/**
 * Apply the Go membership rule and order the result.
 *
 * @param models - unfiltered listing from {@link fetchAllModels}.
 * @param plan - authoritative `Min plan` verdicts; overrides the static rule.
 */
export function selectGoModels(models, plan) {
    // Stable order keeps the diff against a persisted catalog deterministic.
    return models
        .filter(model => isGoModel(model.id, plan))
        .sort((a, b) => a.id.localeCompare(b.id));
}
/**
 * Fetch the listing and filter it to Go-usable models in one step.
 *
 * @param liveModalities - optional live registry map merged over the offline
 * snapshot (see `modalitiesFor`).
 * @param plan - optional authoritative `Min plan` verdicts.
 */
export async function fetchGoModels(url = DEFAULT_MODELS_URL, fetchImpl = fetch, liveModalities, plan) {
    return selectGoModels(await fetchAllModels(url, fetchImpl, liveModalities), plan);
}
