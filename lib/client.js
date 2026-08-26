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
.cmdgo-acct{display:flex;align-items:center;gap:10px;padding:9px 0;border-bottom:1px dashed #ececf0}
.cmdgo-acct:last-child{border-bottom:none}
.cmdgo-acct-main{min-width:0;flex:1}
.cmdgo-acct-name{font-family:ui-monospace,'SF Mono',Menlo,Consolas,monospace;font-size:12px;color:#0a0a0c;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cmdgo-acct-sub{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:10.5px;color:#8a8a93;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-top:2px}
.cmdgo-btn-sm{padding:4px 10px;font-size:11px}
.cmdgo-cool{color:#b45309;font-size:11px;font-family:ui-monospace,Menlo,Consolas,monospace;flex:none}
.cmdgo-skel{height:12px;background:linear-gradient(90deg,#f1f1f4,#e6e6ea,#f1f1f4);background-size:200% 100%;animation:cmdgoShimmer 1.4s linear infinite}
@keyframes cmdgoShimmer{to{background-position:-200% 0}}
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

    function AccountRow(props) {
      const { acct, busy, onToggle, onRemove } = props;
      const cooling = acct.enabled && acct.cooling;
      const dotCls = !acct.enabled ? 'off' : (cooling ? 'wait cmdgo-blink' : 'on');
      const label = !acct.enabled ? 'DISABLED' : (cooling ? 'COOLDOWN' : 'READY');
      const name = [acct.userName, acct.keyName].filter(Boolean).join(' · ') || acct.id;
      return H('div', { className: 'cmdgo-acct' },
        H('span', { className: 'cmdgo-dot ' + dotCls }),
        H('div', { className: 'cmdgo-acct-main' },
          H('div', { className: 'cmdgo-acct-name' }, name),
          H('div', { className: 'cmdgo-acct-sub' },
            acct.id + ' · ' + label + (acct.failCount > 0 ? ' · fail\u00d7' + acct.failCount : '')
            + (acct.lastError ? ' · ' + acct.lastError : '')),
        ),
        cooling ? H('span', { className: 'cmdgo-cool' }, '\u51b7\u5374\u4e2d') : null,
        H('button', { className: 'cmdgo-btn cmdgo-btn-sm', disabled: busy,
          onClick: () => onToggle(acct.id, !acct.enabled) }, acct.enabled ? '\u505c\u7528' : '\u542f\u7528'),
        H('button', { className: 'cmdgo-btn cmdgo-btn-sm cmdgo-btn-danger', disabled: busy,
          onClick: () => onRemove(acct.id) }, '\u79fb\u9664'),
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
            H('div', { className: 'cmdgo-label' },
              'ACCOUNTS // 账号池 · ' + snap.activeAccounts + '/' + poolCount + ' 可用'),
            poolCount === 0
              ? H('div', { className: 'cmdgo-hint' },
                '暂无账号 —— 每完成一次登录自动入池，多账号轮询摊薄额度；请求失败自动冷却并故障转移。')
              : H('div', null, snap.accounts.map((acct) => H(AccountRow, {
                key: acct.id,
                acct,
                busy: acctBusy === acct.id,
                onToggle: toggleAccount,
                onRemove: removeAccount,
              }))),
            H('hr', { className: 'cmdgo-div' }),
            H('div', { className: 'cmdgo-label' }, 'MODELS // 模型目录'),
            H('div', { className: 'cmdgo-row' },
              H('span', { className: 'cmdgo-num' }, String(snap.modelCount)),
              H('span', { className: 'cmdgo-hint' }, '个 Go 套餐可用模型已同步 —— Models 页选择 Command Code Go 供应商'),
            ),
          )),
      );
    }

    const inject = ['slots'];
    function apply(ctx) {
      const slots = ctx.get('slots');
      if (!slots) return;
      slots.inject('settings.section', () => slots.register({ name: 'settings.section', id: 'commandcode-go-login', order: 11, label: () => 'CommandCode Go' },
        (props) => React.createElement(Console, props)));
    }

    exports.inject = inject;
    exports.apply = apply;
    return module.exports;
  },
});
