/**
 * dsh-cmdgo-provider/client — 设置页「CommandCode Go」登录面板。
 *
 * 注册 settings.section 插槽：专门的 CommandCode Go 登录选项页。
 * 第一个选项是「登录地址」（由 host 的 OAuth 服务生成 cmd login 同款
 * Studio 授权链接）；点击后在浏览器完成授权，host 本机回调服务器收到
 * Command Code POST 回传的 API Key，自动写入凭据存储——用户只需等待回调。
 */
window.__ModuleLoader__.load({
  id: 'dsh-cmdgo-provider',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    const React = require('react');

    const S = {
      page: { display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 720, padding: '4px 2px', fontSize: 14 },
      card: { border: '1px solid rgba(128,128,128,.25)', borderRadius: 12, padding: 16, display: 'flex', flexDirection: 'column', gap: 10 },
      title: { fontSize: 15, fontWeight: 600, margin: 0 },
      desc: { color: 'rgba(127,127,127,1)', fontSize: 12.5, lineHeight: 1.6, margin: 0 },
      row: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
      label: { fontWeight: 600, minWidth: 72 },
      btn: { border: '1px solid rgba(128,128,128,.35)', borderRadius: 8, padding: '6px 12px', cursor: 'pointer', background: 'transparent', fontSize: 13 },
      btnPrimary: { border: 'none', borderRadius: 8, padding: '6px 14px', cursor: 'pointer', fontSize: 13, color: '#fff', background: '#4f6ef7' },
      btnDanger: { border: '1px solid rgba(214,69,69,.5)', borderRadius: 8, padding: '5px 10px', cursor: 'pointer', fontSize: 12.5, color: '#d64545', background: 'transparent' },
      url: { flex: 1, minWidth: 260, fontFamily: 'ui-monospace,monospace', fontSize: 12, padding: '7px 9px', borderRadius: 8, border: '1px solid rgba(128,128,128,.3)', background: 'rgba(127,127,127,.08)', color: 'inherit', textOverflow: 'ellipsis' },
      statusWaiting: { color: '#d99a1f', fontSize: 13 },
      statusOk: { color: '#2e9e5b', fontSize: 13 },
      statusErr: { color: '#d64545', fontSize: 13 },
      statusIdle: { color: 'rgba(127,127,127,1)', fontSize: 13 },
      badge: { border: '1px solid rgba(128,128,128,.3)', borderRadius: 999, padding: '2px 9px', fontSize: 11.5 },
      mono: { fontFamily: 'ui-monospace,monospace', fontSize: 12 },
    };

    async function api(path, method) {
      let res;
      try {
        res = await fetch('/api/cmdgo' + path, {
          method: method || 'GET',
          headers: { 'Content-Type': 'application/json' },
          body: method === 'POST' ? '{}' : undefined,
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

    function LoginPanel() {
      const [snap, setSnap] = React.useState(null);
      const [busy, setBusy] = React.useState(false);
      const [err, setErr] = React.useState('');
      const [copied, setCopied] = React.useState(false);

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
      const openUrl = () => { if (authUrl) window.open(authUrl, '_blank', 'noopener'); };
      const copyUrl = async () => {
        if (!authUrl) return;
        try { await navigator.clipboard.writeText(authUrl); setCopied(true); setTimeout(() => setCopied(false), 1500); }
        catch (e) { /* 剪贴板不可用时用户可手动选中复制 */ }
      };

      const statusNode = (() => {
        if (login.status === 'waiting') {
          return React.createElement('div', { style: S.statusWaiting },
            '⏳ 等待 Command Code 回调中…… 在浏览器里完成授权后这里会自动变为已登录。');
        }
        if (login.status === 'success') {
          const who = [login.userName, login.keyName].filter(Boolean).join(' · ');
          return React.createElement('div', { style: S.statusOk },
            '✓ 授权成功', who ? '：' + who : '', '（' + fmtTime(login.at) + '）');
        }
        if (login.status === 'error') {
          return React.createElement('div', { style: S.statusErr }, '✗ ' + login.message);
        }
        return React.createElement('div', { style: S.statusIdle }, '尚未开始登录。');
      })();

      return React.createElement('div', { style: S.page },
        React.createElement('div', { style: S.card },
          React.createElement('h3', { style: S.title }, 'CommandCode Go 登录'),
          React.createElement('p', { style: S.desc },
            'Go 套餐不支持 Provider API，本插件通过 Command Code CLI 私有网关 ',
            React.createElement('span', { style: S.mono }, '/alpha/generate'),
            ' 调用模型。登录提取自官方 ', React.createElement('span', { style: S.mono }, 'cmd login'),
            ' 的 OAuth 流程：生成登录地址 → 浏览器授权 → 本机回调自动收取 API Key 并写入凭据。'),
        ),
        React.createElement('div', { style: S.card },
          React.createElement('div', { style: S.row },
            React.createElement('span', { style: S.label }, '登录地址'),
            !authUrl
              ? React.createElement('button', { style: S.btnPrimary, disabled: busy, onClick: startLogin }, busy ? '…' : '生成登录地址')
              : null,
          ),
          authUrl ? React.createElement('div', { style: S.row },
            React.createElement('input', { style: S.url, readOnly: true, value: authUrl, onFocus: (e) => e.target.select() }),
            React.createElement('button', { style: S.btn, onClick: copyUrl }, copied ? '已复制 ✓' : '复制'),
            React.createElement('button', { style: S.btnPrimary, onClick: openUrl }, '打开登录页'),
            React.createElement('button', { style: S.btn, disabled: busy, onClick: cancelLogin }, '取消'),
          ) : null,
          statusNode,
          err ? React.createElement('div', { style: S.statusErr }, err) : null,
        ),
        snap ? React.createElement('div', { style: S.card },
          React.createElement('div', { style: S.row },
            React.createElement('span', { style: S.label }, '凭据'),
            React.createElement('span', { style: S.badge }, snap.credentialConfigured
              ? '已配置' + (snap.credentialSource ? '（' + snap.credentialSource + '）' : '')
              : '未配置'),
            React.createElement('span', { style: S.mono }, snap.credentialRef),
            snap.credentialConfigured && snap.credentialSource !== 'env'
              ? React.createElement('button', { style: S.btnDanger, disabled: busy, onClick: logout }, '退出登录')
              : null,
          ),
          React.createElement('div', { style: S.row },
            React.createElement('span', { style: S.label }, '模型'),
            React.createElement('span', { style: S.statusIdle },
              '已同步 ' + snap.modelCount + ' 个 Go 套餐可用模型（Models 页选择 Command Code Go 供应商）。'),
          ),
        ) : null,
      );
    }

    const inject = ['slots'];
    function apply(ctx) {
      const slots = ctx.get('slots');
      if (!slots) return;
      slots.inject('settings.section', () => slots.register({ name: 'settings.section', id: 'commandcode-go-login', order: 11, label: () => 'CommandCode Go' },
        (props) => React.createElement(LoginPanel, props)));
    }

    exports.inject = inject;
    exports.apply = apply;
    return module.exports;
  },
});
