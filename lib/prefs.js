/**
 * 用户偏好：模型可见性 + 会话头部 HUD 开关。
 *
 * 与 `pool.ts` / `meter.ts` 同构：状态落在 `~/.dsh/cmdgo-prefs.json`，
 * 使用 `homedir()` 而不是 `DSH_HOME`（与那两个文件保持一致，便于一起备份）。
 *
 * 模型可见性是**黑名单制**：只有被显式关闭的模型才出现在 `hidden` 里，
 * 不在表里即为可见。这样上游新增模型会自动出现，用户不用手工放行；
 * 反复开关也不会让文件无限膨胀（打开 = 删键，而不是写 `false`）。
 *
 * @module cmdgo/prefs
 */
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';
/** 保守解析：任何意外形状都退回默认值，绝不让坏文件拖垮启动。 */
function parsePrefs(raw) {
    const parsed = JSON.parse(raw);
    const record = (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed))
        ? parsed
        : {};
    const hiddenModels = Array.isArray(record.hiddenModels)
        ? record.hiddenModels.filter((id) => typeof id === 'string' && id.length > 0)
        : [];
    return {
        hiddenModels,
        // 缺省为显示：只有显式写 false 才隐藏（老文件没有这个键 → 保持可见）。
        hudEnabled: record.hudEnabled !== false,
    };
}
/**
 * 模型可见性与 HUD 开关的内存权威副本 + 落盘。
 *
 * 读取走 `ensureLoaded()`，写入立即更新内存再异步落盘（失败只记日志，
 * 不回滚内存 —— 与账号池同样的取舍：用户的这次点击本轮就该生效）。
 */
export class CmdgoPrefs {
    file;
    log;
    hidden = new Set();
    hud = true;
    loaded = false;
    /** 进行中的加载；并发调用共享同一个 promise，避免读到半载文件。 */
    loading;
    constructor(
    /** 落盘路径；缺省 `~/.dsh/cmdgo-prefs.json`。 */
    file = join(homedir(), '.dsh', 'cmdgo-prefs.json'), log = () => { }) {
        this.file = file;
        this.log = log;
    }
    async ensureLoaded() {
        if (this.loaded)
            return;
        if (this.loading !== undefined)
            return this.loading;
        this.loading = (async () => {
            try {
                const parsed = parsePrefs(await readFile(this.file, 'utf8'));
                this.hidden = new Set(parsed.hiddenModels);
                this.hud = parsed.hudEnabled;
            }
            catch (_missingOrCorrupt) {
                // 文件不存在或损坏：用默认值（全部可见 + HUD 开）。
                this.hidden = new Set();
                this.hud = true;
            }
            this.loaded = true;
            this.loading = undefined;
        })();
        return this.loading;
    }
    async persist() {
        const payload = {
            version: 1,
            hiddenModels: [...this.hidden].sort(),
            hudEnabled: this.hud,
        };
        const text = JSON.stringify(payload, null, 2);
        try {
            await mkdir(dirname(this.file), { recursive: true });
            // 先写临时文件再 rename：读到半个文件比读不到更糟（会丢掉整份偏好）。
            const tmp = `${this.file}.${randomBytes(4).toString('hex')}.tmp`;
            await writeFile(tmp, text, 'utf8');
            await rename(tmp, this.file);
        }
        catch (error) {
            this.log(`[cmdgo] 偏好写入失败（不影响本次会话）：${error instanceof Error ? error.message : String(error)}`);
        }
    }
    /** 同步视图：已加载后可直接读，供每次 `listModels()` 使用。 */
    get hiddenIds() {
        return this.hidden;
    }
    get hudEnabled() {
        return this.hud;
    }
    /** 某个模型当前是否可见。 */
    isVisible(modelId) {
        return !this.hidden.has(modelId);
    }
    /** 关闭（true）或打开（false）一个模型；语义与 codearts 的黑名单一致。 */
    async setModelHidden(modelId, hidden) {
        await this.ensureLoaded();
        const changed = hidden ? !this.hidden.has(modelId) : this.hidden.has(modelId);
        if (!changed)
            return;
        if (hidden)
            this.hidden.add(modelId);
        else
            this.hidden.delete(modelId);
        await this.persist();
    }
    /**
     * 批量关闭（「全关」）。只对当前目录**确实存在**的 id 生效，
     * 且与已有条目合并 —— 单独关过的模型不会因为一次「全关」而丢失。
     */
    async hideMany(modelIds) {
        await this.ensureLoaded();
        if (modelIds.length === 0)
            return;
        let changed = false;
        for (const id of modelIds) {
            if (this.hidden.has(id))
                continue;
            this.hidden.add(id);
            changed = true;
        }
        if (changed)
            await this.persist();
    }
    /**
     * 清空整个黑名单（「全开」）。
     *
     * ⚠️ 刻意**不看当前目录**：直接清空所有键 —— 与 codearts 的 `clearDisabledModels`
     * 同一取舍。「曾被关闭、后来从服务端目录下线」的遗留键按目录清是永远清不掉的。
     */
    async clearHidden() {
        await this.ensureLoaded();
        if (this.hidden.size === 0)
            return;
        this.hidden = new Set();
        await this.persist();
    }
    /** HUD 胶囊显示开关。 */
    async setHudEnabled(enabled) {
        await this.ensureLoaded();
        if (this.hud === enabled)
            return;
        this.hud = enabled;
        await this.persist();
    }
    /** 客户端可见的快照（不含任何凭据）。 */
    snapshot() {
        return { hiddenModels: [...this.hidden].sort(), hudEnabled: this.hud };
    }
}
