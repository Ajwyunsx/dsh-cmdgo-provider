/**
 * 请求用量台账：把适配器每次请求的 token 用量（含缓存读 / 写）按**会话**聚合，
 * 供 HUD 展示「缓存到底有没有命中」。
 *
 * 为什么需要：网关的 usage 流里带 `cacheReadTokens`（部分版本还带缓存写入），
 * 但 harness 只把用量喂给 token 计量，插件此前既不显示也无法回看——于是用户
 * 完全无法判断 `x-session-id` 对齐之后缓存亲和是否真的生效（issue #6 的补充
 * 问题）。
 *
 * 纯内存、有上限淘汰、不含凭据；会话只以短哈希标签对外出现（完整 sessionId
 * 只用于本机匹配）。
 *
 * @module cmdgo/request-stats
 */
import { createHash } from 'node:crypto';
/** 最多保留多少个会话行。 */
export const DEFAULT_MAX_SESSION_ROWS = 24;
function emptyCounters() {
    return {
        requests: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        cacheReportedRequests: 0,
    };
}
function add(into, sample) {
    into.requests += 1;
    into.inputTokens += sample.inputTokens;
    into.outputTokens += sample.outputTokens;
    into.cacheReadTokens += sample.cacheReadTokens ?? 0;
    into.cacheWriteTokens += sample.cacheWriteTokens ?? 0;
    if (sample.cacheReadTokens !== undefined || sample.cacheWriteTokens !== undefined) {
        into.cacheReportedRequests += 1;
    }
}
/** 会话短标签：稳定、不可逆，足以区分同进程里的多个会话。 */
function labelFor(sessionId) {
    return createHash('sha256').update(sessionId).digest('hex').slice(0, 8);
}
/** 命中率：缓存读 ÷ 计费输入总量（未命中 + 缓存读 + 缓存写）。 */
export function cacheHitRate(sample) {
    const read = sample.cacheReadTokens ?? 0;
    const billed = sample.inputTokens + read + (sample.cacheWriteTokens ?? 0);
    return billed > 0 ? read / billed : 0;
}
/** 请求用量台账。 */
export class RequestStats {
    maxSessions;
    total = emptyCounters();
    rows = new Map();
    last;
    constructor(options = {}) {
        this.maxSessions = Math.max(1, options.maxSessions ?? DEFAULT_MAX_SESSION_ROWS);
    }
    /** 记一次完成的请求。 */
    record(sample) {
        this.last = sample;
        add(this.total, sample);
        const key = sample.sessionId !== undefined && sample.sessionId.length > 0 ? sample.sessionId : '';
        const existing = this.rows.get(key);
        const row = existing ?? { ...emptyCounters(), label: key === '' ? '-' : labelFor(key), updatedAt: sample.at };
        add(row, sample);
        row.model = sample.model;
        row.updatedAt = sample.at;
        // Map 保序：删了再插即可让最近使用的排最后（展示时倒序取）。
        this.rows.delete(key);
        this.rows.set(key, row);
        while (this.rows.size > this.maxSessions) {
            const oldest = this.rows.keys().next();
            if (oldest.done === true)
                break;
            this.rows.delete(oldest.value);
        }
    }
    /** 客户端可见快照；`sessionId` 命中时附带 `current`。 */
    view(sessionId) {
        const sessions = [...this.rows.values()].slice().reverse();
        const current = sessionId === undefined || sessionId.length === 0
            ? undefined
            : this.rows.get(sessionId);
        const last = this.last;
        return {
            ...last === undefined ? {} : {
                last: {
                    model: last.model,
                    at: last.at,
                    inputTokens: last.inputTokens,
                    outputTokens: last.outputTokens,
                    ...last.cacheReadTokens === undefined ? {} : { cacheReadTokens: last.cacheReadTokens },
                    ...last.cacheWriteTokens === undefined ? {} : { cacheWriteTokens: last.cacheWriteTokens },
                    ...last.reasoningTokens === undefined ? {} : { reasoningTokens: last.reasoningTokens },
                    cacheHitRate: cacheHitRate(last),
                    cacheReported: last.cacheReadTokens !== undefined || last.cacheWriteTokens !== undefined,
                },
            },
            total: { ...this.total },
            sessions,
            ...current === undefined ? {} : { current: { ...current } },
        };
    }
}
