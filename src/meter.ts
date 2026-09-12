/**
 * 调用计量器：把「额度消耗」与「本插件实际发出的调用次数」对齐，得到**实测**的
 * 平均单次消耗，据此估算「理论剩余调用次数」。
 *
 * 为什么需要它：网关只返回 credit 余额与 5H/周/月窗口的 `{used, cap}`，**没有任何
 * 调用次数概念**（见 `usage.ts`）。所以「还能调几次」只能自己测，不能拍一个单价。
 *
 * 做法：
 *   1. 网关接受一个请求时（adapter 的 `onKeySuccess`，此刻恰好一次/请求）计数 +1；
 *   2. 每次额度快照刷新时，比较该账号 `monthly.remaining` 的变化；
 *   3. `remaining` 下降 = 这段时间被消耗掉的 credit，但**只有该区间内确有本插件的
 *      调用时才把这笔消耗归因给这些调用** —— 否则用户在外部用 `cmd` CLI 的消耗会
 *      算进来，把单次成本抬高；
 *   4. `remaining` 上升（账单重置 / 购买额度）只更新基线，不计入消耗。
 *
 * 平均单次消耗 = 归因消耗 / 归因调用数；样本不足时**不给数字**（宁可显示"样本不足"
 * 也不编造单价）。
 *
 * @module cmdgo/meter
 */

import { homedir } from 'node:os'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { randomBytes } from 'node:crypto'

/** 至少要有这么多个「有调用且有额度差」的有效样本。 */
export const MIN_METER_SAMPLES = 2
/** 且至少累计归因到这么多次调用。 */
export const MIN_METER_CALLS = 3

/** 客户端可见的计量快照（不含任何凭据）。 */
export interface MeterSnapshot {
  /** 累计计数到的调用次数（网关已接受的请求）。 */
  totalCalls: number
  /** 其中被归因到额度消耗统计的调用次数。 */
  attributedCalls: number
  /** 实测消耗掉的 credit 合计。 */
  consumed: number
  /** 实测平均单次消耗（credit）；样本不足时缺省。 */
  perCall?: number
  /** 有效样本数。 */
  samples: number
  /** 是否已够样本、可以给出估算。 */
  ready: boolean
  updatedAt: number
}

interface AccountState {
  /** 上一次看到的月度剩余额度（credit）。 */
  remaining?: number
  /** 自上次额度快照以来的调用次数（跨重启保留）。 */
  pendingCalls: number
}

interface Persisted {
  version: 1
  totalCalls: number
  attributedCalls: number
  consumed: number
  samples: number
  accounts: Record<string, { remaining?: number; pendingCalls?: number }>
  updatedAt: number
}

