/**
 * Command Code usage / quota reader.
 *
 * Mirrors the official CLI's `/usage` command: the same three routes the
 * bundled `cmd` binary calls (verified against `command-code@1.53.0`, whose
 * route table declares `/alpha/whoami`, `/alpha/billing/credits`,
 * `/alpha/billing/subscriptions` and `/alpha/usage/summary`):
 *
 *   GET /alpha/whoami                 -> user + optional org
 *   GET /alpha/billing/credits        -> monthly credit pool + rolling window meters
 *   GET /alpha/billing/subscriptions  -> plan id, status, billing period
 *
 * Every plan has a monthly credit pool plus two rolling windows on top of it
 * (docs: commandcode.ai/docs/resources/usage-limits). `billing/credits`
 * returns the remaining monthly pool in `credits.monthlyCredits` and both
 * window meters in `windowLimits.{fiveHour,weekly}` as
 * `{ used, cap, exceeded, resetAt }`. The monthly *allowance* is not returned,
 * so it is recovered from the subscription plan (`planId`, else the
 * 5-hour/weekly cap pair, which is plan-specific and therefore unambiguous).
 *
 * Reads are cached per credential ref so the client's 2.5s status poll never
 * fans out to the gateway: callers always get the last snapshot and trigger a
 * background refresh at most once per TTL.
 *
 * @module cmdgo/usage
 */
import { CC_VERSION } from './protocol.js';
/** How long a fetched quota snapshot stays fresh. */
export const DEFAULT_USAGE_TTL_MS = 60_000;
/** Per-request timeout; a quota read must never stall the status route. */
export const DEFAULT_USAGE_TIMEOUT_MS = 8_000;
/** Fallback gateway base when the caller does not pass one. */
const DEFAULT_BASE_URL = 'https://api.commandcode.ai';
/**
 * Plan catalogue: the monthly credit allowance per subscription plan, plus the
 * 5-hour/weekly caps it implies. Caps are 30%/60% of the monthly pool on most
 * plans and 20%/50% on GOAT/Pro, which is exactly what the gateway returns —
 * so the cap pair identifies the plan when `planId` is unfamiliar.
 */
