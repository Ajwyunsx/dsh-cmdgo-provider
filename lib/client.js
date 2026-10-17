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
/* color-scheme:light 是**必需的**，不是可选项。
   宿主在 :root 上按主题设 color-scheme（深色主题下是 dark），它会继承到本分区里
   所有**原生控件**：<select> 的弹出菜单、<input type="search"> 的清除钮、滚动条。
   本分区是固定的纯白 × 纯黑配色，不跟着宿主翻转；不锚定的话在深色主题下会看到
   白卡片上弹出一块深色下拉菜单、滚动条也变成深灰 —— 与卡片配色直接冲突。
   这里显式声明 light，把原生控件钉在浅色渲染上。 */
.cmdgo{max-width:780px;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;color:#0a0a0c;color-scheme:light}
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
/* 剩余额度（美元）：紧贴百分比左侧 —— 百分比答"用了多少"，它答"还剩多少" */
.cmdgo-qrem{flex:none;width:58px;text-align:right;color:#12805c;font-weight:700}
.cmdgo-qval{flex:none;width:104px;text-align:right;color:#55555c}
.cmdgo-qreset{flex:none;width:92px;text-align:right;color:#8a8a93}
.cmdgo-qextra{margin-top:5px;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:10px;color:#8a8a93}
.cmdgo-qnote{margin-top:5px;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:10px;color:#8a8a93}
@media (max-width:620px){
  .cmdgo-qval{display:none}
  .cmdgo-qreset{width:70px}
}
@media (prefers-reduced-motion:reduce){.cmdgo *{animation:none!important}}
/* ---- 模型开关 + HUD 开关 ---- */
.cmdgo-switch-row{display:flex;align-items:center;gap:9px;padding:5px 8px;border-radius:6px;cursor:pointer;user-select:none}
.cmdgo-switch-row:hover{background:#f4f4f7}
/* 关闭的模型只变灰（不用删除线：线会压住等宽字体里的下划线与 monospace 字符，读起来费劲） */
.cmdgo-switch-row.off .cmdgo-switch-name{color:#9a9aa3}
.cmdgo-switch{flex:none;position:relative;width:30px;height:17px;border-radius:9px;background:#c9c9d1;transition:background .12s}
.cmdgo-switch.on{background:#12805c}
.cmdgo-switch::after{content:'';position:absolute;top:2px;left:2px;width:13px;height:13px;border-radius:50%;background:#fff;transition:transform .12s}
.cmdgo-switch.on::after{transform:translateX(13px)}
.cmdgo-switch-name{flex:1;min-width:0;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
/* 价格：胶囊统一外形 + 统一大小 + 以 / 和 缓存 为基点对齐。
 *
 * 做法是让胶囊内部成为一个 inline-grid，每列定宽：
 *
 *     [ in 6ch 右对齐 ][ / ][ out 6ch 左对齐 ][ · ][ 缓存 4ch ][ cache 7ch 右对齐 ]
 *                    ↑                                       ↑
 *                  / 钉死在这                            缓存 钉死在这
 *
 * 因为整块用等宽字体，ch 是精确的字符宽，所以「入」的右边缘、「/」、
 * 「出」的左边缘、以及「缓存」标签的左边缘在所有行上都在同一条竖线上。
 *
 * 列宽取自真实目录实测：入最大 $0.435（6）、出最大 $10.25（6）、
 * 缓存最大 $0.0036（7）。出列必须给满 6ch —— 给 5ch 时 $10.25 会溢出，
 * 把紧随其后的间隔号挤住（实测渲染确认过）。「缓存」是 2 个全角字 = 4ch。
 *
 * 统一大小靠 min-width：即使某行没有缓存段，胶囊也保持同样宽度，
 * 这样整列是一个整齐的矩形块，而不是长短不一的药丸。 */
.cmdgo-price{flex:none;text-align:right;white-space:nowrap}
.cmdgo-price-pill{
  display:inline-grid;
  grid-template-columns:6ch auto 6ch auto 4ch 7ch;
  align-items:baseline;
  padding:3px 8px;border-radius:5px;
  background:#e8e8ee;border:1px solid #dcdce4;color:#3f3f46;
  font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11px;line-height:1.35;
  /* 统一大小：宽度锁死，缺缓存段的行也不会缩窄。 */
  min-width:200px;box-sizing:border-box;
}
.cmdgo-price-in{text-align:right;font-weight:600}
.cmdgo-price-out{text-align:left;font-weight:600}
.cmdgo-price-slash{text-align:center;color:#b4b4be;font-weight:400}
.cmdgo-price-sep{text-align:center;color:#b4b4be;font-weight:400}
.cmdgo-price-label{text-align:left;color:#6e6e79;font-size:10px;font-weight:600}
.cmdgo-price-cache{text-align:right;color:#6e6e79;font-size:10px;font-weight:600}
/* 没有缓存段的行：占位不渲染内容，但列仍在网格里，宽度因此不变。 */
.cmdgo-price-cacheempty{color:transparent}
/* 关闭的模型：胶囊只比正常行淡一档，**仍要清楚可读且仍有形状**。
 * ⚠️ 不能压得太淡——用户可能把 50/51 个模型都关掉，那种情况下「比价」这件事
 * 恰恰发生在这些灰行上。状态已经由灰掉的模型名和开关位置表达够了。 */
.cmdgo-price-pill.off{background:#f5f5f8;border-color:#e6e6ec;color:#4a4a54}
.cmdgo-price-pill.off .cmdgo-price-label,
.cmdgo-price-pill.off .cmdgo-price-cache{color:#83838e}
.cmdgo-price-pill.off .cmdgo-price-slash,
.cmdgo-price-pill.off .cmdgo-price-sep{color:#c0c0ca}
@media (max-width:900px){.cmdgo-price{display:none}}
.cmdgo-models{max-height:260px;overflow:auto;margin:4px 0 2px;padding:2px;border:1px solid #e4e4ea;border-radius:7px;background:#fbfbfd}
/* 纵向滚动条：显式配色，别交给浏览器默认值。
   默认滚动条在 Windows 上是一条浅灰槽 + 深灰滑块，压在 #fbfbfd 的内凹面上显得脏；
   而且它会跟着宿主的 color-scheme 变（深色主题下变成深灰块）。
   取值对齐宿主自己的滚动条 token 的**浅色**档：
     --dsw-alias-scrollbar-bg-l2    → --dsw-static-neutral-200 = #e5e5e5
     --dsw-alias-scrollbar-hover-l2 → --dsw-static-neutral-300 = #d4d4d4
   写死字面量而不是引用变量：本分区是固定浅色配色，不跟宿主深浅色翻转
   （理由见 .cmdgo 的 color-scheme:light）。 */
.cmdgo-models::-webkit-scrollbar{width:10px;height:10px}
.cmdgo-models::-webkit-scrollbar-thumb{background:#e5e5e5;border-radius:5px;border:2px solid #fbfbfd}
.cmdgo-models::-webkit-scrollbar-thumb:hover{background:#d4d4d4}
.cmdgo-models::-webkit-scrollbar-track{background:transparent}
.cmdgo-models{scrollbar-width:thin;scrollbar-color:#e5e5e5 transparent}
/* 两行布局：说明文字独占一行，计数 + 批量按钮在第二行。
   原来是单行 flex，加了筛选后按钮文字变长（「关闭筛出的 12 个」），
   在 780px 下会把按钮挤成两行（「全部关 / 闭」）—— 按钮内的文字不该折行。 */
.cmdgo-models-head{display:flex;flex-direction:column;align-items:stretch;gap:7px;margin:10px 0 2px}
.cmdgo-models-head-row{display:flex;align-items:center;gap:8px}
.cmdgo-models-head .cmdgo-btn{white-space:nowrap;flex:none}
.cmdgo-models-count{margin-left:auto;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:10px;color:#8a8a93;white-space:nowrap}
/* ---- 模型搜索 + 厂家筛选 ---- */
.cmdgo-filter{display:flex;align-items:center;gap:8px;margin:6px 0 0}
.cmdgo-search{flex:1;min-width:0;position:relative;display:flex;align-items:center}
.cmdgo-search input{width:100%;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px;padding:6px 26px 6px 9px;border:1px solid #0a0a0c;border-radius:0;background:#fff;color:#0a0a0c;outline:none}
.cmdgo-search input::placeholder{color:#a0a0a8}
/* 清空按钮：只在有输入时渲染，所以不需要 :placeholder-shown 之类的技巧 */
.cmdgo-search-clear{position:absolute;right:1px;top:1px;bottom:1px;width:24px;appearance:none;border:none;background:none;color:#8a8a93;font-size:13px;line-height:1;cursor:pointer;padding:0}
.cmdgo-search-clear:hover{color:#0a0a0c}
/* 厂家下拉框：appearance:none 去掉原生外观，箭头自己画。
   ⚠️ 为什么不用原生外观：原生 <select> 的**下拉弹层由操作系统渲染**，CSS 只能控制
   闭合态的盒子，管不到那个弹层。宿主在深色主题下把 color-scheme 设成 dark 时，
   弹层会渲染成深色菜单（正是截图里那块压在白色卡片上的深色块）。
   .cmdgo 上的 color-scheme:light 能把它拉回浅色，但那是**继承**来的行为，
   一旦将来有哪段样式重新声明 color-scheme 就会再翻车；而且原生外观在不同平台上
   的箭头、内边距各不相同，与这套硬边描边的语言不搭。
   所以这里把外观整个接管，只保留原生控件的行为（键盘、无障碍、选项列表）。
   箭头的颜色与描边一致，不随主题变 —— 弹层则由 color-scheme:light 锚定成浅色。 */
.cmdgo-search select{appearance:none;-webkit-appearance:none;-moz-appearance:none;
  font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px;
  padding:6px 26px 6px 8px;border:1px solid #0a0a0c;border-radius:0;
  background-color:#fff;color:#0a0a0c;outline:none;cursor:pointer;
  background-image:url("data:image/svg+xml;charset=utf-8,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'%3E%3Cpath d='M1 1l4 4 4-4' fill='none' stroke='%230a0a0c' stroke-width='1.6'/%3E%3C/svg%3E");
  background-repeat:no-repeat;background-position:right 8px center}
.cmdgo-search select:hover{border-color:#26262b}
.cmdgo-search select:focus-visible{outline:2px solid #0a0a0c;outline-offset:1px}
/* 选项列表本身也钉死配色：某些平台（Windows Chromium）会沿用 color 计算
   弹层的背景，不显式写会在深色宿主下出现深底黑字。 */
.cmdgo-search select option{background-color:#fff;color:#0a0a0c}
/* 厂家快捷筛选：**单行横向滚动**，不换行。
   19 个厂家若换行会占 3 行、把模型列表挤到屏幕外，而筛选条本身不该是视觉主体。
   横向滚动保留了「一律平铺、一眼看全」的优点，又恒定只占一行高。
   滚动条做细化处理，避免在设置页里出现一条突兀的粗灰条。 */
.cmdgo-vendors{display:flex;flex-wrap:nowrap;gap:6px;margin:7px 0 2px;overflow-x:auto;overflow-y:hidden;padding-bottom:4px;scrollbar-width:thin;scrollbar-color:#e5e5e5 transparent}
/* 横向滚动条与模型列表用同一套浅色档（见 .cmdgo-models::-webkit-scrollbar 的说明）。
   原来这里是 #c9c9d1，比模型列表那条还深，两处并排时能看出色差。 */
.cmdgo-vendors::-webkit-scrollbar{height:8px}
.cmdgo-vendors::-webkit-scrollbar-thumb{background:#e5e5e5;border-radius:4px;border:2px solid transparent;background-clip:padding-box}
.cmdgo-vendors::-webkit-scrollbar-thumb:hover{background:#d4d4d4;background-clip:padding-box;border:2px solid transparent}
.cmdgo-vendors::-webkit-scrollbar-track{background:transparent}
.cmdgo-vchip{appearance:none;display:inline-flex;align-items:center;gap:5px;flex:none;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11px;padding:3px 8px;border:1px solid #d9d9de;border-radius:999px;background:#fff;color:#55555c;cursor:pointer;white-space:nowrap;transition:background .12s ease,border-color .12s ease,color .12s ease}
.cmdgo-vchip:hover{border-color:#0a0a0c;color:#0a0a0c}
/* 选中态：**反相填充**（深底白字），灰度选到「白字仍读得清」的最浅一档。
   逐版试过，每一步都有实测对比度支撑（WCAG AA 对 11px 正常字要求 ≥4.5）：

     v1  #0a0a0c 纯黑   白字 19.78 → 太硬，强度等于主按钮（"全黑不太好看"）
     v2  #f1f1f4 浅灰   底vs白底 1.13 → 根本看不出哪个被选中（等于没做选中态）
     v3  #3f3f46 深灰   白字 10.44 → 看得清了，但"尤其的灰"，仍偏重
     v4  #6e6e79 中灰   白字 5.04  → 明显更浅，且仍过 AA ← 当前

   边界：白字掉到 AA 以下的分界在 #7a7a85（4.24）。#75757f 是最后一个达标的
   （4.56），再浅就只能换深字（浅底 + ink 字），那会与未选中态（白底灰字）
   太接近，得不偿失。所以 #6e6e79 留了一点余量给不同显示器/背光。

   #6e6e79 是这套色阶里既有的「价格小标签」档，不是新造的颜色。
   为什么仍然坚持填充而不是"浅底 + 描边"：填充面积最大，余光就能扫到；
   v2 的教训是"淡到看不出来"比"略重"更糟 —— 牺牲的是一整个控件的可辨识性。
   与 hover 区分得开：hover 只改描边与文字，底仍是白。 */
.cmdgo-vchip.on{background:#6e6e79;border-color:#6e6e79;color:#fff}
.cmdgo-vchip.on:hover{background:#55555c;border-color:#55555c;color:#fff}
/* 选中态的计数：底色已是深色，计数不能再压暗（那会读不清），
   改用同族偏弱的白（opacity 作用在白字上），保证与标签同族但更轻。 */
.cmdgo-vchip-n{font-size:10px;opacity:.62}
.cmdgo-vchip.on .cmdgo-vchip-n{opacity:.72}
.cmdgo-models-empty{padding:14px 10px;text-align:center;font-size:12px;color:#8a8a93;font-family:ui-monospace,Menlo,Consolas,monospace}
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
.cmdgo-hud .cmdgo-qtag{width:30px}
.cmdgo-hud .cmdgo-qrem{width:56px;color:var(--dsw-alias-state-success-primary,#12805c)}
.cmdgo-hud .cmdgo-qpct{width:44px;color:var(--dsw-alias-label-primary,#0a0a0c)}
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
    /**
     * 价格数字：最多 4 位小数，去掉无意义的尾随 0。
     * `$0.003` 保持不变，`$0.1500` 收敛成 `$0.15`，`$5.00` 收敛成 `$5`。
     */
    function fmtRate(n) {
      if (typeof n !== 'number' || !isFinite(n)) return null;
      var s = n.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
      return '$' + s;
    }

    /**
     * 把 `/status` 里的 pricing 拆成对齐渲染所需的各个字段。
     *
     * 拆开而不是拼一个字符串，是因为渲染层要用**定宽的网格列**把三处钉在
     * 固定的 x 上（见下方 .cmdgo-price-pill 的 grid 定义）：
     *
     *   input / output —— 入、出两个数字。input 右对齐、output 左对齐，
     *                     于是 `/` 永远落在同一列上。
     *   cacheValue     —— 缓存读数字。`缓存` 标签左对齐在固定列首，
     *                     数字右对齐（列内 space-between 撑开）。
     *   full           —— 悬停 title 用的完整说明。
     *
     * 取真实目录量过：入最大 6 字符（$0.435）、出最大 6（$10.25）、
     * 缓存最大 7（$0.0036），所以列宽按 6ch / 7ch 定，不会挤爆。
     *
     * 没有 pricing 时返回 null —— 调用方据此整段不渲染（宁可不显示也不编 $0）。
     */
    function formatPricing(pricing) {
      if (!pricing || typeof pricing !== 'object') return null;
      var input = fmtRate(pricing.input);
      var output = fmtRate(pricing.output);
      if (input === null || output === null) return null;
      var cacheRead = fmtRate(pricing.cacheRead);
      var cacheWrite = fmtRate(pricing.cacheWrite);
      // 缓存读为 0 表示 catalog 未公布该列，不当作「免费缓存」展示。
      var showCache = cacheRead !== null && pricing.cacheRead > 0;
      var parts = ['\u8f93\u5165 ' + input, '\u8f93\u51fa ' + output];
      if (cacheRead !== null) parts.push('\u7f13\u5b58\u8bfb ' + cacheRead);
      if (cacheWrite !== null) parts.push('\u7f13\u5b58\u5199 ' + cacheWrite);
      return {
        input: input,
        output: output,
        cacheValue: showCache ? cacheRead : null,
        full: parts.join(' \u00b7 ') + ' / 1M token',
      };
    }

    /* ---------------- 模型目录：厂家归类与筛选 ----------------
     * 53 个模型逐个找太慢，所以按厂家分组 + 搜索。
     *
     * id 有两种形状，归类规则必须同时覆盖：
     *   1. `vendor/model`（多数）：取第一个 `/` 之前那段；
     *   2. `brand-N.N`（claude / gpt 没有前缀）：取第一个 `-` 之前那段。
     *
     * ⚠️ 别名必须归一：同一厂家在上游有多个前缀写法，不归一就会出现两个只差
     * 大小写 / 连字符的分组，按厂家筛时会**漏掉一半**。实测目录里确实同时存在
     *   `zai-org/GLM-5` 与 `z-ai/glm-5.3-flash`（同为智谱）
     *   `MiniMaxAI/MiniMax-M3` 与 `minimax/minimax-m3-free`（同为 MiniMax）
     * 只合并**确知同名**的前缀；未知前缀原样展示，不替用户猜它是哪家。
     */
    const VENDOR_ALIASES = {
      'zai-org': 'zai',
      'z-ai': 'zai',
      'zhipu': 'zai',
      'minimaxai': 'minimax',
      'moonshotai': 'moonshot',
    };

    /** 厂家展示名。未收录的按首字母大写展示 —— 不编不认识的公司名。 */
    const VENDOR_LABELS = {
      claude: 'Claude',
      deepseek: 'DeepSeek',
      google: 'Google',
      gpt: 'GPT',
      inclusionai: 'InclusionAI',
      meta: 'Meta',
      meituan: 'Meituan',
      minimax: 'MiniMax',
      moonshot: 'Moonshot',
      nvidia: 'NVIDIA',
      poolside: 'Poolside',
      qwen: 'Qwen',
      sakana: 'Sakana',
      stepfun: 'StepFun',
      tencent: 'Tencent',
      thinkingmachines: 'Thinking Machines',
      xai: 'xAI',
      xiaomi: 'Xiaomi',
      zai: 'ZAI',
    };

    /** 模型 id → 厂家分组键（小写）。 */
    function modelVendor(id) {
      const raw = String(id === null || id === undefined ? '' : id);
      const slash = raw.indexOf('/');
      const head = slash >= 0 ? raw.slice(0, slash) : (raw.split('-')[0] || raw);
      const key = head.toLowerCase();
      return VENDOR_ALIASES[key] || key;
    }

    /** 厂家分组键 → 展示名。 */
    function vendorLabel(key) {
      if (VENDOR_LABELS[key]) return VENDOR_LABELS[key];
      if (!key) return '其它';
      return key.charAt(0).toUpperCase() + key.slice(1);
    }

    /**
     * 搜索匹配：模型 id 与厂家名都参与，任一命中即可。
     * 把厂家也算进来，是因为想找 zai 时用户更可能直接敲 `zai`，
     * 而不是先去下拉框里挑一遍。
     */
    function matchModel(id, query) {
      if (!query) return true;
      const q = String(query).trim().toLowerCase();
      if (q.length === 0) return true;
      const vendor = modelVendor(id);
      return String(id).toLowerCase().indexOf(q) >= 0
        || vendor.indexOf(q) >= 0
        || vendorLabel(vendor).toLowerCase().indexOf(q) >= 0;
    }

    /**
     * 一个模型开关。黑名单制：`hidden` 为真表示该模型在 Models 页被隐藏。
     * 整行可点（不只是开关本体），键盘也能用。
     *
     * 关闭状态只靠三处体现：文字变灰、开关拨到左边、价格胶囊跟着变淡 ——
     * 不再放 HIDDEN 标签（灰底框让位给价格，一行只有一个胶囊更干净）。
     *
     * `pricing` 来自官方 CLI catalog（Provider API 不提供计价字段）；
     * 缺失时整段不渲染 —— 宁可不显示，也不编一个 $0。
     */
    function ModelSwitch(props) {
      const { id, hidden, busy, pricing, onToggle } = props;
      const fire = () => { if (!busy) onToggle(id, !hidden); };
      const price = formatPricing(pricing);
      return H('div', {
        className: 'cmdgo-switch-row' + (hidden ? ' off' : ''),
        role: 'switch',
        'aria-checked': hidden ? 'false' : 'true',
        tabIndex: 0,
        title: (hidden ? id + ' —— 已从 Models 页隐藏（点击恢复）' : id + ' —— 显示中（点击隐藏）')
          + (price === null ? '' : '\n' + price.full),
        onClick: fire,
        onKeyDown: (e) => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fire(); }
        },
      },
        H('span', { className: 'cmdgo-switch' + (hidden ? '' : ' on') }),
        H('span', { className: 'cmdgo-switch-name' }, id),
        // 价格胶囊：内部是定宽 inline-grid，把 `/` 和「缓存」钉在固定列上，
        // 所以所有行的这两处都在同一条竖线上，能直接纵向比价。
        // 没有费率的模型整块留空（但列宽由胶囊的 min-width 保证一致）。
        H('span', { className: 'cmdgo-price' },
          price === null ? null
            : H('span', { className: 'cmdgo-price-pill' + (hidden ? ' off' : '') },
              H('span', { className: 'cmdgo-price-in' }, price.input),
              H('span', { className: 'cmdgo-price-slash' }, '/'),
              H('span', { className: 'cmdgo-price-out' }, price.output),
              // 有缓存段才画间隔号；没有时用空占位撑住网格列，宽度不变。
              price.cacheValue === null
                ? H(React.Fragment, null,
                  H('span', { className: 'cmdgo-price-sep cmdgo-price-cacheempty' }, '\u00b7'),
                  H('span', { className: 'cmdgo-price-label cmdgo-price-cacheempty' }, '\u7f13\u5b58'),
                  H('span', { className: 'cmdgo-price-cache cmdgo-price-cacheempty' }, '\u2014'))
                : H(React.Fragment, null,
                  H('span', { className: 'cmdgo-price-sep' }, '\u00b7'),
                  H('span', { className: 'cmdgo-price-label' }, '\u7f13\u5b58'),
                  H('span', { className: 'cmdgo-price-cache' }, price.cacheValue)))),
      );
    }

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

    /** 一条额度：标签 + 进度条 + 剩余额度 + 百分比 + 已用/上限 + 重置时间。 */
    function QuotaRow(props) {
      const raw = props.percent;
      const pct = typeof raw === 'number' && isFinite(raw) ? Math.max(0, Math.min(1, raw)) : null;
      const cls = pct === null ? '' : (pct >= 0.9 ? 'crit' : (pct >= 0.7 ? 'warn' : ''));
      const width = pct === null || pct <= 0 ? 0 : Math.max(pct * 100, 1.5);
      const remaining = typeof props.remaining === 'number' && isFinite(props.remaining)
        ? props.remaining
        : null;
      return H('div', { className: 'cmdgo-qrow', title: props.title || undefined },
        H('span', { className: 'cmdgo-qtag' }, props.tag),
        H('span', { className: 'cmdgo-qbar' + (pct === null ? ' na' : '') },
          width > 0 ? H('span', { className: 'cmdgo-qfill ' + cls, style: { width: width + '%' } }) : null),
        // 剩余额度放在百分比**左侧**：浮层窄，金额列（已用/上限）被隐藏后
        // 这一列是行内唯一的美元信息，见 README「右上角额度 HUD」。
        remaining === null
          ? null
          : H('span', { className: 'cmdgo-qrem', title: '剩余额度' }, '剩' + fmtMoney(remaining)),
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
            remaining: usage.fiveHour.remaining,
            value: fmtMoney(usage.fiveHour.used) + ' / ' + fmtMoney(usage.fiveHour.cap),
            reset: fmtCountdown(usage.fiveHour.resetAt, now),
            title: '5 小时滚动窗口 · 剩余 ' + fmtMoney(usage.fiveHour.remaining),
          }) : null,
          usage.weekly ? H(QuotaRow, {
            tag: '周',
            percent: usage.weekly.percent,
            remaining: usage.weekly.remaining,
            value: fmtMoney(usage.weekly.used) + ' / ' + fmtMoney(usage.weekly.cap),
            reset: fmtCountdown(usage.weekly.resetAt, now),
            title: '每周滚动窗口 · 剩余 ' + fmtMoney(usage.weekly.remaining),
          }) : null,
          usage.monthly ? H(QuotaRow, {
            tag: '月',
            percent: monthly.percent,
            remaining: monthly.remaining,
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
      const [modelBusy, setModelBusy] = React.useState('');
      const [hudBusy, setHudBusy] = React.useState(false);
      // 模型目录筛选：搜索词 + 厂家（'' = 全部）。都是纯视图状态，
      // 不参与轮询快照，所以刷新目录不会把它们重置掉。
      const [modelQuery, setModelQuery] = React.useState('');
      const [modelVendorFilter, setModelVendorFilter] = React.useState('');

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
      // 模型开关：单模型切换 / 全部关闭 / 全部打开。
      // 宿主改完会广播 llm/adapters-updated，Models 页与 composer 随即重取目录，
      // 这里只需刷新本页快照。
      const toggleModel = async (id, hidden) => {
        setModelBusy(id);
        try { await api('/model/toggle', 'POST', { id: id, hidden: hidden }); await refresh(); }
        catch (e) { setErr(String(e.message || e)); }
        setModelBusy('');
      };
      const hideAllModels = async () => {
        setModelBusy('*');
        try { await api('/model/hide-all', 'POST', {}); await refresh(); }
        catch (e) { setErr(String(e.message || e)); }
        setModelBusy('');
      };
      const showAllModels = async () => {
        setModelBusy('*');
        try { await api('/model/show-all', 'POST', {}); await refresh(); }
        catch (e) { setErr(String(e.message || e)); }
        setModelBusy('');
      };
      // 批量关/开**当前筛选结果**。宿主只有全局的 hide-all / show-all，
      // 没有「按范围批量」的接口，所以这里逐个 /model/toggle。
      // 不用改宿主（src/ 改动要重新编译 + 重启 DSH，而 client.js 刷新页面即可），
      // 也不会误伤筛选之外的模型 —— 用户筛到 zai 再点「全部关闭」，
      // 期待的是关掉眼前这几条，不是把 53 个全关掉。
      // 未筛选时仍走宿主的一次性接口（见下面按钮的 onClick）。
      const bulkToggle = async (hidden) => {
        setModelBusy('*');
        try {
          for (let i = 0; i < shownModels.length; i += 1) {
            const id = shownModels[i];
            if (hiddenSet.has(id) === hidden) continue; // 已是目标态：省掉一半请求
            await api('/model/toggle', 'POST', { id: id, hidden: hidden });
          }
          await refresh();
        } catch (e) { setErr(String(e.message || e)); }
        setModelBusy('');
      };
      const toggleHud = async (enabled) => {
        setHudBusy(true);
        try { await api('/hud/toggle', 'POST', { enabled: enabled }); await refresh(); }
        catch (e) { setErr(String(e.message || e)); }
        setHudBusy(false);
      };      const openUrl = () => { if (authUrl) window.open(authUrl, '_blank', 'noopener'); };
      const copyUrl = async () => {
        if (!authUrl) return;
        try { await navigator.clipboard.writeText(authUrl); setCopied(true); setTimeout(() => setCopied(false), 1500); }
        catch (e) { /* 剪贴板不可用时用户可手动选中复制 */ }
      };

      // 模型开关：`snap.models` 是宿主扫描到的**完整**目录（含已隐藏项），
      // `snap.prefs.hiddenModels` 是黑名单。两者相减即当前可见数。
      const models = snap && Array.isArray(snap.models) ? snap.models : [];
      const hiddenSet = new Set(snap && snap.prefs ? snap.prefs.hiddenModels : []);
      const visibleCount = models.filter(function (id) { return !hiddenSet.has(id); }).length;
      // 费率表：宿主拿不到官方目录时是空对象，此时整列不渲染。
      const pricingMap = (snap && snap.pricing && typeof snap.pricing === 'object') ? snap.pricing : {};
      const pricedCount = models.filter(function (id) { return pricingMap[id] !== undefined; }).length;
      // 宿主可能是旧版（无 prefs 字段）：缺省视为「HUD 显示」。
      const hudEnabled = !(snap && snap.prefs && snap.prefs.hudEnabled === false);

      /* --- 模型目录筛选：厂家清单 + 过滤后的列表 --- */
      // 厂家清单从**当前目录**现算（不写死）：上游增删模型时筛选条自动跟着变。
      // 只统计出现的厂家及其数量，按数量降序、同数量按名字排序，位置稳定不跳动。
      const vendorCounts = (() => {
        const map = new Map();
        models.forEach(function (id) {
          const key = modelVendor(id);
          map.set(key, (map.get(key) || 0) + 1);
        });
        return Array.from(map.entries()).sort(function (a, b) {
          if (b[1] !== a[1]) return b[1] - a[1];
          return a[0] < b[0] ? -1 : (a[0] > b[0] ? 1 : 0);
        });
      })();
      const shownModels = models.filter(function (id) {
        if (modelVendorFilter && modelVendor(id) !== modelVendorFilter) return false;
        return matchModel(id, modelQuery);
      });
      // 筛选生效时，批量按钮只作用于**筛出来的这些** —— 否则「全部关闭」会在
      // 用户以为只操作 zai 的时候，把 53 个模型全关掉。
      const filtering = modelVendorFilter !== '' || String(modelQuery).trim() !== '';
      const shownHidden = shownModels.filter(function (id) { return hiddenSet.has(id); }).length;
      const shownVisible = shownModels.length - shownHidden;
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
            // ---- 模型开关（黑名单制：不在隐藏表里即为显示） ----
            models.length > 0
              ? H(React.Fragment, null,
                H('div', { className: 'cmdgo-models-head' },
                  H('span', { className: 'cmdgo-hint' }, '关闭的模型只从 Models 页隐藏；已选中的会话不受影响'
                    + (pricedCount > 0
                      ? '。价格为单位每 1M token（入/出 · 缓存读），来自官方 CLI 目录'
                      : '。价格需等官方目录同步后显示')),
                  H('div', { className: 'cmdgo-models-head-row' },
                    H('span', { className: 'cmdgo-models-count' }, visibleCount + '/' + models.length + ' 显示'),
                    // 未筛选 → 走宿主一次性接口；筛选中 → 只作用于筛出来的那些。
                    H('button', {
                      className: 'cmdgo-btn cmdgo-btn-sm',
                      disabled: modelBusy !== '' || (filtering && shownVisible === 0),
                      title: filtering
                        ? '关闭当前筛出的 ' + shownVisible + ' 个显示中的模型（不影响筛选之外的）'
                        : '关闭全部 ' + models.length + ' 个模型',
                      onClick: () => (filtering ? bulkToggle(true) : hideAllModels()),
                    }, modelBusy === '*' ? '···' : (filtering ? '关闭筛出的 ' + shownVisible + ' 个' : '全部关闭')),
                    H('button', {
                      className: 'cmdgo-btn cmdgo-btn-sm',
                      disabled: modelBusy !== ''
                        || (filtering ? shownHidden === 0 : hiddenSet.size === 0),
                      title: filtering
                        ? '打开当前筛出的 ' + shownHidden + ' 个隐藏中的模型（不影响筛选之外的）'
                        : '打开全部已隐藏模型',
                      onClick: () => (filtering ? bulkToggle(false) : showAllModels()),
                    }, filtering ? '打开筛出的 ' + shownHidden + ' 个' : '全部打开'),
                  ),
                ),
                // ---- 搜索 + 厂家筛选 ----
                H('div', { className: 'cmdgo-filter' },
                  H('span', { className: 'cmdgo-search' },
                    H('input', {
                      type: 'search',
                      value: modelQuery,
                      placeholder: '搜索模型或厂家，例如 kimi / zai / qwen',
                      'aria-label': '按名称或厂家搜索模型',
                      onChange: (e) => setModelQuery(e.target.value),
                      // Esc 优先清搜索词：比让整个设置页失焦更符合预期。
                      onKeyDown: (e) => {
                        if (e.key === 'Escape' && modelQuery !== '') {
                          e.stopPropagation();
                          setModelQuery('');
                        }
                      },
                    }),
                    modelQuery !== ''
                      ? H('button', {
                        className: 'cmdgo-search-clear',
                        title: '清空搜索',
                        'aria-label': '清空搜索',
                        onClick: () => setModelQuery(''),
                      }, '\u00d7')
                      : null,
                  ),
                  // 下拉框是给「厂家太多、懒得找芯片」时的兜底；芯片才是主入口。
                  H('select', {
                    value: modelVendorFilter,
                    'aria-label': '按厂家筛选模型',
                    onChange: (e) => setModelVendorFilter(e.target.value),
                  },
                    H('option', { value: '' }, '全部厂家（' + models.length + '）'),
                    vendorCounts.map((entry) => H('option', { key: entry[0], value: entry[0] },
                      vendorLabel(entry[0]) + '（' + entry[1] + '）'))),
                ),
                H('div', { className: 'cmdgo-vendors' },
                  H('button', {
                    className: 'cmdgo-vchip' + (modelVendorFilter === '' ? ' on' : ''),
                    onClick: () => setModelVendorFilter(''),
                  }, '全部', H('span', { className: 'cmdgo-vchip-n' }, String(models.length))),
                  vendorCounts.map((entry) => H('button', {
                    key: entry[0],
                    className: 'cmdgo-vchip' + (modelVendorFilter === entry[0] ? ' on' : ''),
                    // 再点一次当前芯片 = 取消筛选（切换成本更低，不用去找「全部」）。
                    onClick: () => setModelVendorFilter(modelVendorFilter === entry[0] ? '' : entry[0]),
                  }, vendorLabel(entry[0]), H('span', { className: 'cmdgo-vchip-n' }, String(entry[1])))),
                ),
                // 筛选生效时说明批量按钮的作用范围 —— 避免"以为只关 zai，
                // 结果 53 个全关了"这种不可逆的误操作。
                filtering
                  ? H('div', { className: 'cmdgo-models-count', style: { margin: '6px 0 0', textAlign: 'left' } },
                    '筛出 ' + shownModels.length + ' 个（显示 ' + shownVisible + ' / 隐藏 ' + shownHidden + '）'
                    + ' —— 上面的按钮只作用于这些')
                  : null,
                shownModels.length === 0
                  ? H('div', { className: 'cmdgo-models-empty' },
                    '没有匹配的模型' + (modelQuery !== '' ? '：' + modelQuery : '')
                    + (modelVendorFilter !== '' ? '（厂家 ' + vendorLabel(modelVendorFilter) + '）' : ''))
                  : H('div', { className: 'cmdgo-models' },
                    shownModels.map((id) => H(ModelSwitch, {
                      key: id,
                      id: id,
                      hidden: hiddenSet.has(id),
                      busy: modelBusy === id,
                      pricing: pricingMap[id],
                      onToggle: toggleModel,
                    }))),
              )
              : null,
            H('hr', { className: 'cmdgo-div' }),
            // ---- 订阅胶囊开关 ----
            H('div', { className: 'cmdgo-label' }, 'HUD // 订阅额度胶囊'),
            H('div', { className: 'cmdgo-row' },
              H('span', { className: 'cmdgo-hint' }, hudEnabled
                ? '已显示：模型选择器左侧显示 CommandCode Go 订阅胶囊（仅当选中本插件的模型时）'
                : '已隐藏：不再显示订阅胶囊（设置页与浮层数据仍在轮询）'),
              H('button', {
                className: 'cmdgo-btn cmdgo-btn-sm',
                disabled: hudBusy,
                onClick: () => toggleHud(!hudEnabled),
              }, hudBusy ? '···' : (hudEnabled ? '隐藏胶囊' : '显示胶囊')),
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
      /** 当前会话身份：由会话头部的胶囊写入，面板用它定位缓存台账。 */
      sessionId: '',
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

    /* ---------------- 模型门禁：只在选中本插件模型时显示胶囊 ----------------
     * 与 dsh-codearts-auth 的 `supportsCreditBalance(provider)` 同一思路：读当前
     * 会话的模型目录，只有选中的 provider 属于本插件时才渲染胶囊。区别是
     * codearts 按「哪些渠道有额度」写死名单，这里只有一个 provider
     * （`commandcode`，与 src/index.ts 的 PROVIDER 常量一致）。
     */

    /** 本插件在宿主里的 provider id —— 必须与 src/index.ts 的 PROVIDER 一致。 */
    const PROVIDER = 'commandcode';

    /**
     * 目录解析重试间隔（毫秒）。会话刚建立时宿主可能还没准备好该会话的
     * scope，`directoryFor` 会抛错；与 codearts 一样重试几轮再放弃。
     */
    const RESOLVE_RETRY_DELAYS = [300, 700, 1500, 2000];

    /**
     * 门禁降级只提醒一次（本模块作用域，整个页面生命周期一次）：胶囊不显示是
     * **可见但无害**的降级，不该在每次渲染/重试时刷屏 console。
     */
    let gateWarned = false;
    function warnGateOnce(reason) {
      if (gateWarned) return;
      gateWarned = true;
      console.warn('[cmdgo] 订阅胶囊不显示（' + reason + '）—— 模型门禁无法判定，不影响其它功能。');
    }

    /**
     * 把「本会话当前选中的 provider」同步进共享 store。
     *
     * ⚠️ `resolveDirectory` 必须是**取值函数**、且只能在 effect 里调（真机事故
     * 教训，见 dsh-codearts-auth 2026-10-02）：`modelDirectories.directoryFor()`
     * 是惰性 getter，在会话输入区渲染的同步路径上求值会在桌面版抛
     * 「cannot get property remote.session without inject」，那会让整个 composer
     * 渲染中断（表现为**模型选择器点不动**），远不止胶囊不显示。放到 effect 里
     * 并 try/catch，影响面收敛到「胶囊不显示」。
     *
     * 另外 store 初值是 `{ current: null, status: 'idle' }`，只有 `await load()`
     * 之后 `current` 才会填上真实选择 —— 所以这里必须主动调一次 `load()`，
     * 否则 `current` 永远是 null、胶囊永不出现。
     */
    function useSelectedProvider(resolveDirectory, sessionId) {
      // inject 交出的取值函数每次渲染都是新引用，直接进依赖会让 effect 反复重跑
      // （每跑一次就多一个目录订阅）。用 ref 固定住最新引用，effect 只跟会话走。
      const resolveRef = React.useRef(resolveDirectory);
      resolveRef.current = resolveDirectory;

      React.useEffect(() => {
        let alive = true;
        const timers = [];
        let unsubscribe = null;
        let attempt = 0;

        const publish = (store) => {
          if (!alive) return;
          let provider = null;
          try {
            const snapshot = store && typeof store.getSnapshot === 'function' ? store.getSnapshot() : null;
            const current = snapshot ? snapshot.current : null;
            if (current && typeof current.provider === 'string' && current.provider.length > 0) {
              provider = current.provider;
            }
          } catch (e) {
            // 读快照失败按「未知」处理：门禁关着，不影响 composer。
            provider = null;
          }
          if (hudStore.provider !== provider) {
            // 门禁关掉时顺手收起面板：胶囊没了就再没有可见的开关，
            // 留一个悬空面板在屏幕上会让人不知道怎么关。
            const patch = { provider: provider };
            if (provider !== PROVIDER && hudStore.open === true) patch.open = false;
            hudStore.set(patch);
          }
        };

        const tryResolve = () => {
          if (!alive) return;
          const resolve = resolveRef.current;
          if (typeof resolve !== 'function') { warnGateOnce('宿主未交出模型目录取值函数'); return; }
          let resolved = null;
          try { resolved = resolve(); } catch (e) { resolved = null; }
          if (!alive) return;
          if (resolved && resolved.store !== undefined) {
            const store = resolved.store;
            publish(store);
            try { unsubscribe = typeof store.subscribe === 'function' ? store.subscribe(() => publish(store)) : null; } catch (e) { unsubscribe = null; }
            if (typeof resolved.load === 'function') {
              try { Promise.resolve(resolved.load()).catch(() => { /* 目录加载失败：门禁保持关闭 */ }); } catch (e) { /* 同上 */ }
            }
            return;
          }
          attempt += 1;
          if (attempt >= RESOLVE_RETRY_DELAYS.length) { warnGateOnce('模型目录解析最终失败'); return; }
          timers.push(setTimeout(tryResolve, RESOLVE_RETRY_DELAYS[attempt - 1]));
        };

        tryResolve();
        return () => {
          alive = false;
          for (const timer of timers) clearTimeout(timer);
          if (typeof unsubscribe === 'function') { try { unsubscribe(); } catch (e) { /* 忽略 */ } }
          // 会话切走：清掉门禁，避免上一会话的选中 provider 泄漏到新会话。
          if (hudStore.provider !== null) hudStore.set({ provider: null });
        };
      }, [sessionId]);
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

    /** token 数紧凑显示：1.2k / 3.4M。 */
    function fmtTokens(n) {
      if (typeof n !== 'number' || !isFinite(n)) return '—';
      if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + 'M';
      if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e4 ? 0 : 1) + 'k';
      return String(Math.round(n));
    }

    /** 命中率 = 缓存读 ÷（未命中输入 + 缓存读 + 缓存写）。宿主已算好，这里只兜底。 */
    function rowHitRate(row) {
      if (!row) return undefined;
      const read = row.cacheReadTokens || 0;
      const billed = (row.inputTokens || 0) + read + (row.cacheWriteTokens || 0);
      return billed > 0 ? read / billed : undefined;
    }

    /** 一行台账的紧凑文案。 */
    function cacheLine(row) {
      if (!row) return '—';
      const parts = [row.requests + ' 次请求', '输入 ' + fmtTokens(row.inputTokens)];
      parts.push('缓存读 ' + fmtTokens(row.cacheReadTokens));
      if ((row.cacheWriteTokens || 0) > 0) parts.push('缓存写 ' + fmtTokens(row.cacheWriteTokens));
      const hit = rowHitRate(row);
      if (hit !== undefined && (row.cacheReportedRequests || 0) > 0) parts.push('命中 ' + (hit * 100).toFixed(0) + '%');
      if (row.model) parts.push(row.model);
      return parts.join(' · ');
    }

    /**
     * 缓存台账文案（issue #6 补充诉求）：让用户能直接验证缓存到底有没有命中。
     *
     * 客户端在会话头部时报上 sessionId，宿主回 `cache.current`（本会话）；
     * 拿不到就退回「最近一次 + 进程内累计 + 最近几个会话」。命中率只在网关
     * 真的报了缓存字段时才给——没报就直说「网关未报」，不编 0%。
     */
    function cacheSummary(cache) {
      if (!cache) return ['需要宿主 0.9.0（重启 DSH 后可用）'];
      const lines = [];
      if (cache.current) lines.push('本会话（' + cache.current.label + '）：' + cacheLine(cache.current));
      const last = cache.last;
      if (last) {
        lines.push('最近一次（' + (last.model || '?') + ' · ' + fmtTime(last.at) + '）：输入 '
          + fmtTokens(last.inputTokens) + ' · 输出 ' + fmtTokens(last.outputTokens)
          + (last.cacheReported
            ? ' · 缓存读 ' + fmtTokens(last.cacheReadTokens || 0) + ' / 写 ' + fmtTokens(last.cacheWriteTokens || 0)
              + ' · 命中 ' + ((last.cacheHitRate || 0) * 100).toFixed(0) + '%'
            : ' · 网关未报缓存字段'));
      } else {
        lines.push('还没有本插件的请求记录 —— 发一条消息后出现');
      }
      const t = cache.total;
      if (t && t.requests > 0) {
        lines.push('进程内累计：' + t.requests + ' 次 · 缓存读 ' + fmtTokens(t.cacheReadTokens)
          + ((t.cacheWriteTokens || 0) > 0 ? ' / 写 ' + fmtTokens(t.cacheWriteTokens) : '')
          + ' · 报告缓存字段 ' + t.cacheReportedRequests + '/' + t.requests);
      }
      const others = (cache.sessions || []).filter((r) => !cache.current || r.label !== cache.current.label).slice(0, 3);
      if (others.length > 0) {
        lines.push('最近会话：' + others.map((r) => r.label + ' ' + r.requests + '次 读' + fmtTokens(r.cacheReadTokens)).join(' · '));
      }
      return lines;
    }

    /** 胶囊：会话头部工具区里的紧凑入口（只读共享快照，自己不请求）。 */
    function QuotaHudPill(props) {
      ensureHudStyle();
      const hud = useHud();
      // 模型门禁：只有当前会话选中的 provider 是本插件时才显示这颗胶囊。
      // 订阅额度是「用本套餐时才关心」的信息；用别的模型时它没有意义，
      // 也不该占着模型选择器左边的位置。
      useSelectedProvider(props && props.resolveDirectory, props && typeof props.sessionId === 'string' ? props.sessionId : '');
      if (hud.provider !== PROVIDER) return null;
      const sessionId = props && typeof props.sessionId === 'string' ? props.sessionId : '';
      // 会话头部是 session 作用域：把当前会话身份交给共享 store，面板据此把
      // 缓存台账定位到「本会话」（issue #6 补充诉求）。
      React.useEffect(() => {
        if (sessionId && hudStore.sessionId !== sessionId) hudStore.set({ sessionId: sessionId });
      }, [sessionId]);
      const accounts = hud.snap ? hud.snap.accounts : [];
      if (accounts.length === 0) return null;
      const meter = hud.snap ? hud.snap.meter : undefined;
      const cache = hud.snap ? hud.snap.cache : undefined;
      const cacheCurrent = cache && cache.current ? cache.current : undefined;
      const cacheHit = rowHitRate(cacheCurrent);
      const cacheReported = cacheCurrent && (cacheCurrent.cacheReportedRequests || 0) > 0;
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
          + (cacheReported
            ? ' · 本会话缓存命中 ' + (cacheHit * 100).toFixed(0) + '%（读 ' + fmtTokens(cacheCurrent.cacheReadTokens) + '）'
            : '')
          + ' —— 点击查看每个账号的额度',
        onClick: (e) => { e.stopPropagation(); hudStore.set({ open: hudStore.open !== true }); },
      },
        H('span', { className: 'cmdgo-hud-dot ' + dot }),
        H('span', { className: 'cmdgo-hud-tag' }, 'CC'),
        H('span', { className: 'cmdgo-hud-num' }, tight === null ? '读取中' : tight.tag + ' ' + fmtPct(tight.percent)),
        H('span', { className: 'cmdgo-hud-num' }, 'Σ' + fmtMoneyShort(totals.monthly)),
        calls === undefined ? null : H('span', { className: 'cmdgo-hud-num' }, '≈' + calls + '次'),
        cacheReported ? H('span', { className: 'cmdgo-hud-num' }, '⤢' + (cacheHit * 100).toFixed(0) + '%') : null,
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
          // 带上当前会话身份：宿主据此把缓存台账定位到「本会话」。
          const sid = hudStore.sessionId;
          const path = sid ? '/status?sessionId=' + encodeURIComponent(sid) : '/status';
          const data = await api(path);
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
          // 缓存台账：验证 `x-session-id` 对齐后上游是否真的复用了缓存
          // （issue #6 的补充诉求）。
          H('div', { className: 'cmdgo-hud-sumrow' },
            H('span', { className: 'cmdgo-hud-sumk' }, '缓存台账'),
            H('span', { className: 'cmdgo-hud-sumv' },
              cacheSummary(snap.cache).map((line, i) => H('div', { key: 'cache-' + i }, line))),
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
      // 胶囊从会话头部（右上角）搬到 composer 工具行、**模型选择器左侧**。
      //
      // 依据（宿主源码，不是猜的）：`dsh-client-ui-conversation` 的 InputBar 里
      //   children: [ renderSlot('conversation.input.right'), renderSlot('conversation.input.model') ]
      // —— `conversation.input.right` 是 list 槽且**紧挨模型选择器之前**渲染，
      // 正是模型选择器左边那个位置（面板仍留在 shell.overlay 做帧级浮层）。
      //
      // 该槽在当前宿主里已由 conversation 包声明；try/catch 是给未来宿主版本的
      // 兜底（若某版删了这个槽，register 会抛「slot is not declared」）——宁可
      // 没有胶囊，也不能让异常冒泡到 composer 的渲染路径上。
      slots.inject('conversation.input.right', () => {
        try {
          return slots.register({
            name: 'conversation.input.right',
            id: 'commandcode-go-quota',
            order: 20,
            label: () => 'CommandCode Go 额度',
            // 模型门禁的取值函数：胶囊据此判断当前选中是不是本插件的模型。
            //
            // ⚠️ 必须是**就地返回的 thunk**，且不能提前求值：
            // `ctx.modelDirectories` 是惰性服务，`directoryFor()` 在会话输入区
            // 渲染的同步路径上求值会在桌面版抛错并**中断整个 composer 渲染**
            // （用户报障为「模型选择器点不动」）。真正的调用发生在胶囊自己的
            // effect 里，且被 try/catch 包住。
            inject: (sessionId) => ({
              resolveDirectory: () => {
                const dirs = ctx.get('modelDirectories');
                if (!dirs || typeof dirs.directoryFor !== 'function') return null;
                const directory = dirs.directoryFor(sessionId);
                return { store: directory.store, load: () => directory.load() };
              },
            }),
          }, (props) => React.createElement(QuotaHudPill, props));
        } catch (e) {
          console.warn('[cmdgo] 订阅胶囊注册失败（宿主可能未声明 conversation.input.right）：', e);
          return undefined;
        }
      });
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
