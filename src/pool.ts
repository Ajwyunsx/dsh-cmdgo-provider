/**
 * Multi-account credential pool for the Command Code Go reverse proxy.
 *
 * Each OAuth login yields one API key; pooling several keys multiplies the
 * plan quota. Keys live in the standard credential store under per-account
 * refs (the primary ref stays reserved for the pre-pool single key), while a
 * small JSON manifest beside `.credentials.yaml` keeps pool metadata — ids,
 * labels, enabled flags, failure cooldowns — across restarts.
 *
 * Scheduling: round-robin over enabled accounts whose cooldown has expired;
 * a failed request puts its account on an exponential cool-down (capped) and
 * the adapter fails over to the next pick within the same request.
 *
 * @module cmdgo/pool
 */

import { homedir } from 'node:os'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { randomBytes } from 'node:crypto'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'

/** One pooled account. The API key itself never appears here — only its ref. */
export interface PoolAccount {
  /** Stable short id (slug + random suffix); also names the credential ref. */
  id: string
  /** Credential store reference holding this account's key. */
  ref: CredentialRef
  userName?: string
  keyName?: string
  addedAt: number
  enabled: boolean
  /** Consecutive failed requests; reset on success. */
  failCount: number
  /** Epoch ms until which the scheduler skips this account. */
  cooldownUntil?: number
  lastError?: string
  lastUsedAt?: number
}

/**
 * 只需一个凭据引用即可解析 key：`keyOf` 不读账号的其它字段，
 * 因此未入池的主 ref（合成展示行）也能复用同一条解析路径。
 */
export interface CredentialHolder {
  ref: CredentialRef
}

interface Manifest {
  version: 1
  accounts: PoolAccount[]
}

/** First failure cools down for this long; doubles per consecutive failure. */
const COOLDOWN_BASE_MS = 30_000
/** Upper bound for the exponential cool-down. */
const COOLDOWN_MAX_MS = 15 * 60_000

