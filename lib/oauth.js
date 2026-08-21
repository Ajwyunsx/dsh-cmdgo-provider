/**
 * Command Code OAuth login: extract the `cmd login` authorization flow into a
 * reusable host-side service.
 *
 * The official CLI signs in by opening `https://commandcode.ai/studio/auth/cli`
 * with a local callback address plus a CSRF `state`; after the user approves in
 * the browser, the Studio page POSTs the freshly minted API key back to that
 * local endpoint. This module reproduces exactly that handshake:
 *
 * 1. Bind a temporary HTTP server on `127.0.0.1` (ports 5959..5968).
 * 2. Build the 登录地址 `…/studio/auth/cli?callback=…&state=…`.
 * 3. Accept `POST /callback` (CORS for the Studio origin) carrying
 *    `{ apiKey, state, userId, userName, keyName }`, or an `?error=` redirect.
 * 4. Verify `state`, hand the key to the caller (the plugin stores it in the
 *    credential store), and shut the server down.
 *
 * Reference implementations: the `cmd` CLI and cmdcode2api's `--oauth` helper.
 *
 * @module cmdgo/oauth
 */
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
/** Default Studio origin that renders the CLI authorization page. */
export const DEFAULT_STUDIO_BASE = 'https://commandcode.ai';
/** First local callback port; the CLI's own convention. */
const PORT_START = 5959;
/** How many consecutive ports to try when 5959 is taken. */
const PORT_RANGE = 10;
/** Give the user ten minutes to finish the browser round-trip. */
export const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
function optionalString(value) {
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}
/**
 * One-shot OAuth listener. `start()` resolves with the 登录地址 once the local
 * server is bound; the promise returned by `waitForCallback()` settles when
 * the browser round-trip completes, fails, or times out.
 */
