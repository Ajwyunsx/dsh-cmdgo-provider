/**
 * dsh-cmdgo-provider/client — 「CommandCode Go」反代控制台。
 *
 * 注册 settings.section 插槽。视觉：纯白 × 纯黑 + glitch——黑色 hero 区
 * （故障字标题、扫描线、链路状态）+ 白色简洁操作区（登录 / 凭据 / 模型），
 * 只保留反代功能本身的信息，无任何无关装饰性内容。
 *
 * 数据面不变：GET /api/cmdgo/status 轮询；POST /api/cmdgo/login|cancel|logout。
 */
window.__ModuleLoader__.load({
  id: 'dsh-cmdgo-provider',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    const React = require('react');

    /* ---------------- 样式（keyframes 必须走 <style>，注入一次、热更即覆盖） ---------------- */

    const STYLE_ID = 'cmdgo-console-style';
    const CSS = `
.cmdgo{max-width:780px;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;color:#0a0a0c}
.cmdgo *,.cmdgo *::before,.cmdgo *::after{box-sizing:border-box}

/* ---- hero：纯黑 ---- */
.cmdgo-hero{position:relative;overflow:hidden;background:#0a0a0c;color:#fff;padding:26px 24px 20px;border:1px solid #0a0a0c;border-bottom:none}
.cmdgo-hero::after{content:'';position:absolute;inset:0;pointer-events:none;background:repeating-linear-gradient(0deg,rgba(255,255,255,.04) 0 1px,transparent 1px 3px)}
.cmdgo-title{position:relative;margin:0;font-family:ui-monospace,'SF Mono','JetBrains Mono',Menlo,Consolas,monospace;font-size:27px;font-weight:700;letter-spacing:.1em;line-height:1;white-space:nowrap}
.cmdgo-title::before,.cmdgo-title::after{content:attr(data-text);position:absolute;left:0;top:0;width:100%;overflow:hidden;opacity:.9;pointer-events:none}
.cmdgo-title::before{color:#ff2e63;animation:cmdgoGlitchA 3.2s infinite steps(1)}
.cmdgo-title::after{color:#21d4fd;animation:cmdgoGlitchB 2.7s .5s infinite steps(1)}
.cmdgo:hover .cmdgo-title::before{animation-duration:1.7s}
.cmdgo:hover .cmdgo-title::after{animation-duration:1.4s}
@keyframes cmdgoGlitchA{0%,86%,100%{clip-path:inset(0 0 100% 0);transform:none}87%{clip-path:inset(6% 0 62% 0);transform:translate(-3px,-1px)}90%{clip-path:inset(44% 0 36% 0);transform:translate(3px,1px)}93%{clip-path:inset(74% 0 6% 0);transform:translate(-2px,0)}96%{clip-path:inset(0 0 100% 0)}}
@keyframes cmdgoGlitchB{0%,88%,100%{clip-path:inset(0 0 100% 0);transform:none}89%{clip-path:inset(58% 0 22% 0);transform:translate(3px,1px)}92%{clip-path:inset(12% 0 76% 0);transform:translate(-3px,-1px)}95%{clip-path:inset(38% 0 48% 0);transform:translate(2px,0)}98%{clip-path:inset(0 0 100% 0)}}
.cmdgo-sub{margin:10px 0 0;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:10.5px;letter-spacing:.34em;color:rgba(255,255,255,.42)}
.cmdgo-link{display:flex;align-items:center;gap:8px;margin-top:16px;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12.5px}
.cmdgo-dot{width:7px;height:7px;flex:none;border-radius:50%}
.cmdgo-dot.on{background:#2bd576;box-shadow:0 0 8px rgba(43,213,118,.8)}
.cmdgo.dot-wait .cmdgo-dot.wait{background:#f5b52e;box-shadow:0 0 8px rgba(245,181,46,.8)}
.cmdgo-dot.off{background:rgba(255,255,255,.28)}
.cmdgo-link-meta{margin-left:auto;color:rgba(255,255,255,.38);font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:60%}
.cmdgo-cursor{color:#fff;animation:cmdgoBlink 1.1s steps(2) infinite;margin-left:2px}
@keyframes cmdgoBlink{50%{opacity:0}}

/* ---- body：纯白 ---- */
.cmdgo-body{background:#fff;border:1px solid #0a0a0c;padding:20px 24px 22px}
.cmdgo-label{font-size:10px;font-weight:700;letter-spacing:.22em;color:#8a8a93;text-transform:uppercase;margin-bottom:12px}
.cmdgo-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.cmdgo-btn{appearance:none;border-radius:0;border:1px solid #0a0a0c;background:#fff;color:#0a0a0c;font-size:12.5px;font-weight:600;padding:7px 14px;cursor:pointer;font-family:inherit;transition:none}
.cmdgo-btn:hover:not(:disabled){background:#0a0a0c;color:#fff}
.cmdgo-btn:disabled{opacity:.45;cursor:not-allowed}
.cmdgo-btn-primary{background:#0a0a0c;color:#fff}
.cmdgo-btn-primary:hover:not(:disabled){background:#26262b}
.cmdgo-btn-danger{border-color:#d92d20;color:#d92d20;background:#fff}
.cmdgo-btn-danger:hover:not(:disabled){background:#d92d20;color:#fff}
.cmdgo-url{flex:1;min-width:220px;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11.5px;padding:7px 10px;border:1px solid #0a0a0c;border-radius:0;background:#fff;color:#0a0a0c;outline:none;text-overflow:ellipsis}
.cmdgo-status{margin-top:12px;font-size:12.5px;line-height:1.6;display:flex;align-items:baseline;gap:6px}
.cmdgo-status .m{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px}
.cmdgo-ok{color:#12805c}.cmdgo-wait{color:#b45309}.cmdgo-err{color:#d92d20}.cmdgo-idle{color:#8a8a93}
.cmdgo-blink{animation:cmdgoBlink 1s steps(2) infinite}
.cmdgo-div{border:none;border-top:1px dashed #d9d9de;margin:18px 0}
.cmdgo-badge{display:inline-block;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:10.5px;font-weight:700;letter-spacing:.08em;padding:3px 9px;border:1px solid #0a0a0c}
.cmdgo-badge.on{background:#0a0a0c;color:#fff}
.cmdgo-badge.off{background:#fff;color:#8a8a93;border-color:#c9c9cf}
.cmdgo-mono{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11.5px;color:#55555c;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cmdgo-num{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:22px;font-weight:700;line-height:1}
.cmdgo-hint{font-size:12px;color:#8a8a93}
.cmdgo-acct{display:block;padding:10px 0;border-bottom:1px dashed #ececf0}
.cmdgo-acct:last-child{border-bottom:none}
.cmdgo-acct-top{display:flex;align-items:center;gap:10px}
.cmdgo-acct-main{min-width:0;flex:1}
.cmdgo-acct-name{font-family:ui-monospace,'SF Mono',Menlo,Consolas,monospace;font-size:12px;color:#0a0a0c;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cmdgo-acct-sub{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:10.5px;color:#8a8a93;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-top:2px}
.cmdgo-btn-sm{padding:4px 10px;font-size:11px}
.cmdgo-cool{color:#b45309;font-size:11px;font-family:ui-monospace,Menlo,Consolas,monospace;flex:none}
.cmdgo-skel{height:12px;background:linear-gradient(90deg,#f1f1f4,#e6e6ea,#f1f1f4);background-size:200% 100%;animation:cmdgoShimmer 1.4s linear infinite}
@keyframes cmdgoShimmer{to{background-position:-200% 0}}

/* ---- 额度：5 小时 / 周 / 月 ---- */
.cmdgo-quota{margin:8px 0 2px 17px;border-left:2px solid #ececf0;padding-left:10px}
.cmdgo-quota-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:6px}
.cmdgo-plan{display:inline-block;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:10px;font-weight:700;letter-spacing:.1em;padding:2px 7px;background:#0a0a0c;color:#fff}
.cmdgo-plan.muted{background:#fff;color:#8a8a93;border:1px solid #c9c9cf}
.cmdgo-quota-time{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:10px;color:#a0a0a8}
.cmdgo-quota-time.stale{color:#b45309}
.cmdgo-quota-warn{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:10px;color:#d92d20;cursor:help}
.cmdgo-quota-refresh{margin-left:auto;appearance:none;border:none;background:none;color:#55555c;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:10.5px;cursor:pointer;padding:0;text-decoration:underline}
.cmdgo-quota-refresh:disabled{opacity:.45;cursor:not-allowed}
.cmdgo-q{display:grid;gap:5px}
.cmdgo-qrow{display:flex;align-items:center;gap:8px;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:10.5px;color:#55555c}
.cmdgo-qtag{flex:none;width:34px;font-weight:700;letter-spacing:.06em;color:#0a0a0c}
.cmdgo-qbar{position:relative;flex:1 1 90px;min-width:50px;height:7px;background:#f1f1f4;border:1px solid #d9d9de;overflow:hidden}
.cmdgo-qbar.na{background:repeating-linear-gradient(45deg,#f7f7f9 0 4px,#ececf0 4px 8px)}
.cmdgo-qfill{position:absolute;top:0;bottom:0;left:0;background:#0a0a0c;transition:width .3s ease}
.cmdgo-qfill.warn{background:#b45309}
.cmdgo-qfill.crit{background:#d92d20}
.cmdgo-qpct{flex:none;width:46px;text-align:right;color:#0a0a0c;font-weight:700}
.cmdgo-qval{flex:none;width:104px;text-align:right;color:#55555c}
.cmdgo-qreset{flex:none;width:92px;text-align:right;color:#8a8a93}
.cmdgo-qextra{margin-top:5px;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:10px;color:#8a8a93}
.cmdgo-qnote{margin-top:5px;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:10px;color:#8a8a93}
@media (max-width:620px){
  .cmdgo-qval{display:none}
  .cmdgo-qreset{width:70px}
}
@media (prefers-reduced-motion:reduce){.cmdgo *{animation:none!important}}
`;

    function ensureStyle() {
      if (typeof document === 'undefined') return;
      let el = document.getElementById(STYLE_ID);
      if (!el) {
        el = document.createElement('style');
        el.id = STYLE_ID;
        document.head.appendChild(el);
      }
      el.textContent = CSS;
    }

    /* ---------------- 右上角额度 HUD 的样式 ----------------
     * 设置页的 .cmdgo-* 规则只在打开设置页时才注入，因此 HUD 自己也要
     * ensureStyle()（幂等，写入同一份常量）。这里全部走 --dsw-alias-* 主题
     * 变量并带浅色兜底，深浅色主题下都能用。
     */

    const HUD_STYLE_ID = 'cmdgo-hud-style';
    const HUD_CSS = `
.cmdgo-hud-pill{display:inline-flex;align-items:center;gap:6px;height:26px;padding:0 9px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.3));background:transparent;color:var(--dsw-alias-label-secondary,rgba(127,127,127,1));font:inherit;font-size:11.5px;font-weight:600;line-height:1;cursor:pointer;white-space:nowrap;max-width:340px}
.cmdgo-hud-pill:hover,.cmdgo-hud-pill.on{background:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.1));color:var(--dsw-alias-label-primary,inherit)}
.cmdgo-hud-dot{width:7px;height:7px;flex:none;border-radius:50%;background:var(--dsw-alias-state-success-primary,#2e9e5b)}
.cmdgo-hud-dot.warn{background:var(--dsw-alias-state-warn-primary,#d99a1f)}
.cmdgo-hud-dot.crit{background:var(--dsw-alias-state-error-primary,#d64545)}
.cmdgo-hud-tag{flex:none;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:10px;color:var(--dsw-alias-label-secondary,rgba(127,127,127,1));letter-spacing:.04em}
.cmdgo-hud-num{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11.5px}
/* 浮层面板：帧级 fixed，避开 header 的溢出与层叠上下文 */
.cmdgo-hud{pointer-events:auto;position:fixed;top:56px;right:16px;z-index:2147483000;width:392px;max-width:calc(100vw - 32px);max-height:min(72vh,640px);overflow:auto;padding:12px 14px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.35));border-radius:12px;background:var(--dsw-alias-bg-overlay,#fff);color:var(--dsw-alias-label-primary,#0a0a0c);box-shadow:0 14px 38px rgba(0,0,0,.22);font-size:14px}
.cmdgo-hud *{box-sizing:border-box}
.cmdgo-hud-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:8px}
.cmdgo-hud-title{margin:0;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11.5px;font-weight:700;letter-spacing:.1em}
.cmdgo-hud-actions{margin-left:auto;display:flex;align-items:center;gap:12px}
.cmdgo-hud-link{appearance:none;border:none;background:none;color:var(--dsw-alias-label-secondary,#55555c);font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11px;cursor:pointer;padding:0;text-decoration:underline}
.cmdgo-hud-link:hover:not(:disabled){color:var(--dsw-alias-label-primary,inherit)}
.cmdgo-hud-link:disabled{opacity:.45;cursor:not-allowed}
.cmdgo-hud-add{appearance:none;display:inline-flex;align-items:center;gap:6px;border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.35));background:transparent;color:var(--dsw-alias-label-primary,inherit);font-family:inherit;font-size:11.5px;font-weight:600;padding:4px 10px;border-radius:7px;cursor:pointer;margin:2px 0 6px}
.cmdgo-hud-add:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.1))}
.cmdgo-hud-add:disabled{opacity:.45;cursor:not-allowed}
.cmdgo-hud-acct{padding:8px 0;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.18))}
.cmdgo-hud-acct:last-of-type{border-bottom:none}
.cmdgo-hud-acct-top{display:flex;align-items:center;gap:8px}
.cmdgo-hud-name{flex:1;min-width:0;font-family:ui-monospace,'SF Mono',Menlo,Consolas,monospace;font-size:11.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cmdgo-hud-empty{padding:6px 0;font-size:12px;color:var(--dsw-alias-label-secondary,#8a8a93);line-height:1.6}
/* 合计 / 理论调用次数 */
.cmdgo-hud-sum{display:grid;gap:4px;margin-bottom:8px;padding:8px 10px;border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.22));border-radius:8px;background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.06))}
.cmdgo-hud-sumrow{display:flex;align-items:baseline;gap:8px;font-size:11.5px;line-height:1.5}
.cmdgo-hud-sumk{flex:none;width:62px;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:10px;font-weight:700;letter-spacing:.08em;color:var(--dsw-alias-label-secondary,#8a8a93)}
.cmdgo-hud-sumv{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11px;color:var(--dsw-alias-label-primary,#0a0a0c)}
.cmdgo-hud-hint{margin:8px 0 0;font-size:11px;line-height:1.6;color:var(--dsw-alias-label-secondary,#8a8a93)}
.cmdgo-hud-authurl{display:flex;align-items:center;gap:6px;margin:4px 0 6px}
.cmdgo-hud-authurl input{flex:1;min-width:0;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:10.5px;padding:5px 7px;border-radius:6px;border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.3));background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.08));color:inherit;outline:none;text-overflow:ellipsis}
/* 复用设置页的额度行，但把列宽收窄到浮层宽度，并把硬编码的浅色改成主题色 */
.cmdgo-hud .cmdgo-quota{margin:6px 0 0;padding-left:9px;border-left:2px solid var(--dsw-alias-border-l1,rgba(128,128,128,.25))}
.cmdgo-hud .cmdgo-quota-head{gap:7px;margin-bottom:6px}
.cmdgo-hud .cmdgo-quota-refresh{color:var(--dsw-alias-label-secondary,#55555c)}
.cmdgo-hud .cmdgo-quota-time{color:var(--dsw-alias-label-secondary,#8a8a93)}
.cmdgo-hud .cmdgo-qrow{color:var(--dsw-alias-label-secondary,#55555c)}
.cmdgo-hud .cmdgo-qtag{color:var(--dsw-alias-label-primary,#0a0a0c)}
.cmdgo-hud .cmdgo-qpct{color:var(--dsw-alias-label-primary,#0a0a0c)}
.cmdgo-hud .cmdgo-qbar{background:var(--dsw-alias-bg-layer-2,#f1f1f4);border-color:var(--dsw-alias-border-l1,#d9d9de)}
.cmdgo-hud .cmdgo-qbar.na{background:repeating-linear-gradient(45deg,var(--dsw-alias-bg-layer-2,#f7f7f9) 0 4px,transparent 4px 8px)}
.cmdgo-hud .cmdgo-qfill{background:var(--dsw-alias-label-primary,#0a0a0c)}
.cmdgo-hud .cmdgo-qfill.warn{background:var(--dsw-alias-state-warn-primary,#b45309)}
.cmdgo-hud .cmdgo-qfill.crit{background:var(--dsw-alias-state-error-primary,#d92d20)}
.cmdgo-hud .cmdgo-plan{background:var(--dsw-alias-label-primary,#0a0a0c);color:var(--dsw-alias-bg-base,#fff)}
.cmdgo-hud .cmdgo-plan.muted{background:transparent;color:var(--dsw-alias-label-secondary,#8a8a93)}
.cmdgo-hud .cmdgo-qval{display:none}
.cmdgo-hud .cmdgo-qreset{width:78px}
.cmdgo-hud .cmdgo-qextra,.cmdgo-hud .cmdgo-qnote,.cmdgo-hud .cmdgo-hint{color:var(--dsw-alias-label-secondary,#8a8a93)}
@media (prefers-reduced-motion:reduce){.cmdgo-hud *{animation:none!important}}
`;

    function ensureHudStyle() {
      if (typeof document === 'undefined') return;
      // 复用设置页的 .cmdgo-* 规则（HUD 内嵌 QuotaBlock）。
      ensureStyle();
      let el = document.getElementById(HUD_STYLE_ID);
      if (!el) {
        el = document.createElement('style');
        el.id = HUD_STYLE_ID;
        document.head.appendChild(el);
      }
      el.textContent = HUD_CSS;
    }

    /* ---------------- API（与宿主路由对齐，容错保持原样） ---------------- */

    async function api(path, method, payload) {
      let res;
      try {
        res = await fetch('/api/cmdgo' + path, {
          method: method || 'GET',
          headers: { 'Content-Type': 'application/json' },
          body: method === 'POST' ? JSON.stringify(payload || {}) : undefined,
        });
      } catch (e) {
        throw new Error('无法连接宿主：' + (e && e.message ? e.message : e));
      }
      // 宿主可能返回纯文本（如网关 404 "not found"）——不能直接 res.json()。
      const text = await res.text();
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch (e) { data = null; }
      if (!res.ok) {
        const detail = data && data.error ? data.error : (text || '').trim() || ('HTTP ' + res.status);
        if (res.status === 404) throw new Error('后端路由不存在（404）——插件宿主未加载或刚更新，请刷新页面/重启 harness 后重试');
        throw new Error('请求失败（' + res.status + '）：' + detail);
      }
      if (!data) throw new Error('宿主返回了非 JSON 响应：' + (text || '').slice(0, 80));
      return data;
    }

    function fmtTime(ms) {
      try { return new Date(ms).toLocaleString(); } catch (e) { return ''; }
    }

    /* ---------------- 额度格式化 ---------------- */

    /** 额度是美元计价的 credit。 */
    function fmtMoney(n) {
      if (typeof n !== 'number' || !isFinite(n)) return '—';
      return '$' + (n >= 100 ? n.toFixed(0) : n.toFixed(2));
    }

    function fmtPct(p) {
      if (typeof p !== 'number' || !isFinite(p)) return '—';
      const v = p * 100;
      return (v > 0 && v < 1 ? v.toFixed(2) : v.toFixed(1)) + '%';
    }

    /** 滚动窗口的重置倒计时，例如「4h21m 后重置」。 */
    function fmtCountdown(resetAt, now) {
      if (typeof resetAt !== 'number') return '';
      const ms = resetAt - now;
      if (ms <= 0) return '即将重置';
      const mins = Math.floor(ms / 60000);
      const d = Math.floor(mins / 1440);
      const h = Math.floor((mins % 1440) / 60);
      const m = mins % 60;
      if (d > 0) return d + 'd' + (h > 0 ? h + 'h' : '') + ' 后重置';
      if (h > 0) return h + 'h' + (m > 0 ? m + 'm' : '') + ' 后重置';
      return Math.max(1, m) + 'm 后重置';
    }

    /** 月度额度按账单日展示：滚动窗口看倒计时，月度看日期更直观。 */
    function fmtDay(ms) {
      if (typeof ms !== 'number') return '';
      try {
        const d = new Date(ms);
        return (d.getMonth() + 1) + '-' + d.getDate() + ' 重置';
      } catch (e) { return ''; }
    }

    function fmtAge(ts, now) {
      if (typeof ts !== 'number' || ts <= 0) return '';
      const secs = Math.max(0, Math.round((now - ts) / 1000));
      if (secs < 60) return secs + 's 前更新';
      const mins = Math.round(secs / 60);
      if (mins < 60) return mins + 'm 前更新';
      return Math.round(mins / 60) + 'h 前更新';
    }

    /** 一条额度：标签 + 进度条 + 百分比 + 已用/上限 + 重置时间。 */
    function QuotaRow(props) {
      const raw = props.percent;
      const pct = typeof raw === 'number' && isFinite(raw) ? Math.max(0, Math.min(1, raw)) : null;
      const cls = pct === null ? '' : (pct >= 0.9 ? 'crit' : (pct >= 0.7 ? 'warn' : ''));
      const width = pct === null || pct <= 0 ? 0 : Math.max(pct * 100, 1.5);
      return H('div', { className: 'cmdgo-qrow', title: props.title || undefined },
        H('span', { className: 'cmdgo-qtag' }, props.tag),
        H('span', { className: 'cmdgo-qbar' + (pct === null ? ' na' : '') },
          width > 0 ? H('span', { className: 'cmdgo-qfill ' + cls, style: { width: width + '%' } }) : null),
        H('span', { className: 'cmdgo-qpct' }, fmtPct(pct === null ? undefined : pct)),
        H('span', { className: 'cmdgo-qval' }, props.value || ''),
        H('span', { className: 'cmdgo-qreset' }, props.reset || ''),
      );
    }

    /** 一个账号的额度块：套餐徽标 + 5 小时 / 周 / 月三条额度 + 额外额度。 */
    function QuotaBlock(props) {
      const { usage, now, busy, onRefresh } = props;
      if (!usage) {
        return H('div', { className: 'cmdgo-quota' },
          H('div', { className: 'cmdgo-qrow' },
            H('span', { className: 'cmdgo-qtag' }, '···'),
            H('span', { className: 'cmdgo-hint' }, '正在读取额度…')));
      }
      if (!usage.ok) {
        return H('div', { className: 'cmdgo-quota' },
          H('div', { className: 'cmdgo-quota-head' },
            H('span', { className: 'cmdgo-plan muted' }, '额度不可用'),
            H('span', { className: 'cmdgo-quota-warn', title: usage.error || '' },
              String(usage.error || '').slice(0, 48)),
            H('button', { className: 'cmdgo-quota-refresh', disabled: busy, onClick: () => onRefresh() },
              busy ? '刷新中…' : '重试')));
      }
      const plan = usage.plan || {};
      const monthly = usage.monthly || {};
      const extra = typeof monthly.extra === 'number' ? monthly.extra : 0;
      const monthlyValue = (typeof monthly.total === 'number' && typeof monthly.used === 'number')
        ? fmtMoney(monthly.used) + ' / ' + fmtMoney(monthly.total)
        : '剩余 ' + fmtMoney(monthly.remaining);
      return H('div', { className: 'cmdgo-quota' },
        H('div', { className: 'cmdgo-quota-head' },
          H('span', { className: 'cmdgo-plan' }, plan.name || 'Command Code'),
          plan.status ? H('span', { className: 'cmdgo-quota-time' }, plan.status) : null,
          H('span', { className: 'cmdgo-quota-time' + (usage.stale ? ' stale' : '') },
            fmtAge(usage.fetchedAt, now) + (usage.stale ? ' · 待刷新' : '')),
          usage.warning ? H('span', { className: 'cmdgo-quota-warn', title: usage.warning }, '⚠ 上次刷新失败') : null,
          H('button', { className: 'cmdgo-quota-refresh', disabled: busy, onClick: () => onRefresh() },
            busy ? '刷新中…' : '刷新额度'),
        ),
        H('div', { className: 'cmdgo-q' },
          usage.fiveHour ? H(QuotaRow, {
            tag: '5H',
            percent: usage.fiveHour.percent,
            value: fmtMoney(usage.fiveHour.used) + ' / ' + fmtMoney(usage.fiveHour.cap),
            reset: fmtCountdown(usage.fiveHour.resetAt, now),
            title: '5 小时滚动窗口 · 剩余 ' + fmtMoney(usage.fiveHour.remaining),
          }) : null,
          usage.weekly ? H(QuotaRow, {
            tag: '周',
            percent: usage.weekly.percent,
            value: fmtMoney(usage.weekly.used) + ' / ' + fmtMoney(usage.weekly.cap),
            reset: fmtCountdown(usage.weekly.resetAt, now),
            title: '每周滚动窗口 · 剩余 ' + fmtMoney(usage.weekly.remaining),
          }) : null,
          usage.monthly ? H(QuotaRow, {
            tag: '月',
            percent: monthly.percent,
            value: monthlyValue,
            reset: fmtDay(plan.currentPeriodEnd),
            title: '月度额度 · 剩余 ' + fmtMoney(monthly.remaining),
          }) : null,
        ),
        extra > 0
          ? H('div', { className: 'cmdgo-qextra' }, '额外额度（不受滚动窗口限制）：' + fmtMoney(extra))
          : null,
        usage.limited === false
          ? H('div', { className: 'cmdgo-qnote' }, '该账号当前不受滚动窗口限制')
          : null,
      );
    }

    function AccountRow(props) {
      const { acct, busy, usageBusy, now, onToggle, onRemove, onRefreshUsage } = props;
      const cooling = acct.enabled && acct.cooling;
      const dotCls = !acct.enabled ? 'off' : (cooling ? 'wait cmdgo-blink' : 'on');
      const label = !acct.enabled ? 'DISABLED' : (cooling ? 'COOLDOWN' : 'READY');
      const name = [acct.userName, acct.keyName].filter(Boolean).join(' · ') || acct.id;
      // 合成行（池为空时的主 ref）没有可管理的池记录，只展示额度。
      const synthetic = acct.synthetic === true;
      return H('div', { className: 'cmdgo-acct' },
        H('div', { className: 'cmdgo-acct-top' },
          H('span', { className: 'cmdgo-dot ' + dotCls }),
          H('div', { className: 'cmdgo-acct-main' },
            H('div', { className: 'cmdgo-acct-name' }, name),
            H('div', { className: 'cmdgo-acct-sub' },
              acct.id + ' · ' + label + (acct.failCount > 0 ? ' · fail\u00d7' + acct.failCount : '')
              + (acct.lastError ? ' · ' + acct.lastError : '')),
          ),
          cooling ? H('span', { className: 'cmdgo-cool' }, '\u51b7\u5374\u4e2d') : null,
          synthetic ? null : H('button', { className: 'cmdgo-btn cmdgo-btn-sm', disabled: busy,
            onClick: () => onToggle(acct.id, !acct.enabled) }, acct.enabled ? '\u505c\u7528' : '\u542f\u7528'),
          synthetic ? null : H('button', { className: 'cmdgo-btn cmdgo-btn-sm cmdgo-btn-danger', disabled: busy,
            onClick: () => onRemove(acct.id) }, '\u79fb\u9664'),
        ),
        H(QuotaBlock, {
          usage: acct.usage,
          now,
          busy: usageBusy,
          onRefresh: () => onRefreshUsage(acct.id),
        }),
      );
    }

    /* ---------------- 视图 ---------------- */

    const H = React.createElement;

    function GlitchTitle(props) {
      return H('h2', { className: 'cmdgo-title', 'data-text': props.text }, props.text);
    }

    function Console() {
      ensureStyle();
      const [snap, setSnap] = React.useState(null);
      const [busy, setBusy] = React.useState(false);
      const [err, setErr] = React.useState('');
      const [copied, setCopied] = React.useState(false);
      const [acctBusy, setAcctBusy] = React.useState('');
      const [usageBusy, setUsageBusy] = React.useState('');

      const refresh = React.useCallback(async () => {
        try {
          const data = await api('/status');
          if (data && data.ok) { setSnap(data); setErr(''); }
        } catch (e) { /* host 暂不可达，下轮再试 */ }
      }, []);

      React.useEffect(() => {
        let alive = true;
        const tick = () => { if (alive) refresh(); };
        tick();
        const timer = setInterval(tick, 2500);
        return () => { alive = false; clearInterval(timer); };
      }, [refresh]);

      const login = snap ? snap.login : { status: 'idle' };
      const authUrl = login.status === 'waiting' ? login.authUrl : '';
      const poolCount = snap ? snap.accounts.length : 0;
      const linked = !!(snap && (snap.credentialConfigured || poolCount > 0));

      const startLogin = async () => {
        setBusy(true); setErr(''); setCopied(false);
        try {
          const data = await api('/login', 'POST');
          if (!data.ok) throw new Error(data.error || '启动登录失败');
          await refresh();
        } catch (e) { setErr(String(e.message || e)); }
        setBusy(false);
      };
      const cancelLogin = async () => {
        setBusy(true);
        try { await api('/cancel', 'POST'); await refresh(); } catch (e) {}
        setBusy(false);
      };
      const logout = async () => {
        setBusy(true);
        try { await api('/logout', 'POST'); await refresh(); } catch (e) {}
        setBusy(false);
      };
      const toggleAccount = async (id, enabled) => {
        setAcctBusy(id);
        try { await api('/account/toggle', 'POST', { id, enabled }); await refresh(); }
        catch (e) { setErr(String(e.message || e)); }
        setAcctBusy('');
      };
      const removeAccount = async (id) => {
        const tip = '移除账号 ' + id + '？其 API key 将一并删除。';
        if (typeof window.confirm === 'function' && !window.confirm(tip)) return;
        setAcctBusy(id);
        try { await api('/account/remove', 'POST', { id }); await refresh(); }
        catch (e) { setErr(String(e.message || e)); }
        setAcctBusy('');
      };
      // 手动刷新额度：'' = 刷新全部账号（宿主按账号 id 定位）。
      const refreshUsageNow = async (id) => {
        setUsageBusy(id || '*');
        try { await api('/usage/refresh', 'POST', id ? { id } : {}); await refresh(); }
        catch (e) { setErr(String(e.message || e)); }
        setUsageBusy('');
      };
      const openUrl = () => { if (authUrl) window.open(authUrl, '_blank', 'noopener'); };
      const copyUrl = async () => {
        if (!authUrl) return;
        try { await navigator.clipboard.writeText(authUrl); setCopied(true); setTimeout(() => setCopied(false), 1500); }
        catch (e) { /* 剪贴板不可用时用户可手动选中复制 */ }
      };

      /* --- hero 状态 --- */
      const linkState = linked
        ? { cls: 'on', label: 'LINK ACTIVE' }
        : (login.status === 'waiting'
          ? { cls: 'wait', label: 'HANDSHAKE' }
          : { cls: 'off', label: 'NO KEY' });
      const meta = snap
        ? ['api.commandcode.ai',
          'keys ' + snap.activeAccounts + '/' + poolCount,
          'models ' + snap.modelCount,
          String(snap.credentialRef)].join('  ·  ')
        : 'booting';

      /* --- 登录状态行 --- */
      const statusNode = (() => {
        if (login.status === 'waiting') {
          return H('div', { className: 'cmdgo-status cmdgo-wait' },
            H('span', { className: 'm cmdgo-blink' }, '▌'),
            H('span', null, '等待 Command Code 回调…… 在浏览器完成授权后自动变为已登录。'));
        }
        if (login.status === 'success') {
          const who = [login.userName, login.keyName].filter(Boolean).join(' · ');
          return H('div', { className: 'cmdgo-status cmdgo-ok' },
            H('span', { className: 'm' }, '✓'),
            H('span', null, '授权成功' + (who ? '：' + who : '') + '（' + fmtTime(login.at) + '）'));
        }
        if (login.status === 'error') {
          return H('div', { className: 'cmdgo-status cmdgo-err' },
            H('span', { className: 'm' }, '✗'), H('span', null, login.message));
        }
        return H('div', { className: 'cmdgo-status cmdgo-idle' },
          H('span', { className: 'm' }, '>'), H('span', null, '尚未发起登录。'));
      })();

      return H('div', { className: 'cmdgo' },
        // ---- 黑：hero ----
        H('section', { className: 'cmdgo-hero' + (login.status === 'waiting' ? ' dot-wait' : '') },
          H(GlitchTitle, { text: 'COMMAND CODE GO' }),
          H('p', { className: 'cmdgo-sub' }, 'REVERSE PROXY // POST /ALPHA/GENERATE'),
          H('div', { className: 'cmdgo-link' },
            H('span', { className: 'cmdgo-dot ' + linkState.cls }),
            H('span', null, linkState.label),
            H('span', { className: 'cmdgo-cursor' }, '▮'),
            H('span', { className: 'cmdgo-link-meta', title: meta }, meta)),
        ),
        // ---- 白：操作区 ----
        H('section', { className: 'cmdgo-body' },
          !snap ? H('div', { style: { display: 'grid', gap: 10 } },
            H('div', { className: 'cmdgo-skel', style: { width: '42%' } }),
            H('div', { className: 'cmdgo-skel', style: { width: '78%' } }),
            H('div', { className: 'cmdgo-skel', style: { width: '60%' } }),
          ) : H(React.Fragment, null,
            H('div', { className: 'cmdgo-label' }, 'AUTH // 授权登录'),
            H('div', { className: 'cmdgo-row' },
              !authUrl
                ? H('button', { className: 'cmdgo-btn cmdgo-btn-primary', disabled: busy, onClick: startLogin },
                  busy ? '···' : '▸ 发起登录')
                : null,
              authUrl ? H('input', {
                className: 'cmdgo-url', readOnly: true, value: authUrl,
                onFocus: (e) => e.target.select(),
              }) : null,
              authUrl ? H('button', { className: 'cmdgo-btn', onClick: copyUrl }, copied ? '已复制 ✓' : '复制') : null,
              authUrl ? H('button', { className: 'cmdgo-btn cmdgo-btn-primary', onClick: openUrl }, '打开登录页 ↗') : null,
              authUrl ? H('button', { className: 'cmdgo-btn', disabled: busy, onClick: cancelLogin }, '取消') : null,
            ),
            statusNode,
            err ? H('div', { className: 'cmdgo-status cmdgo-err' }, H('span', { className: 'm' }, '!'), H('span', null, err)) : null,
            H('hr', { className: 'cmdgo-div' }),
            H('div', { className: 'cmdgo-label' }, 'CREDENTIAL // 凭据'),
            H('div', { className: 'cmdgo-row' },
              H('span', { className: 'cmdgo-badge ' + (linked ? 'on' : 'off') },
                linked ? 'CONFIGURED' : 'NOT SET'),
              H('span', { className: 'cmdgo-mono', title: snap.credentialRef }, snap.credentialRef),
              snap.credentialSource ? H('span', { className: 'cmdgo-mono' }, '(' + snap.credentialSource + ')') : null,
              (linked && snap.credentialSource !== 'env') || poolCount > 0
                ? H('button', { className: 'cmdgo-btn cmdgo-btn-danger', disabled: busy, onClick: logout }, '清空账号池')
                : null,
            ),
            H('hr', { className: 'cmdgo-div' }),
            H('div', { className: 'cmdgo-quota-head', style: { marginBottom: 12 } },
              H('div', { className: 'cmdgo-label', style: { marginBottom: 0 } },
                'ACCOUNTS // 账号池 · ' + snap.activeAccounts + '/' + poolCount + ' 可用'),
              poolCount > 0
                ? H('button', {
                  className: 'cmdgo-quota-refresh',
                  disabled: usageBusy !== '',
                  onClick: () => refreshUsageNow(''),
                }, usageBusy === '*' ? '刷新中…' : '刷新全部额度')
                : null,
            ),
            poolCount === 0
              ? H('div', { className: 'cmdgo-hint' },
                '暂无账号 —— 每完成一次登录自动入池，多账号轮询摊薄额度；请求失败自动冷却并故障转移。')
              : H('div', null, snap.accounts.map((acct) => H(AccountRow, {
                key: acct.id,
                acct,
                now: Date.now(),
                busy: acctBusy === acct.id,
                usageBusy: usageBusy === acct.id,
                onToggle: toggleAccount,
                onRemove: removeAccount,
                onRefreshUsage: refreshUsageNow,
              }))),
            H('hr', { className: 'cmdgo-div' }),
            H('div', { className: 'cmdgo-label' }, 'MODELS // 模型目录'),
            H('div', { className: 'cmdgo-row' },
              H('span', { className: 'cmdgo-num' }, String(snap.modelCount)),
              H('span', { className: 'cmdgo-hint' }, snap.modelCount === 0
                ? '暂无模型 —— 正在重试拉取目录'
                : '个 Go 套餐可用模型已同步 —— Models 页选择 Command Code Go 供应商'),
            ),
            snap.catalogError
              ? H('div', { className: 'cmdgo-status cmdgo-err' },
                H('span', { className: 'm' }, '!'),
                H('span', null, '目录同步失败：' + String(snap.catalogError).slice(0, 160)),
              )
              : null,
          )),
      );
    }

    /* ---------------- 右上角额度 HUD ----------------
     * 两个槽协作：小胶囊挂在会话头部工具区（跟着 header 排版，不遮挡任何内置
     * 按钮），弹出的面板挂在 shell.overlay（帧级浮层，不会被 header 的溢出或
     * 层叠上下文裁掉）。两者共享同一份开关与快照，只有面板负责轮询。
     */

    const hudStore = {
      open: false,
      snap: null,
      err: '',
      busy: '',
      loginBusy: false,
      listeners: new Set(),
      set(patch) {
        Object.assign(this, patch);
        this.listeners.forEach((fn) => {
          try { fn(); } catch (e) { /* 单个订阅者出错不影响其它 */ }
        });
      },
      subscribe(fn) { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; },
    };

    /** 订阅共享快照：面板轮询写入，胶囊与面板都靠它重绘。 */
    function useHud() {
      const [, force] = React.useState(0);
      React.useEffect(() => hudStore.subscribe(() => force((v) => v + 1)), []);
      return hudStore;
    }

    /** 跨账号、跨 5H/周/月找已用占比最高的一条 —— 最先卡住的那条额度。 */
    function hudTightest(accounts) {
      let best = null;
      for (let i = 0; i < accounts.length; i++) {
        const acct = accounts[i];
        const usage = acct.usage;
        if (!usage || usage.ok !== true) continue;
        const windows = [['5H', usage.fiveHour], ['周', usage.weekly], ['月', usage.monthly]];
        for (let w = 0; w < windows.length; w++) {
          const tag = windows[w][0];
          const win = windows[w][1];
          if (!win || typeof win.percent !== 'number' || !isFinite(win.percent)) continue;
          if (best === null || win.percent > best.percent) best = { percent: win.percent, tag: tag, acct: acct };
        }
      }
      return best;
    }

    /** 全部账号的额度合计（只统计拿到成功快照的账号）。 */
    function hudTotals(accounts) {
      const sum = { monthly: 0, fiveHour: 0, weekly: 0, extra: 0, counted: 0 };
      for (let i = 0; i < accounts.length; i++) {
        const usage = accounts[i].usage;
        if (!usage || usage.ok !== true) continue;
        sum.counted += 1;
        const monthly = usage.monthly || {};
        if (typeof monthly.remaining === 'number') sum.monthly += monthly.remaining;
        if (typeof monthly.extra === 'number') sum.extra += monthly.extra;
        if (usage.fiveHour && typeof usage.fiveHour.remaining === 'number') sum.fiveHour += usage.fiveHour.remaining;
        if (usage.weekly && typeof usage.weekly.remaining === 'number') sum.weekly += usage.weekly.remaining;
      }
      return sum;
    }

    /**
     * 理论剩余调用次数 = 剩余额度 ÷ 实测平均单次消耗。
     * 宿主样本不足（meter.ready !== true）时返回 undefined —— 宁可不显示，
     * 也不拿一个凭空假设的单价去编数字。
     */
    function hudCalls(credits, meter) {
      if (!meter || meter.ready !== true) return undefined;
      const perCall = meter.perCall;
      if (typeof perCall !== 'number' || !(perCall > 0)) return undefined;
      if (typeof credits !== 'number' || !(credits > 0)) return 0;
      return Math.floor(credits / perCall);
    }

    /** 胶囊里用的紧凑金额：$26.3 而不是 $26.30。 */
    function fmtMoneyShort(n) {
      if (typeof n !== 'number' || !isFinite(n)) return '—';
      if (n >= 100) return '$' + n.toFixed(0);
      if (n >= 10) return '$' + n.toFixed(1);
      return '$' + n.toFixed(2);
    }

    /** 胶囊：会话头部工具区里的紧凑入口（只读共享快照，自己不请求）。 */
    function QuotaHudPill() {
      ensureHudStyle();
      const hud = useHud();
      const accounts = hud.snap ? hud.snap.accounts : [];
      if (accounts.length === 0) return null;
      const meter = hud.snap ? hud.snap.meter : undefined;
      const totals = hudTotals(accounts);
      const calls = hudCalls(totals.monthly, meter);
      const tight = hudTightest(accounts);
      const usable = accounts.filter((a) => a.enabled && a.cooling !== true).length;
      const dot = usable === 0 ? 'crit' : (accounts.some((a) => a.cooling === true) ? 'warn' : '');
      const who = tight === null ? '' : ([tight.acct.userName, tight.acct.id].filter(Boolean)[0] || tight.acct.id);
      return H('button', {
        type: 'button',
        className: 'cmdgo-hud-pill' + (hud.open ? ' on' : ''),
        title: 'CommandCode Go：' + accounts.length + ' 个账号（' + usable + ' 可用）'
          + (tight === null ? '' : ' · 最紧 ' + tight.tag + ' ' + fmtPct(tight.percent) + '（' + who + '）')
          + ' · 合计剩余 ' + fmtMoney(totals.monthly) + '（5H ' + fmtMoney(totals.fiveHour)
          + ' / 周 ' + fmtMoney(totals.weekly) + '）'
          + (calls === undefined
            ? ' · 理论次数待样本'
            : ' · 理论调用次数 ≈ ' + calls + ' 次（实测 ' + fmtMoney(meter.perCall) + '/次）')
          + ' —— 点击查看每个账号的额度',
        onClick: (e) => { e.stopPropagation(); hudStore.set({ open: hudStore.open !== true }); },
      },
        H('span', { className: 'cmdgo-hud-dot ' + dot }),
        H('span', { className: 'cmdgo-hud-tag' }, 'CC'),
        H('span', { className: 'cmdgo-hud-num' }, tight === null ? '读取中' : tight.tag + ' ' + fmtPct(tight.percent)),
        H('span', { className: 'cmdgo-hud-num' }, 'Σ' + fmtMoneyShort(totals.monthly)),
        calls === undefined ? null : H('span', { className: 'cmdgo-hud-num' }, '≈' + calls + '次'),
        accounts.length > 1 ? H('span', { className: 'cmdgo-hud-tag' }, '\u00d7' + accounts.length) : null,
      );
    }

    /** 面板：shell.overlay 里的浮层，同时是 HUD 的轮询与操作宿主。 */
    function QuotaHudPanel() {
      ensureHudStyle();
      const hud = useHud();
      const panelRef = React.useRef(null);

      const refresh = React.useCallback(async () => {
        try {
          const data = await api('/status');
          if (data && data.ok) hudStore.set({ snap: data, err: '' });
        } catch (e) { /* 宿主暂不可达：保留上一份快照，下轮再试 */ }
      }, []);

      React.useEffect(() => {
        let alive = true;
        const tick = () => { if (alive) refresh(); };
        tick();
        const timer = setInterval(tick, 15000);
        return () => { alive = false; clearInterval(timer); };
      }, [refresh]);

      // 打开时立刻拉一次最新快照；Esc 或点击面板外关闭（胶囊本身除外，
      // 否则 mousedown 先关、click 再开的顺序会让开关看起来卡住）。
      React.useEffect(() => {
        if (hud.open !== true) return undefined;
        void refresh();
        const onKey = (e) => { if (e.key === 'Escape') hudStore.set({ open: false }); };
        const onDown = (e) => {
          const el = panelRef.current;
          if (el && el.contains(e.target)) return;
          const target = e.target;
          if (target && typeof target.closest === 'function' && target.closest('.cmdgo-hud-pill')) return;
          hudStore.set({ open: false });
        };
        document.addEventListener('keydown', onKey);
        document.addEventListener('mousedown', onDown);
        return () => {
          document.removeEventListener('keydown', onKey);
          document.removeEventListener('mousedown', onDown);
        };
      }, [hud.open, refresh]);

      if (hud.open !== true || !hud.snap) return null;
      const snap = hud.snap;
      const accounts = snap.accounts || [];
      const login = snap.login || { status: 'idle' };
      const authUrl = login.status === 'waiting' ? login.authUrl : '';
      // 合计与「理论调用次数」：次数必须来自宿主实测的平均单次消耗，
      // 宿主还是旧版（无 meter）或样本不足时如实说明，不编数字。
      const meter = snap.meter;
      const totals = hudTotals(accounts);
      const callsMonthly = hudCalls(totals.monthly, meter);
      const callsFiveHour = hudCalls(totals.fiveHour, meter);
      const callsText = (() => {
        if (meter === undefined) return '需要宿主 0.8.0（重启 DSH 后可用）';
        if (meter.ready !== true || callsMonthly === undefined) {
          return '样本不足 —— 已计 ' + meter.totalCalls + ' 次调用 · ' + meter.samples
            + ' 个额度样本；继续用一段时间即可给出估算';
        }
        return '≈ ' + callsMonthly + ' 次（合计剩余 ÷ 实测 ' + fmtMoney(meter.perCall) + '/次'
          + (callsFiveHour === undefined ? '' : ' · 5H 窗口内 ≈ ' + callsFiveHour + ' 次')
          + ' · 样本 ' + meter.attributedCalls + ' 次调用）';
      })();

      const startLogin = async () => {
        hudStore.set({ loginBusy: true });
        try { await api('/login', 'POST'); await refresh(); }
        catch (e) { hudStore.set({ err: String(e && e.message ? e.message : e) }); }
        hudStore.set({ loginBusy: false });
      };
      const cancelLogin = async () => {
        hudStore.set({ loginBusy: true });
        try { await api('/cancel', 'POST', {}); await refresh(); } catch (e) { /* 已过期 */ }
        hudStore.set({ loginBusy: false });
      };
      const refreshUsage = async (id) => {
        hudStore.set({ busy: id || '*' });
        try { await api('/usage/refresh', 'POST', id ? { id: id } : {}); await refresh(); }
        catch (e) { hudStore.set({ err: String(e && e.message ? e.message : e) }); }
        hudStore.set({ busy: '' });
      };

      return H('div', { className: 'cmdgo-hud', ref: panelRef, role: 'dialog', 'aria-label': 'CommandCode Go 账号额度' },
        H('div', { className: 'cmdgo-hud-head' },
          H('span', { className: 'cmdgo-hud-title' }, 'COMMAND CODE GO // 账号额度'),
          H('span', { className: 'cmdgo-hud-tag' }, snap.activeAccounts + '/' + accounts.length + ' 可用'),
          H('div', { className: 'cmdgo-hud-actions' },
            accounts.length > 0
              ? H('button', { className: 'cmdgo-hud-link', disabled: hud.busy !== '', onClick: () => refreshUsage('') },
                hud.busy === '*' ? '刷新中…' : '刷新全部')
              : null,
            H('button', { className: 'cmdgo-hud-link', onClick: () => hudStore.set({ open: false }) }, '关闭'),
          ),
        ),
        H('div', { className: 'cmdgo-hud-sum' },
          H('div', { className: 'cmdgo-hud-sumrow' },
            H('span', { className: 'cmdgo-hud-sumk' }, '合计剩余'),
            H('span', { className: 'cmdgo-hud-sumv' },
              fmtMoney(totals.monthly) + '（月）· 5H ' + fmtMoney(totals.fiveHour)
              + ' · 周 ' + fmtMoney(totals.weekly)
              + (totals.extra > 0 ? ' · 含额外 ' + fmtMoney(totals.extra) : '')
              + ' · ' + totals.counted + '/' + accounts.length + ' 个账号有数据'),
          ),
          H('div', { className: 'cmdgo-hud-sumrow' },
            H('span', { className: 'cmdgo-hud-sumk' }, '理论次数'),
            H('span', { className: 'cmdgo-hud-sumv' }, callsText),
          ),
        ),
        hud.err ? H('div', { className: 'cmdgo-hud-empty' }, hud.err) : null,
        // 多账号：授权回调一到就自动入池，新账号的额度随下一次轮询出现。
        authUrl
          ? H('div', null,
            H('div', { className: 'cmdgo-hud-empty' }, '等待浏览器授权回调…… 完成后该账号自动入池。'),
            H('div', { className: 'cmdgo-hud-authurl' },
              H('input', { readOnly: true, value: authUrl, onFocus: (e) => e.target.select() }),
              H('button', { className: 'cmdgo-hud-link', onClick: () => window.open(authUrl, '_blank', 'noopener') }, '打开登录页 ↗'),
              H('button', { className: 'cmdgo-hud-link', disabled: hud.loginBusy, onClick: cancelLogin }, '取消'),
            ),
          )
          : H('button', { className: 'cmdgo-hud-add', disabled: hud.loginBusy, onClick: startLogin },
            hud.loginBusy ? '正在生成登录地址…' : '＋ 添加账号'),
        accounts.length === 0
          ? H('div', { className: 'cmdgo-hud-empty' }, '账号池为空 —— 每完成一次登录自动入池，多账号轮询摊薄额度。')
          : accounts.map((acct) => H('div', { className: 'cmdgo-hud-acct', key: acct.id },
            H('div', { className: 'cmdgo-hud-acct-top' },
              H('span', { className: 'cmdgo-hud-dot ' + (!acct.enabled ? 'crit' : (acct.cooling ? 'warn' : '')) }),
              H('span', { className: 'cmdgo-hud-name' },
                [acct.userName, acct.keyName].filter(Boolean).join(' · ') || acct.id),
              H('span', { className: 'cmdgo-hud-tag' },
                !acct.configured ? '缺凭据'
                  : (!acct.enabled ? '已停用'
                    : (acct.cooling ? '冷却中' : (acct.failCount > 0 ? 'fail\u00d7' + acct.failCount : acct.id)))),
            ),
            H(QuotaBlock, {
              usage: acct.usage,
              now: Date.now(),
              busy: hud.busy === acct.id,
              onRefresh: () => refreshUsage(acct.id),
            }),
          )),
        H('div', { className: 'cmdgo-hud-hint' },
          '账号池轮询摊薄额度；某账号失败自动冷却并故障转移到下一个。启停 / 移除账号在「设置 → CommandCode Go」。'),
      );
    }

    const inject = ['slots'];
    function apply(ctx) {
      const slots = ctx.get('slots');
      if (!slots) return;
      slots.inject('settings.section', () => slots.register({ name: 'settings.section', id: 'commandcode-go-login', order: 11, label: () => 'CommandCode Go' },
        (props) => React.createElement(Console, props)));
      // 右上角额度：胶囊进会话头部工具区（order 最大 → 最靠右），面板进帧级浮层。
      slots.inject('conversation.session.header.utilities', () => slots.register({
        name: 'conversation.session.header.utilities',
        id: 'commandcode-go-quota',
        order: 20,
        label: () => 'CommandCode Go 额度',
      }, (props) => React.createElement(QuotaHudPill, props)));
      slots.inject('shell.overlay', () => slots.register({
        name: 'shell.overlay',
        id: 'commandcode-go-quota-panel',
        order: 20,
        label: () => 'CommandCode Go 额度面板',
      }, (props) => React.createElement(QuotaHudPanel, props)));
    }

    exports.inject = inject;
    exports.apply = apply;
    return module.exports;
  },
});