export interface CallMeterOptions {
  /** 持久化文件；默认 `~/.dsh/cmdgo-meter.json`（测试可注入临时路径）。 */
  file?: string
  log?: (message: string) => void
  /** 落盘节流：调用计数可能很频繁。 */
  flushDelayMs?: number
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function round(value: number, digits = 4): number {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

/**
 * 调用计量器。内存记账，落盘节流；计数与基线都跨重启保留（否则每次重启都要
 * 从零积累样本）。
 */
export class CallMeter {
  private readonly file: string
  private readonly log: (message: string) => void
  private readonly flushDelayMs: number
  private readonly states = new Map<string, AccountState>()
  private totalCalls = 0
  private attributedCalls = 0
  private consumed = 0
  private samples = 0
  private updatedAt = 0
  private loaded = false
  private loading?: Promise<void>
  private timer?: ReturnType<typeof setTimeout>

  constructor(options: CallMeterOptions = {}) {
    this.file = options.file ?? join(homedir(), '.dsh', 'cmdgo-meter.json')
    this.log = options.log ?? (() => {})
    this.flushDelayMs = options.flushDelayMs ?? 3000
  }

  private stateFor(ref: string): AccountState {
    const existing = this.states.get(ref)
    if (existing !== undefined) return existing
    const created: AccountState = { pendingCalls: 0 }
    this.states.set(ref, created)
    return created
  }

  /**
   * 载入一次。并发调用共享同一个 promise；**累加**而不是覆盖，这样在载入完成
   * 之前发生的调用不会丢（冷启动瞬间就可能有一次请求）。
   */
  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return
    if (this.loading !== undefined) return this.loading
    this.loading = (async () => {
      try {
        const raw = await readFile(this.file, 'utf8')
        const parsed = JSON.parse(raw) as Partial<Persisted> | null
        if (parsed !== null && typeof parsed === 'object') {
          this.totalCalls += num(parsed.totalCalls) ?? 0
          this.attributedCalls += num(parsed.attributedCalls) ?? 0
          this.consumed += num(parsed.consumed) ?? 0
          this.samples += num(parsed.samples) ?? 0
          this.updatedAt = num(parsed.updatedAt) ?? 0
          const accounts = parsed.accounts
          if (accounts !== null && typeof accounts === 'object') {
            for (const [ref, value] of Object.entries(accounts)) {
              if (value === null || typeof value !== 'object') continue
              const state = this.stateFor(ref)
              const remaining = num((value as { remaining?: unknown }).remaining)
              // 内存里已经有基线（本次会话先看到过额度）时以内存为准。
              if (remaining !== undefined && state.remaining === undefined) state.remaining = remaining
              state.pendingCalls += num((value as { pendingCalls?: unknown }).pendingCalls) ?? 0
            }
          }
        }
      } catch (_missingOrCorrupt) {
        /* 缺失或损坏：保留内存里的计数，从当前状态继续 */
      }
      this.loaded = true
      this.loading = undefined
    })()
    return this.loading
  }

  /** 记一次「网关已接受」的调用。 */
  noteCall(ref: string): void {
    this.stateFor(ref).pendingCalls += 1
    this.totalCalls += 1
    void this.ensureLoaded()
    this.schedule()
  }

  /**
   * 记一次额度快照：只有在「本次区间内确有调用」时才把额度下降归因给这些调用。
   * 额度上升（重置/购买）只更新基线，并把待归因的调用留到下一个区间。
   */
  noteUsage(ref: string, remaining: number | undefined): void {
    if (remaining === undefined || !Number.isFinite(remaining)) return
    const state = this.stateFor(ref)
    const previous = state.remaining
    const pending = state.pendingCalls
    state.remaining = remaining
    void this.ensureLoaded()
    if (previous !== undefined) {
      const delta = previous - remaining
      if (delta > 0) {
        if (pending > 0) {
          this.consumed += delta
          this.attributedCalls += pending
          this.samples += 1
        }
        state.pendingCalls = 0
      }
      // delta <= 0：额度还没反映这次调用、或已重置/回填 —— 保留 pending 到下一区间，
      // 否则这一批调用会被永久丢掉，样本永远不够。
    }
    this.schedule()
  }

  snapshot(): MeterSnapshot {
    const perCall = this.attributedCalls > 0 && this.consumed > 0
      ? this.consumed / this.attributedCalls
      : undefined
    return {
      totalCalls: this.totalCalls,
      attributedCalls: this.attributedCalls,
      consumed: round(this.consumed),
      ...(perCall === undefined ? {} : { perCall: round(perCall) }),
      samples: this.samples,
      ready: perCall !== undefined
        && this.samples >= MIN_METER_SAMPLES
        && this.attributedCalls >= MIN_METER_CALLS,
      updatedAt: this.updatedAt,
    }
  }

  /** 立刻落盘（进程退出前或测试里用）。 */
  async flushNow(): Promise<void> {
    if (this.timer !== undefined) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    await this.flush()
  }

  /** 撤销挂起的定时器（随 ctx.effect 卸载，不留孤儿计时器）。 */
  dispose(): void {
    if (this.timer === undefined) return
    clearTimeout(this.timer)
    this.timer = undefined
  }

  private schedule(): void {
    if (this.timer !== undefined) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.flush()
    }, this.flushDelayMs)
    // 计量不该拖住宿主进程退出。
    const handle = this.timer as unknown as { unref?: () => void }
    if (typeof handle.unref === 'function') handle.unref()
  }

  private async flush(): Promise<void> {
    await this.ensureLoaded()
    const accounts: Persisted['accounts'] = {}
    for (const [ref, state] of this.states) {
      accounts[ref] = {
        ...(state.remaining === undefined ? {} : { remaining: state.remaining }),
        pendingCalls: state.pendingCalls,
      }
    }
    this.updatedAt = Date.now()
    const payload: Persisted = {
      version: 1,
      totalCalls: this.totalCalls,
      attributedCalls: this.attributedCalls,
      consumed: round(this.consumed),
      samples: this.samples,
      accounts,
      updatedAt: this.updatedAt,
    }
    try {
      await mkdir(dirname(this.file), { recursive: true })
      const tmp = `${this.file}.${randomBytes(4).toString('hex')}.tmp`
      await writeFile(tmp, JSON.stringify(payload, null, 2), 'utf8')
      await rename(tmp, this.file)
    } catch (error) {
      this.log(`[cmdgo] 调用计量写入失败（不影响本次会话）：${error instanceof Error ? error.message : String(error)}`)
    }
  }
}