function slug(value: string | undefined, fallback: string): string {
  const cleaned = (value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return cleaned.length > 0 ? cleaned.slice(0, 16) : fallback
}

export interface CredentialsSeam {
  resolve(ref: CredentialRef): Promise<{ value: string } | undefined>
  describe(ref: CredentialRef): Promise<{ configured: boolean; source?: string }>
  set(ref: CredentialRef, value: string): Promise<void>
  unset(ref: CredentialRef): Promise<void>
}

/**
 * The account pool. All mutations persist the manifest; all key material is
 * delegated to the credential store.
 */
export class AccountPool {
  private accounts: PoolAccount[] = []
  private loaded = false
  /** 进行中的加载；并发调用共享同一个 promise，避免读到半载的清单。 */
  private loading?: Promise<void>
  /** Round-robin cursor into the last usable ordering. */
  private cursor = 0

  constructor(
    /** Base/default credential ref (kept for the pre-pool single account). */
    private readonly baseRef: CredentialRef,
    private readonly log: (message: string) => void,
  ) {}

  private get file(): string {
    return join(homedir(), '.dsh', 'cmdgo-accounts.json')
  }

  private refFor(id: string): CredentialRef {
    return `${this.baseRef}_${id.toUpperCase().replace(/[^A-Z0-9]/g, '')}` as CredentialRef
  }

  /** Load the manifest once; corrupt files start over (keys stay in the store). */
  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return
    // 并发调用必须等同一个加载完成：原先「先置 loaded 再 await」会让
    // 第二个调用者看到空清单（冷启动首个 /status 报 0 个账号）。
    if (this.loading !== undefined) return this.loading
    this.loading = (async () => {
      try {
        const raw = await readFile(this.file, 'utf8')
        const parsed = JSON.parse(raw) as Partial<Manifest>
        if (Array.isArray(parsed.accounts)) {
          this.accounts = parsed.accounts.filter((a): a is PoolAccount =>
            typeof a?.id === 'string' && typeof a?.ref === 'string' && typeof a?.addedAt === 'number')
        }
      } catch (_missingOrCorrupt) {
        this.accounts = []
      }
      this.loaded = true
      this.loading = undefined
    })()
    return this.loading
  }

  private async persist(): Promise<void> {
    const path = this.file
    const payload = JSON.stringify({ version: 1, accounts: this.accounts } satisfies Manifest, null, 2)
    try {
      await mkdir(dirname(path), { recursive: true })
      const tmp = `${path}.${randomBytes(4).toString('hex')}.tmp`
      await writeFile(tmp, payload, 'utf8')
      await rename(tmp, path)
    } catch (error) {
      this.log(`[cmdgo] 账号清单写入失败（不影响本次会话）：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  async list(): Promise<PoolAccount[]> {
    await this.ensureLoaded()
    return [...this.accounts]
  }

  get size(): number {
    return this.accounts.length
  }

  /** Accounts the scheduler may use right now (enabled, cooldown expired). */
  activeCount(now = Date.now()): number {
    return this.accounts.filter(a => a.enabled && (a.cooldownUntil ?? 0) <= now).length
  }

  /**
   * Adopt the pre-pool single key as account #1 so upgrades are seamless.
   * Only fires when the manifest has no entries and the base ref holds a key.
   */
  async adoptLegacy(credentials: CredentialsSeam | undefined): Promise<void> {
    await this.ensureLoaded()
    if (this.accounts.length > 0 || credentials === undefined) return
    try {
      const info = await credentials.describe(this.baseRef)
      if (!info.configured) return
      // 主 ref 的 key 若已与某个入池账号相同（老用户重新登录过），收编只会造成重复。
      const legacyKey = await this.keyOf(credentials, { ref: this.baseRef })
      if (legacyKey !== undefined) {
        for (const account of this.accounts) {
          const held = await this.keyOf(credentials, account)
          if (held === legacyKey) return
        }
      }
      this.accounts.push({
        id: 'default',
        ref: this.baseRef,
        addedAt: Date.now(),
        enabled: true,
        failCount: 0,
      })
      await this.persist()
      this.log('[cmdgo] 已将既有凭据收编为账号池 #1（default）')
    } catch (_credentialsUnavailable) {
      /* 服务未就绪：下次登录时再收编 */
    }
  }

  /** Whether any stored account already holds exactly this key. */
  async findByKey(credentials: CredentialsSeam, apiKey: string): Promise<PoolAccount | undefined> {
    await this.ensureLoaded()
    for (const account of this.accounts) {
      try {
        const hit = await credentials.resolve(account.ref)
        if (hit !== undefined && hit.value === apiKey) return account
      } catch (_resolveFailure) { /* 下一个 */ }
    }
    return undefined
  }

  /** Store a fresh key as a new account; returns the created record. */
  async add(credentials: CredentialsSeam, info: { apiKey: string; userName?: string; keyName?: string }): Promise<PoolAccount> {
    await this.ensureLoaded()
    let id = slug(info.userName ?? info.keyName, 'acct')
    const taken = new Set(this.accounts.map(a => a.id))
    if (taken.has(id) || id === 'default') id = `${id}-${randomBytes(2).toString('hex')}`
    while (taken.has(id)) id = `${id}${randomBytes(1).toString('hex')}`
    const account: PoolAccount = {
      id,
      ref: this.refFor(id),
      ...(info.userName === undefined ? {} : { userName: info.userName }),
      ...(info.keyName === undefined ? {} : { keyName: info.keyName }),
      addedAt: Date.now(),
      enabled: true,
      failCount: 0,
    }
    await credentials.set(account.ref, info.apiKey)
    this.accounts.push(account)
    await this.persist()
    this.log(`[cmdgo] 账号入池：${id}（${info.userName ?? '?'} · ${info.keyName ?? '?'}），池大小 ${this.accounts.length}`)
    return account
  }

  /** Refresh label metadata when a re-login returns a known key. */
  touchMeta(account: PoolAccount, info: { userName?: string; keyName?: string }): void {
    if (info.userName !== undefined) account.userName = info.userName
    if (info.keyName !== undefined) account.keyName = info.keyName
    void this.persist()
  }

  /** Round-robin pick: enabled, cooled-down accounts first; all-cooling falls back to the least-cooled. */
  pick(now = Date.now()): PoolAccount | undefined {
    const usable = this.accounts.filter(a => a.enabled && (a.cooldownUntil ?? 0) <= now)
    if (usable.length > 0) {
      const picked = usable[this.cursor % usable.length]
      this.cursor = (this.cursor + 1) % usable.length
      picked.lastUsedAt = now
      return picked
    }
    const enabled = this.accounts.filter(a => a.enabled)
    if (enabled.length === 0) return undefined
    return enabled.reduce((soonest, a) =>
      ((a.cooldownUntil ?? 0) < (soonest.cooldownUntil ?? 0) ? a : soonest))
  }

  /** Resolve the API key of one account through the credential store. */
  async keyOf(credentials: CredentialsSeam, account: CredentialHolder): Promise<string | undefined> {
    try {
      const hit = await credentials.resolve(account.ref)
      return hit !== undefined && hit.value.length > 0 ? hit.value : undefined
    } catch (_resolveFailure) {
      return undefined
    }
  }

  /** Record a request failure: grow the cool-down exponentially. */
  reportFailure(account: PoolAccount, message: string, now = Date.now()): void {
    account.failCount += 1
    const ms = Math.min(COOLDOWN_MAX_MS, COOLDOWN_BASE_MS * 2 ** (account.failCount - 1))
    account.cooldownUntil = now + ms
    account.lastError = message.slice(0, 200)
    void this.persist()
    this.log(`[cmdgo] 账号 ${account.id} 请求失败（第 ${account.failCount} 次），冷却 ${Math.round(ms / 1000)}s：${account.lastError}`)
  }

  /** Record a healthy exchange: clear failure bookkeeping. */
  reportSuccess(account: PoolAccount): void {
    if (account.failCount === 0 && account.cooldownUntil === undefined && account.lastError === undefined) return
    account.failCount = 0
    account.cooldownUntil = undefined
    account.lastError = undefined
    void this.persist()
  }

  toggle(id: string, enabled: boolean): boolean {
    const account = this.accounts.find(a => a.id === id)
    if (account === undefined || account.enabled === enabled) return false
    account.enabled = enabled
    if (!enabled) account.cooldownUntil = undefined
    void this.persist()
    return true
  }

  /** Remove one account and delete its stored key (env-sourced keys are unaffected by unset). */
  async remove(credentials: CredentialsSeam | undefined, id: string): Promise<boolean> {
    await this.ensureLoaded()
    const index = this.accounts.findIndex(a => a.id === id)
    if (index < 0) return false
    const [gone] = this.accounts.splice(index, 1)
    if (credentials !== undefined) {
      try { await credentials.unset(gone.ref) } catch (_unsetFailure) { /* 键可能已被外部删除 */ }
    }
    if (this.cursor >= Math.max(1, this.accounts.length)) this.cursor = 0
    await this.persist()
    return true
  }

  /** Remove every pooled account (full wipe); the base ref key is preserved. */
  async clear(credentials: CredentialsSeam | undefined): Promise<number> {
    await this.ensureLoaded()
    const count = this.accounts.length
    for (const account of [...this.accounts]) {
      await this.remove(credentials, account.id)
    }
    return count
  }
}