export class CommandCodeLoginManager {
    log;
    server;
    expectedState;
    currentAuthUrl;
    currentCallbackUrl;
    startedAt = 0;
    timer;
    lastResult = { status: 'idle' };
    pending;
    constructor(log = () => { }) {
        this.log = log;
    }
    /** The latest status snapshot for UI polling; never carries the API key. */
    get status() {
        if (this.server !== undefined && this.currentAuthUrl !== undefined) {
            return { status: 'waiting', authUrl: this.currentAuthUrl, callbackUrl: this.currentCallbackUrl, startedAt: this.startedAt };
        }
        return this.lastResult;
    }
    /** Whether a callback listener is currently bound and waiting. */
    isWaiting() {
        return this.server !== undefined && this.pending !== undefined;
    }
    /** The live 登录地址 while waiting, else the one from the last attempt. */
    get authUrl() {
        return this.currentAuthUrl;
    }
    /**
     * Bind the callback server and build the authorization URL. Idempotent:
     * while a login is already waiting the existing URL is returned unchanged.
     */
    async start(options = {}) {
        if (this.isWaiting() && this.currentAuthUrl !== undefined) {
            return { authUrl: this.currentAuthUrl, callbackUrl: this.currentCallbackUrl };
        }
        await this.stop('new login requested');
        const studioBase = (options.studioBase ?? DEFAULT_STUDIO_BASE).replace(/\/+$/, '');
        const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
        const { server, port } = await this.bind();
        this.server = server;
        this.expectedState = randomBytes(32).toString('base64url');
        this.startedAt = Date.now();
        // Keep the host explicit: Studio treats loopback callbacks specially, so
        // advertise the same localhost spelling the CLI uses.
        const callbackUrl = `http://localhost:${port}/callback`;
        const authUrl = `${studioBase}/studio/auth/cli?callback=${encodeURIComponent(callbackUrl)}&state=${encodeURIComponent(this.expectedState)}`;
        this.currentCallbackUrl = callbackUrl;
        this.currentAuthUrl = authUrl;
        this.timer = setTimeout(() => {
            this.finish({ status: 'error', message: `OAuth 登录超时（${Math.round(timeoutMs / 60000)} 分钟）`, at: Date.now() });
        }, timeoutMs);
        this.timer.unref?.();
        this.log(`[cmdgo] 等待 Command Code 回调：${callbackUrl}`);
        return { authUrl, callbackUrl };
    }
    /**
     * Resolve with the login result. Callers should invoke this right after
     * `start()`; the promise stays pending until the flow ends.
     */
    waitForCallback() {
        // 前置条件只看监听器是否已绑定：pending 正是本次调用注册的，
        // 用 isWaiting() 判断会永远拒绝。
        if (this.server === undefined)
            return Promise.reject(new Error('login not started'));
        return new Promise((resolve, reject) => {
            this.pending = { resolve, reject };
        });
    }
    /** Cancel any waiting login and release the port. Always safe to call. */
    async stop(reason = 'cancelled') {
        if (this.timer !== undefined) {
            clearTimeout(this.timer);
            this.timer = undefined;
        }
        this.failPending(new Error(`登录已取消：${reason}`));
        this.expectedState = undefined;
        const server = this.server;
        this.server = undefined;
        if (server === undefined)
            return;
        await new Promise((resolve) => {
            server.close(() => resolve());
        });
    }
    /** Abort the wait with an error (without necessarily tearing the server down). */
    failPending(error) {
        const pending = this.pending;
        this.pending = undefined;
        if (pending !== undefined)
            pending.reject(error);
    }
    /** Settle the whole flow: record the outcome and tear everything down. */
    finish(result, info) {
        if (this.timer !== undefined) {
            clearTimeout(this.timer);
            this.timer = undefined;
        }
        this.lastResult = result;
        const pending = this.pending;
        this.pending = undefined;
        const server = this.server;
        this.server = undefined;
        this.expectedState = undefined;
        if (server !== undefined)
            server.close(() => { });
        if (pending === undefined)
            return;
        if (info !== undefined && result.status === 'success')
            pending.resolve(info);
        else
            pending.reject(new Error(result.status === 'error' ? result.message : 'login failed'));
    }
    /** Bind 127.0.0.1 on the first free port of the CLI's conventional range. */
    bind() {
        return new Promise((resolve, reject) => {
            const attempt = (port) => {
                if (port >= PORT_START + PORT_RANGE) {
                    reject(new Error(`无法启动回调服务器：端口 ${PORT_START}..${PORT_START + PORT_RANGE - 1} 均被占用`));
                    return;
                }
                const server = createServer((req, res) => this.handle(req, res));
                server.on('error', () => attempt(port + 1));
                server.listen(port, '127.0.0.1', () => resolve({ server, port }));
            };
            attempt(PORT_START);
        });
    }
    handle(req, res) {
        // Studio 页面从浏览器发跨站 POST，必须放开它自己的来源。
        res.setHeader('Access-Control-Allow-Origin', DEFAULT_STUDIO_BASE);
        res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
        res.setHeader('Access-Control-Allow-Private-Network', 'true');
        const url = new URL(req.url ?? '/', 'http://localhost');
        if (url.pathname !== '/callback') {
            res.statusCode = 404;
            res.end(JSON.stringify({ success: false, error: 'not found' }));
            return;
        }
        if (req.method === 'OPTIONS') {
            res.statusCode = 204;
            res.end();
            return;
        }
        // Authorization errors arrive as a redirect back with ?error=<reason>.
        const errorParam = url.searchParams.get('error');
        if (errorParam !== null && errorParam.length > 0) {
            this.reply(res, 200, { success: true });
            this.finish({ status: 'error', message: `授权被取消或失败：${errorParam}`, at: Date.now() });
            return;
        }
        if (req.method !== 'POST') {
            // A plain GET on the callback path means the user visited it manually;
            // answer with a friendly hint instead of a confusing method error.
            this.reply(res, 405, { success: false, error: 'method not allowed; awaiting POST from commandcode.ai' });
            return;
        }
        const chunks = [];
        let size = 0;
        req.on('data', (chunk) => {
            size += chunk.length;
            if (size <= 64 * 1024)
                chunks.push(chunk);
        });
        req.on('end', () => {
            let payload;
            try {
                payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            }
            catch {
                this.reply(res, 400, { success: false, error: 'invalid JSON' });
                return;
            }
            const apiKey = optionalString(payload.apiKey);
            const state = optionalString(payload.state);
            if (apiKey === undefined || state === undefined) {
                this.reply(res, 400, { success: false, error: '缺少 apiKey 或 state' });
                return;
            }
            if (this.expectedState === undefined || state !== this.expectedState) {
                this.reply(res, 400, { success: false, error: 'state 不匹配' });
                this.finish({ status: 'error', message: 'state token 不匹配，回调可能被篡改', at: Date.now() });
                return;
            }
            this.reply(res, 200, { success: true });
            const info = {
                apiKey,
                userId: optionalString(payload.userId),
                userName: optionalString(payload.userName),
                keyName: optionalString(payload.keyName),
            };
            this.log(`[cmdgo] 授权成功：user=${info.userName ?? '?'} key=${info.keyName ?? '?'}`);
            this.finish({ status: 'success', userName: info.userName, keyName: info.keyName, at: Date.now() }, info);
        });
        req.on('error', () => this.failPending(new Error('读取回调请求失败')));
    }
    reply(res, statusCode, body) {
        res.statusCode = statusCode;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(body));
    }
}
