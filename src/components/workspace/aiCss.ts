/**
 * AI 视频工作台（AI 剪辑、AI 解析两页）的质感层，照大厂 AI 客户端的五个细节做：
 * ① 不画边框：极简风格里分区不靠灰线，靠 2%–4% 的底色台阶（白 → #FAFAFA → #F4F4F5）；
 *    按钮和输入框只留一圈比发丝线还淡的环，聚焦是一圈淡蓝光晕，浮起来的菜单用柔和投影；
 * ② 暗色风格（档案馆、内容年志）字重收一档、改灰度抗锯齿：浅字压在深底上看着比实际粗（光渗）；
 * ③ 流式回答像墨晕开：新到的字从模糊淡出到清楚，新段落、新表格行、新的一步淡入（markdownView 的 ink）；
 * ④ 数字一律等宽，计时、时长、进度跳动时不左右抖；展开收起走 grid 0fr→1fr（aiEditShared 的 Expand）；
 * ⑤ 动效分性格：拖片段跟手、不加过渡（看板本来就没有）；按钮按下缩一下、松手回弹，发送钮能点时 Q 弹出场。
 * 只管这两页（按 testID 圈范围）。海报风格的实心黑线是它的招牌，①⑤ 都不碰它；③④ 四种风格都有。
 * 写法同另外几层：按 data-ws 角色选，声明一律 !important 压过 RN-web 的原子类和行内样式。
 */
const EDIT = '[data-testid="ai-edit-workspace"]';
const LIBRARY = '[data-testid="analysis-workspace"]';
const SCOPES = [EDIT, LIBRARY];

const ALL = [":root"];
const MINIMAL = [':root[data-style="minimal"]'];
const DARK = [':root[data-style="archive"]', ':root[data-style="trace"]'];
const NOT_POSTER = [':root:not([data-style="poster"])'];

// 极简的底色台阶：页面白，往下一层 #FAFAFA，再一层 #F4F4F5，悬停再深一档
const T1 = "#FAFAFA";
const T2 = "#F4F4F5";
const T3 = "#EDEDEF";
// AI 剪辑整页的底：上面一块块白面板（对话、播放器、属性、时间线）之间不画线，靠这一档（约 3.5%）分开
const BOARD = "#F6F6F7";
const WHITE = "#FFFFFF";
const MUTE = "#71717A";
const BLUE = "#2563EB";
const HOVER = "rgba(24,24,27,.05)";
const RING = "0 0 0 1px rgba(24,24,27,.06),0 1px 2px rgba(24,24,27,.04)";
const GLOW = "0 0 0 1px rgba(37,99,235,.42),0 0 0 4px rgba(37,99,235,.12)";
const FLOAT = "0 0 0 1px rgba(24,24,27,.05),0 4px 12px -6px rgba(24,24,27,.08),0 20px 44px -18px rgba(24,24,27,.24)";
// 按下快、松手带回弹的曲线（越过 1 再落回）
const SPRING = "cubic-bezier(.34,1.56,.64,1)";

const role = (roles: string) => roles.split(/\s+/u).map((item) => `[data-ws~="${item}"]`).join("");
/** 风格前缀 × 两页（或指定的一页）× 里面的选择器，拼成一条规则 */
function rule(prefixes: string[], inners: string[], body: string, scopes = SCOPES): string {
  return `${prefixes.flatMap((prefix) => scopes.flatMap((scope) => inners.map((inner) => `${prefix} ${scope}${inner ? ` ${inner}` : ""}`))).join(",")}{${body}}`;
}
const btn = `${role("btn")}:not(${role("on")}):not(${role("square")}):not(${role("ai-suggest")})`;
const ghost = `${role("btn square")}:not(${role("on")})`;
const live = ':not([aria-disabled="true"])';

/**
 * RN-web 把字重编成原子类：开发版 r-fontWeight-<哈希>，打包版只剩 r-<哈希>（哈希由测试拿 RN-web 现算核对，见 minimalCss）。
 * 暗色风格里按它把 700 / 600 / 500 各收一档。
 */
export const WEIGHT_HASHES = { "700": "b88u0q", "600": "1kfrs79", "500": "majxgm" } as const;
const lighter = (weight: keyof typeof WEIGHT_HASHES, to: number) =>
  rule(DARK, [`.r-${WEIGHT_HASHES[weight]}`, `.r-fontWeight-${WEIGHT_HASHES[weight]}`], `font-weight:${to}!important`);