const PLANS = [
    { id: 'individual-go', name: 'Go', monthly: 10, fiveHourCap: 3, weeklyCap: 6 },
    { id: 'individual-goat', name: 'GOAT', monthly: 70, fiveHourCap: 14, weeklyCap: 35 },
    { id: 'individual-pro', name: 'Pro', monthly: 80, fiveHourCap: 16, weeklyCap: 40 },
    { id: 'individual-max-10x', name: 'Max 10×', monthly: 150, fiveHourCap: 45, weeklyCap: 90 },
    { id: 'individual-max-20x', name: 'Max 20×', monthly: 300, fiveHourCap: 90, weeklyCap: 180 },
    { id: 'team-pro', name: 'Team Pro', monthly: 40, fiveHourCap: 12, weeklyCap: 24 },
];
function isRecord(value) {
    return typeof value === 'object' && value !== null;
}
function num(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
function str(value) {
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}
function round(value, digits = 4) {
    const factor = 10 ** digits;
    return Math.round(value * factor) / factor;
}
/** Turn a raw window meter into a JSON-safe, display-ready window. */
function windowOf(raw) {
    if (!isRecord(raw))
        return undefined;
    const used = num(raw.used) ?? 0;
    const cap = num(raw.cap) ?? 0;
    const resetAt = num(raw.resetAt);
    return {
        used: round(used),
        cap: round(cap),
        remaining: round(Math.max(0, cap - used)),
        ...(cap > 0 ? { percent: round(Math.min(1, used / cap)) } : {}),
        exceeded: raw.exceeded === true || (cap > 0 && used >= cap),
        ...(resetAt === undefined ? {} : { resetAt }),
    };
}
/** Human fallback for a plan id the catalogue does not know. */
function prettifyPlanId(id) {
    const bare = id.replace(/^(individual|team)[-_]/, '').replace(/[-_]+/g, ' ').trim();
    if (bare.length === 0)
        return id;
    return bare.replace(/\b[a-z]/g, (c) => c.toUpperCase());
}
/**
 * Identify the plan behind a subscription: the `planId` when known, otherwise
 * the 5-hour/weekly cap pair (plan-specific, so a unique match is reliable).
 */
export function resolvePlan(planId, fiveHourCap, weeklyCap) {
    const id = (planId ?? '').toLowerCase();
    if (id.length > 0) {
        const exact = PLANS.find((plan) => plan.id === id);
        if (exact !== undefined)
            return exact;
        // 'individual-goat' starts with 'individual-go': prefer the longest id.
        const prefixed = PLANS
            .filter((plan) => id.startsWith(plan.id))
            .sort((a, b) => b.id.length - a.id.length)[0];
        if (prefixed !== undefined)
            return prefixed;
    }
    const five = num(fiveHourCap);
    const weekly = num(weeklyCap);
    if (five !== undefined && five > 0) {
        const byCaps = PLANS.find((plan) => Math.abs(plan.fiveHourCap - five) < 0.01
            && (weekly === undefined || Math.abs(plan.weeklyCap - weekly) < 0.01));
        if (byCaps !== undefined)
            return byCaps;
    }
    return undefined;
}
/** Shape the raw gateway payloads into the flat quota view the UI renders. */
export function normalizeUsage(credits, subscription, user) {
    const pool = isRecord(credits) && isRecord(credits.credits) ? credits.credits : {};
    const limits = isRecord(credits) && isRecord(credits.windowLimits) ? credits.windowLimits : {};
    const fiveHour = windowOf(limits.fiveHour);
    const weekly = windowOf(limits.weekly);
    const sub = isRecord(subscription) && isRecord(subscription.data) ? subscription.data : subscription;
    const planId = isRecord(sub) ? str(sub.planId) : undefined;
    const plan = resolvePlan(planId, fiveHour?.cap, weekly?.cap);
    const remaining = num(pool.monthlyCredits);
    const purchased = num(pool.purchasedCredits) ?? 0;
    const free = num(pool.freeCredits) ?? 0;
    const total = plan?.monthly;
    const usedMonthly = total !== undefined && remaining !== undefined ? Math.max(0, total - remaining) : undefined;
    const rawPeriodEnd = isRecord(sub) ? sub.currentPeriodEnd : undefined;
    const periodEnd = typeof rawPeriodEnd === 'string' ? Date.parse(rawPeriodEnd) : NaN;
    const subStatus = isRecord(sub) ? str(sub.status) : undefined;
    const owner = isRecord(user) && isRecord(user.user)
        ? user.user
        : (isRecord(user) && isRecord(user.data) && isRecord(user.data.user) ? user.data.user : undefined);
    const userName = isRecord(owner) ? str(owner.userName) : undefined;
    const displayName = isRecord(owner) ? str(owner.name) : undefined;
    return {
        plan: {
            ...(planId === undefined ? {} : { id: planId }),
            name: plan?.name ?? (planId === undefined ? 'Command Code' : prettifyPlanId(planId)),
            ...(subStatus === undefined ? {} : { status: subStatus }),
            ...(Number.isFinite(periodEnd) ? { currentPeriodEnd: periodEnd } : {}),
        },
        monthly: {
            ...(remaining === undefined ? {} : { remaining: round(remaining) }),
            ...(total === undefined ? {} : { total }),
            ...(usedMonthly === undefined ? {} : { used: round(usedMonthly) }),
            ...(usedMonthly === undefined || total === undefined || total <= 0
                ? {}
                : { percent: round(Math.min(1, usedMonthly / total)) }),
            purchased: round(purchased),
            free: round(free),
            extra: round(purchased + free),
        },
        ...(fiveHour === undefined ? {} : { fiveHour }),
        ...(weekly === undefined ? {} : { weekly }),
        ...(userName === undefined ? {} : { userName }),
        ...(displayName === undefined ? {} : { displayName }),
        limited: limits.limited === true,
        readAt: Date.now(),
    };
}
/**
 * Per-account quota cache. One entry per credential ref; reads are deduplicated
 * and a failed attempt is rate-limited by the same TTL as a successful one.
 */
export class UsageReader {
    baseURL;
    log;
    ttlMs;
    timeoutMs;
    entries = new Map();
    constructor(options = {}) {
        this.baseURL = options.baseURL ?? DEFAULT_BASE_URL;
        this.log = options.log ?? (() => { });
        this.ttlMs = options.ttlMs ?? DEFAULT_USAGE_TTL_MS;
        this.timeoutMs = options.timeoutMs ?? DEFAULT_USAGE_TIMEOUT_MS;
    }
    resolveBase() {
        const raw = typeof this.baseURL === 'function' ? this.baseURL() : this.baseURL;
        return (raw ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    }
    /**
     * Whether `key` needs a fetch: no snapshot yet, or the last attempt (success
     * or failure) is older than the TTL. Failure counts as an attempt so a dead
     * key is not retried on every status poll.
     */
    stale(key) {
        const entry = this.entries.get(key);
        if (entry === undefined)
            return true;
        const last = Math.max(entry.dataAt ?? 0, entry.errorAt ?? 0);
        return Date.now() - last >= this.ttlMs;
    }
    /** Last known quota for `key`; never performs I/O and never throws. */
    snapshot(key) {
        const entry = this.entries.get(key);
        if (entry === undefined)
            return undefined;
        if (entry.data !== undefined) {
            return {
                ok: true,
                ...entry.data,
                fetchedAt: entry.dataAt ?? 0,
                stale: this.stale(key),
                ...(entry.error === undefined ? {} : { warning: entry.error }),
            };
        }
        if (entry.error !== undefined) {
            return { ok: false, error: entry.error, fetchedAt: entry.errorAt ?? 0 };
        }
        return undefined;
    }
    /** Record that an account has no resolvable key, so the UI can say so. */
    markMissing(key) {
        const entry = this.entries.get(key) ?? {};
        entry.error = '凭据缺失，无法读取额度';
        entry.errorAt = Date.now();
        entry.inflight = undefined;
        this.entries.set(key, entry);
    }
    /**
     * Refresh one account's quota. Concurrent callers share a single in-flight
     * request; a fresh snapshot is returned as-is unless `force` is set. The
     * returned promise rejects on failure, but the rejection is also absorbed
     * here because callers normally fire this without awaiting.
     */
    refresh(key, apiKey, options = {}) {
        const existing = this.entries.get(key);
        if (existing?.inflight !== undefined)
            return existing.inflight;
        if (options.force !== true && existing?.data !== undefined && !this.stale(key)) {
            return Promise.resolve(existing.data);
        }
        const entry = existing ?? {};
        this.entries.set(key, entry);
        const inflight = this.read(apiKey).then((data) => {
            entry.data = data;
            entry.dataAt = Date.now();
            entry.error = undefined;
            entry.errorAt = undefined;
            return data;
        }, (error) => {
            entry.error = error instanceof Error ? error.message : String(error);
            entry.errorAt = Date.now();
            // 保留上一次成功的数据：UI 继续显示旧值并标注 stale。
            this.log(`[cmdgo] 额度读取失败（${key}）：${entry.error}`);
            throw error;
        }).finally(() => {
            entry.inflight = undefined;
        });
        entry.inflight = inflight;
        inflight.catch(() => { });
        return inflight;
    }
    /** One full quota read: whoami (best effort) + credits + subscription. */
    async read(apiKey) {
        const headers = {
            authorization: `Bearer ${apiKey}`,
            'user-agent': 'cli',
            'x-cli-environment': 'cli',
            'x-command-code-version': CC_VERSION,
            accept: 'application/json',
        };
        // whoami 只为补充展示名与 org；失败不影响额度本身。
        const whoami = await this.getJson('/alpha/whoami', headers).catch(() => undefined);
        const orgId = isRecord(whoami) && isRecord(whoami.org)
            ? str(whoami.org.id)
            : (isRecord(whoami) && isRecord(whoami.data) && isRecord(whoami.data.org) ? str(whoami.data.org.id) : undefined);
        const query = orgId !== undefined ? `?orgId=${encodeURIComponent(orgId)}` : '';
        const credits = await this.getJson(`/alpha/billing/credits${query}`, headers);
        const subscription = await this.getJson(`/alpha/billing/subscriptions${query}`, headers).catch(() => undefined);
        return normalizeUsage(credits, subscription, whoami);
    }
    async getJson(path, headers) {
        const response = await fetch(`${this.resolveBase()}${path}`, {
            headers,
            signal: AbortSignal.timeout(this.timeoutMs),
        });
        if (!response.ok) {
            const body = await response.text().catch(() => '');
            throw new Error(`HTTP ${response.status}${body.length > 0 ? ` ${body.slice(0, 160)}` : ''}`);
        }
        return await response.json();
    }
}