export const aiCss = [
  // ③ 墨晕：字从糊到清、从透明到实；段落和表格行多一点上浮
  "@keyframes ws-ink{from{opacity:0;filter:blur(4px)}to{opacity:1;filter:blur(0)}}",
  "@keyframes ws-ink-block{from{opacity:0;transform:translate3d(0,4px,0);filter:blur(2px)}to{opacity:1;transform:none;filter:blur(0)}}",
  "@keyframes ws-shimmer{from{background-position:100% 0}to{background-position:0 0}}",
  "@keyframes ws-send-pop{0%{transform:scale(.8)}100%{transform:scale(1)}}",
  rule(ALL, [role("ink")], "animation:ws-ink .7s cubic-bezier(.2,.7,.2,1) backwards"),
  rule(ALL, [role("ink-block"), role("ai-step")], "animation:ws-ink-block .5s cubic-bezier(.2,.7,.2,1) backwards"),
  // 「AI 正在想…」一道光从字上扫过去
  rule(ALL, [role("ai-shimmer")], "color:transparent!important;background-image:linear-gradient(90deg,var(--ws-text-muted) 40%,var(--ws-text) 50%,var(--ws-text-muted) 60%);background-size:250% 100%;-webkit-background-clip:text;background-clip:text;animation:ws-shimmer 1.8s linear infinite"),
  // ④ 等宽数字
  rule(ALL, [""], "font-variant-numeric:tabular-nums"),

  // ⑤ 按下缩一下、松手回弹；发送钮从不能点变能点时弹出来
  rule(NOT_POSTER, [role("btn"), role("btn-solid"), role("c-send")], `transition:transform .45s ${SPRING},background-color .14s ease,box-shadow .14s ease,color .14s ease!important`),
  rule(NOT_POSTER, [`${role("btn")}${live}:active`, `${role("btn-solid")}${live}:active`, `${role("c-send")}${live}:active`], "transform:scale(.95)!important;transition-duration:.08s!important"),
  rule(NOT_POSTER, [role("c-send on")], `animation:ws-send-pop .42s ${SPRING}`),

  // ② 暗色风格：灰度抗锯齿、字重收一档
  rule(DARK, [""], "-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale"),
  lighter("700", 600),
  lighter("600", 500),
  lighter("500", 400),

  // ① 极简：去线，靠底色台阶分层
  rule(MINIMAL, [role("ai-goal")], `border-color:transparent!important;margin:0 10px 4px!important;padding:7px 10px!important;border-radius:8px!important;background-color:${T1}!important;transition:background-color .14s ease`),
  rule(MINIMAL, [`${role("ai-goal")}:hover`], `background-color:${T2}!important`),
  rule(MINIMAL, [role("e-box")], `border-color:transparent!important;background-color:${T1}!important;box-shadow:none!important`),
  rule(MINIMAL, [role("ai-float")], `border-color:transparent!important;border-radius:14px!important;background-color:${WHITE}!important;box-shadow:${FLOAT}!important`),
  // 剪辑软件那样：整页落一层，左边面板、播放器、属性、时间线是一块块白面板浮在上面
  rule(MINIMAL, ['[data-board-area="board"]'], `background-color:${BOARD}!important`),
  rule(MINIMAL, [role("ai-panel")], `border-color:transparent!important;background-color:${WHITE}!important;border-radius:12px!important;box-shadow:${RING}!important`),

  // 按钮：白底 + 一圈淡环；小方图标钮透明，悬停才有底
  rule(MINIMAL, [btn], `border-color:transparent!important;background-color:${WHITE}!important;box-shadow:${RING}!important`),
  rule(MINIMAL, [`${btn}${live}:hover`], `background-color:${T1}!important`),
  rule(MINIMAL, [ghost], "border-color:transparent!important;background-color:transparent!important;box-shadow:none!important"),
  rule(MINIMAL, [`${ghost}${live}:hover`], `background-color:${HOVER}!important`),
  rule(MINIMAL, [role("ai-suggest")], `border-color:transparent!important;border-radius:10px!important;background-color:${T1}!important;box-shadow:none!important`),
  rule(MINIMAL, [`${role("ai-suggest")}:hover`], `background-color:${T2}!important`),

  // 输入框：去线，白底一圈淡环；聚焦是淡蓝光晕
  rule(MINIMAL, ["input", "textarea"], "border-color:transparent!important;outline:none!important;transition:box-shadow .16s ease,background-color .16s ease!important"),
  // 落在浅底面板里的输入框换白底，不然和面板一个颜色
  rule(MINIMAL, [`${role("e-box")} input`, `${role("e-box")} textarea`, `${role("e-panel")} input`, `${role("e-panel")} textarea`], `background-color:${WHITE}!important;box-shadow:${RING}!important`),
  rule(MINIMAL, ["input:focus", "textarea:focus", `${role("e-box")} input:focus`, `${role("e-box")} textarea:focus`, `${role("e-panel")} input:focus`, `${role("e-panel")} textarea:focus`], `background-color:${WHITE}!important;box-shadow:${GLOW}!important`),

  // AI 剪辑的对话：AI 的回答不套框，像正文一样直接排；做过的步骤收在一块浅底里
  rule(MINIMAL, [role("c-bubble in")], "border-color:transparent!important;background-color:transparent!important;padding-left:2px!important;padding-right:2px!important", [EDIT]),
  rule(MINIMAL, [role("c-bubble own")], `border-color:${T2}!important;background-color:${T2}!important;border-radius:14px!important;border-top-right-radius:4px!important`, [EDIT]),
  rule(MINIMAL, [role("ai-steps")], `border-color:transparent!important;margin-top:2px!important;padding:8px 10px!important;border-radius:10px!important;background-color:${T1}!important`, [EDIT]),
  rule(MINIMAL, [`${role("ai-revert")} [dir]`], `color:${MUTE}!important;transition:color .14s ease`, [EDIT]),
  rule(MINIMAL, [`${role("ai-revert")}:hover [dir]`], `color:${BLUE}!important`, [EDIT]),
  // 输入框底下垫一条浅底，和上面的对话分开
  rule(MINIMAL, [role("c-composer")], `border-color:transparent!important;background-color:${T1}!important`, [EDIT]),
  rule(MINIMAL, [role("c-input")], `border-color:transparent!important;border-radius:12px!important;background-color:${WHITE}!important;box-shadow:${RING}!important`, [EDIT]),
  rule(MINIMAL, [`${role("c-input")}:focus`], `box-shadow:${GLOW}!important`, [EDIT]),
  rule(MINIMAL, [role("c-send")], `border-radius:10px!important;background-color:${T3}!important`, [EDIT]),
  rule(MINIMAL, [role("c-send on")], "background-color:#18181B!important", [EDIT]),

  // AI 解析：链接栏、正文各落一层底，列表项不描边，选中的只深一档
  rule(MINIMAL, [role("an-bar")], "border-radius:14px!important", [LIBRARY]),
  rule(MINIMAL, [`${role("an-bar")} input`], `border-radius:10px!important;background-color:${WHITE}!important;box-shadow:${RING}!important`, [LIBRARY]),
  rule(MINIMAL, [`${role("an-bar")} input:focus`], `box-shadow:${GLOW}!important`, [LIBRARY]),
  rule(MINIMAL, [role("an-item")], `border-radius:10px!important;background-color:transparent!important;transition:background-color .14s ease`, [LIBRARY]),
  rule(MINIMAL, [`${role("an-item")}:hover`], `background-color:${T1}!important`, [LIBRARY]),
  rule(MINIMAL, [role("an-item on")], `border-color:transparent!important;background-color:${T2}!important`, [LIBRARY]),
  rule(MINIMAL, [role("an-detail")], "border-radius:16px!important", [LIBRARY]),
  rule(MINIMAL, [role("md")], "border-color:transparent!important"),

  // Markdown 表格：去掉外框和竖线，表头一层浅底，行与行之间只留很淡的一道
  rule(MINIMAL, [role("md-table")], `border-color:transparent!important;border-radius:10px!important;background-color:${WHITE}!important`),
  rule(MINIMAL, [role("md-table")], "box-shadow:0 0 0 1px rgba(24,24,27,.06)!important", [EDIT]),
  rule(MINIMAL, [role("md-tr")], "border-bottom-color:rgba(24,24,27,.05)!important"),
  rule(MINIMAL, [`${role("md-tr")}:last-child`], "border-bottom-color:transparent!important"),
  rule(MINIMAL, [role("md-th")], "background-color:rgba(24,24,27,.03)!important"),
  rule(MINIMAL, [role("md-td")], "border-right-color:transparent!important"),

  // 少动效：不晕、不扫、不弹，展开收起直接到位
  `@media (prefers-reduced-motion:reduce){${rule(ALL, [role("ink"), role("ink-block"), role("ai-step"), role("c-send on")], "animation:none!important")}${rule(ALL, [role("ai-shimmer")], "animation:none!important;color:var(--ws-text-muted)!important;background-image:none!important")}${rule(ALL, ["[data-expand]"], "transition:none!important")}${rule(NOT_POSTER, [role("btn"), role("btn-solid"), role("c-send")], "transform:none!important")}}`,
].join("\n");
