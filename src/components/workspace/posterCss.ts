/**
 * 海报风格的版式层：只挂在 :root[data-style="poster"] 下，档案馆和内容年志一条也匹配不到。
 * 组件上用 ws("角色") / fx({ ws }) 打 data-ws 标记（见 motion.tsx），这里按角色把它们印成展览海报：
 * 墨黑 / 新闻纸 / 纯白 / 信号橙，3px 实心黑线，零圆角零阴影，Anton 数字、Noto Sans SC 900 标题、JetBrains Mono 戳。
 * RN-web 的原子类和行内样式都要压过，所以版式声明一律 !important。
 * 色块用"换底"做：在一块元素上重新定义 --ws-* 变量，里面所有用 token 的字和图标自动反色（同 prototype 里的 .bg-ink/.bg-sig）。
 */
const P = ':root[data-style="poster"]';
const INK = "#0A0A0A";
const PAPER = "#F1EEE6";
const WHITE = "#FFFFFF";
const SIG = "#FF4A1C";
const DISPLAY = "Anton, 'Noto Sans SC', 'PingFang SC', sans-serif";
const CJK = "'Noto Sans SC', 'PingFang SC', sans-serif";
const MONO = "'JetBrains Mono', 'Noto Sans SC', 'PingFang SC', monospace";

/** 选中带某个角色的元素；"a b" 表示同一元素同时带 a 和 b。多个用逗号分开。 */
function sel(roles: string, suffix = ""): string {
  return roles.split(",").map((group) => `${P} ${group.trim().split(/\s+/u).map((role) => `[data-ws~="${role}"]`).join("")}${suffix}`).join(",");
}
const rule = (selector: string, body: string) => `${selector}{${body}}`;

/** 前景色一换，所有字、线、图标跟着换（按钮、戳、色块内部用）。 */
function ink(fg: string, muted = fg): string {
  return [
    `--ws-text:${fg}`, `--ws-text-secondary:${fg}`, `--ws-text-muted:${muted}`, `--ws-figure:${fg}`,
    `--ws-accent:${fg}`, `--ws-cyan:${fg}`, `--ws-green:${fg}`, `--ws-amber:${fg}`, `--ws-signal:${fg}`,
    `--ws-button-text:${fg}`, `--ws-white:${fg}`, `--ws-black:${fg}`, `--ws-border:${fg}`, `--ws-border-soft:${fg}`, `--ws-frame:${fg}`,
    `color:${fg}`,
  ].join(";");
}

/** 一块底色：前景 / 背景 / 弱化字 / 强调色 / 实心按钮。 */
function ground(fg: string, bg: string, muted: string, accent: string, raised: string): string {
  return [
    // --ph / --pa：实心按钮悬停、按下时的底色；橙底上换成新闻纸 / 纯白，免得按钮融进底里
    `--pf:${fg}`, `--pb:${bg}`, `--ph:${bg === SIG ? PAPER : SIG}`, `--pa:${bg === SIG ? WHITE : SIG}`,
    `--ws-canvas:${bg}`, `--ws-sidebar:${bg}`, `--ws-surface:${bg}`, `--ws-surface-raised:${raised}`, `--ws-surface-muted:${raised}`,
    `--ws-text:${fg}`, `--ws-text-secondary:${fg}`, `--ws-text-muted:${muted}`, `--ws-figure:${fg}`,
    `--ws-border:${fg}`, `--ws-border-soft:${fg}`, `--ws-frame:${fg}`,
    `--ws-accent:${accent}`, `--ws-cyan:${accent}`, `--ws-green:${accent}`, `--ws-amber:${accent}`, `--ws-signal:${accent}`,
    `--ws-button:${accent === SIG ? SIG : fg}`, `--ws-button-text:${accent === SIG ? INK : bg}`,
    `--ws-white:${fg}`, `--ws-danger:${accent}`,
    `background-color:${bg}!important`, `color:${fg}`,
  ].join(";");
}
const INK_GROUND = ground(PAPER, INK, "#A9A396", SIG, "#2A2A2A");
const SIG_GROUND = ground(INK, SIG, "#3D1407", INK, "#E03A10");
const WHITE_GROUND = ground(INK, WHITE, "#5E5A52", SIG, "#E4E0D4");

const heavy = (size: number, line = 1.04, track = "-.03em") => `font-family:${CJK}!important;font-weight:900!important;font-size:${size}px!important;line-height:${line}!important;letter-spacing:${track}!important`;
const display = (size: number, line = 0.88) => `font-family:${DISPLAY}!important;font-weight:400!important;font-size:${size}px!important;line-height:${line}!important;letter-spacing:-.01em!important;font-variant-numeric:normal!important`;
const box = (width = 3) => `border:${width}px solid var(--pf)!important;border-radius:0!important`;
const notDisabled = ':not([aria-disabled="true"])';

/** 采集器页只有一套自己的样式，全局规则跳过它。 */
const NOT_SETUP = ':not([data-testid="setup-workspace"] *)';

const blocks: string[] = [
  // ---------- 底子：零圆角零阴影，墨黑与新闻纸 ----------
  rule(P, `--pf:${INK};--pb:${PAPER};--ph:${SIG};--pa:${SIG};--ws-swarm:off`),
  rule(`${P} *${NOT_SETUP}`, "border-radius:0!important;box-shadow:none!important;text-shadow:none!important"),
  rule(`${P} ${NOT_SETUP}::selection`, `background:${SIG};color:${INK}`),
  rule(`${P} :focus-visible${NOT_SETUP}`, `outline:3px solid ${SIG}!important;outline-offset:2px!important`),
  rule(sel("g-ink"), INK_GROUND),
  rule(sel("g-sig"), SIG_GROUND),
  rule(sel("g-white"), WHITE_GROUND),

  // ---------- 字：mono 戳、贴条、标题 ----------
  rule(sel("mono"), `font-family:${MONO}!important;text-transform:uppercase;letter-spacing:.06em!important;font-weight:500!important`),
  rule(sel("stamp,stamp-sig,stamp-ghost"), `display:flex;align-self:flex-start!important;flex-direction:row;align-items:center;gap:6px;font-family:${MONO}!important;font-weight:700!important;font-size:11px!important;line-height:1!important;letter-spacing:.1em!important;text-transform:uppercase;padding:5px 7px 4px!important;white-space:nowrap;border-width:0!important;min-height:0!important;height:auto!important`),
  rule(sel("stamp"), `background-color:var(--pf)!important;${ink("var(--pb)")};color:var(--pb)!important`),
  rule(sel("stamp-sig"), `background-color:${SIG}!important;${ink(INK)};color:${INK}!important`),
  rule(sel("stamp-ghost"), `background-color:transparent!important;border:2px solid var(--pf)!important;padding:3px 5px 2px!important;${ink("var(--pf)")};color:var(--pf)!important`),
  rule(sel("stamp-bar"), `${SIG_GROUND};border-width:0!important;border-radius:0!important;margin-left:0!important;margin-right:0!important`),
  rule(sel("stamp-bar", " div[dir]"), `font-weight:700!important`),
  rule(sel("dot"), `width:9px!important;height:9px!important;background-color:var(--ws-text-muted)!important`),
  rule(sel("dot on"), `background-color:${SIG}!important`),
  rule(sel("rule-t"), "border-top:3px solid var(--pf)!important"),

  // ---------- 按钮：3px 框，悬停反相，按下信号橙 ----------
  rule(sel("btn,btn-solid,btn-sig"), `border-radius:0!important;transition:none!important;transform:none!important;border-style:solid!important;border-width:3px!important`),
  rule(sel("btn,btn-solid,btn-sig", " div[dir]"), `font-family:${CJK}!important;font-weight:700!important;letter-spacing:.02em!important`),
  rule(sel("btn"), `background-color:transparent!important;border-color:var(--pf)!important;${ink("var(--pf)")}`),
  rule(`${sel("btn", `${notDisabled}:hover`)},${sel("btn on")}`, `background-color:var(--pf)!important;${ink("var(--pb)")}`),
  rule(sel("btn-solid"), `background-color:var(--pf)!important;border-color:var(--pf)!important;${ink("var(--pb)")}`),
  rule(sel("btn-solid", `${notDisabled}:hover`), `background-color:var(--ph)!important;border-color:var(--pf)!important;${ink(INK)}`),
  rule(sel("btn-sig"), `background-color:${SIG}!important;border-color:${SIG}!important;${ink(INK)}`),
  rule(sel("btn-sig", `${notDisabled}:hover`), `background-color:var(--pf)!important;border-color:var(--pf)!important;${ink("var(--pb)")}`),
  rule(sel("btn,btn-solid,btn-sig", `${notDisabled}:active`), `background-color:var(--pa)!important;border-color:var(--pf)!important;opacity:1!important;${ink(INK)}`),
  rule(sel("btn small"), "border-width:2px!important"),

  // ---------- 动效：硬切 steps()，不缓动 ----------
  "@keyframes ws-poster-in{0%{opacity:0;transform:translate3d(0,26px,0)}1%{opacity:1}100%{opacity:1;transform:none}}",
  "@keyframes ws-poster-blink{0%,49%{opacity:1}50%,100%{opacity:.2}}",
  rule(`${P} [data-motion="rise"],${P} [data-reveal="in"]`, "animation-name:ws-poster-in!important;animation-duration:.36s!important;animation-timing-function:steps(3,end)!important"),
  rule(`${P} [data-motion="fade"]`, "animation-timing-function:steps(2,end)!important;animation-duration:.24s!important"),
  rule(`${P} [data-motion="pop"]`, "animation-timing-function:steps(3,end)!important"),
  rule(`${P} [data-motion="pulse"]`, "animation:ws-poster-blink 1.1s steps(1,end) infinite!important"),
  rule(`${P} [data-motion="slide"]`, "animation-timing-function:steps(6,end)!important"),
  rule(`${P} [data-hover]`, "transition:none!important"),
  rule(`${P} [data-hover] svg`, "transition:none!important;transform:none!important"),
  rule(`${P} [data-hover="lift"]:hover,${P} [data-hover="card"]:hover,${P} [data-hover="raise"]:hover`, "transform:none!important;box-shadow:none!important"),
  rule(`${P} [data-hover="lift"]:hover`, `outline:3px solid ${SIG}!important;outline-offset:-3px!important`),
  rule(`${P} [data-hover="tint"]:hover`, "background-color:var(--ws-surface-muted)!important"),

  // ---------- 工作台外壳：墨黑侧栏、贴条顶栏 ----------
  rule(`${P} [data-testid="content-workspace"]`, "padding:0!important"),
  rule(sel("w-stage"), `border-width:0!important;background-color:${PAPER}!important`),
  rule(sel("w-side"), "border-right-width:0!important;counter-reset:nav"),
  rule(sel("w-glider"), "display:none!important"),
  rule(sel("w-nav"), "min-height:48px!important;margin-left:-14px!important;margin-right:-14px!important;padding-left:22px!important"),
  rule(sel("w-nav", ':not([data-ws~="w-replay"])'), "counter-increment:nav"),
  rule(sel("w-nav", `:not([data-ws~="on"]):hover`), `background-color:${PAPER}!important;${ink(INK)}`),
  rule(sel("w-nav on"), `background-color:${SIG}!important;${ink(INK)}`),
  rule(sel("w-navicon"), "background-color:transparent!important"),
  rule(sel("w-navlabel"), `font-family:${CJK}!important;font-weight:700!important;font-size:14px!important;letter-spacing:.02em!important`),
  rule(`${P} [data-ws~="w-nav"]:not([data-ws~="w-replay"]) [data-ws~="w-navlabel"]::before`, `content:counter(nav,decimal-leading-zero);font:700 11px/1 ${MONO};letter-spacing:.04em;margin-right:8px`),
  rule(sel("w-navcount"), "font-size:11px!important"),
  rule(sel("w-days", " div[dir]"), `font-family:${MONO}!important;text-transform:uppercase;letter-spacing:.04em!important`),
  rule(sel("w-settings"), "min-height:46px!important;border-width:2px!important"),
  rule(sel("w-toggle"), "border-width:2px!important;background-color:transparent!important"),
  rule(sel("w-top"), `height:auto!important;min-height:94px!important;padding-top:14px!important;padding-bottom:14px!important;border-bottom:3px solid ${INK}!important;background-color:${PAPER}!important`),
  rule(sel("w-title"), `${heavy(36)};margin-top:8px!important`),
  rule(sel("w-count"), `${display(44)};color:${SIG}!important;margin-left:6px!important`),
  rule(sel("btn square"), "border-width:3px!important"),
  rule(sel("w-bottom"), "border-top-width:0!important"),

  // ---------- 记录：粗框封面、出血编号 ----------
  rule(sel("w-ghead"), `border-bottom:3px solid ${INK}!important;padding-bottom:16px!important;margin-bottom:22px!important`),
  rule(sel("w-gtitle"), `${heavy(34)};align-self:flex-start!important;background-color:${SIG}!important;padding:2px 8px 4px!important`),
  rule(sel("w-switch"), `${box()};padding:0!important;height:46px!important;background-color:${WHITE}!important`),
  rule(sel("w-switch", ' [aria-selected="true"]'), `background-color:${INK}!important;${ink(PAPER)}`),
  rule(sel("w-switch", " > div"), "height:40px!important;width:44px!important"),
  rule(sel("w-switch", ' > [aria-selected="false"]:hover'), `background-color:${SIG}!important;${ink(INK)}`),
  rule(sel("w-tile"), "margin-bottom:26px!important"),
  rule(sel("w-cover"), `border:3px solid ${INK}!important`),
  rule(sel("w-tile", `:hover [data-ws~="w-cover"]`), `border-color:${SIG}!important`),
  rule(sel("w-disc"), "display:none!important"),
  rule(sel("w-bignum"), `${display(132, 0.84)};opacity:1!important;color:${INK}!important;left:10px!important;top:30px!important;right:auto!important;bottom:auto!important`),
  rule(sel("w-tilebar"), `background-color:${INK}!important;padding:7px 9px!important`),
  rule(sel("w-tiletitle"), `${heavy(14, 1.4, "0")};margin-top:11px!important`),
  rule(sel("w-overlay"), `background-color:transparent!important;border:3px solid ${SIG}!important`),
  rule(sel("w-play"), `border:3px solid ${PAPER}!important;background-color:${INK}!important`),
  rule(sel("w-tileaction"), "border-width:0!important;min-height:36px!important"),
  rule(sel("w-row"), `border-bottom:3px solid ${INK}!important;padding-top:14px!important;padding-bottom:14px!important`),
  rule(sel("w-thumb"), `border:3px solid ${INK}!important`),
  rule(sel("w-rowtitle"), heavy(17, 1.3, "0")),
  rule(sel("w-check"), `border:3px solid ${INK}!important;background-color:${WHITE}!important`),
  rule(sel("w-check on"), `background-color:${SIG}!important;--ws-button-text:${INK}`),
  rule(sel("w-batch"), `border-bottom:3px solid ${INK}!important;background-color:${WHITE}!important`),
  rule(sel("w-emptyicon"), `${box()};background-color:${SIG}!important;${ink(INK)}`),
  rule(sel("w-emptytitle"), `${heavy(30)};margin-top:18px!important`),
  rule(sel("w-emptytitle small"), heavy(20, 1.1)),

  // ---------- 变化线索 ----------
  rule(sel("w-hhead"), `border-bottom:3px solid ${INK}!important`),
  rule(sel("w-htitle"), `${heavy(60, 1)};margin-top:14px!important`),
  rule(sel("w-hcountblock"), `border-left:3px solid ${INK}!important`),
  rule(sel("w-hcount"), `${display(128, 0.84)};color:${SIG}!important`),
  rule(sel("w-card"), `${box()};background-color:${WHITE}!important`),
  rule(sel("w-hvisual"), `border-bottom:3px solid ${INK}!important`),
  rule(sel("w-hvisual", ' [data-ws~="w-bignum"]'), "top:48px!important"),
  rule(sel("w-hvisual", " svg"), "display:none!important"),
  rule(sel("w-hlabel"), `background-color:${SIG}!important;border-width:0!important;min-height:0!important;padding:5px 7px 4px!important`),
  rule(sel("w-hlabeltext"), `font-family:${CJK}!important;font-weight:900!important;font-size:12px!important;color:${INK}!important`),
  rule(sel("w-cardtitle"), heavy(18, 1.25, "-.01em")),
  rule(sel("w-hrule"), `border-top:2px solid ${INK}!important`),
  rule(sel("w-foot"), `border-left:10px solid ${SIG}!important`),

  // ---------- 持续报告大屏：黑框格子、编号戳、巨型数字 ----------
  rule(`${P} [data-testid="report-board"]`, "counter-reset:fig"),
  rule(sel("d-tile"), `${box()};background-color:${WHITE}!important;padding:16px!important;counter-increment:fig`),
  rule(`${P} [data-testid="report-tile-days"],${P} [data-testid="report-tile-boundary"]`, SIG_GROUND),
  rule(`${P} [data-testid="report-tile-events"],${P} [data-testid="report-tile-attention"],${P} [data-testid="report-tile-surprises"]`, INK_GROUND),
  rule(`${P} [data-testid="report-tile-events"],${P} [data-testid="report-tile-attention"],${P} [data-testid="report-tile-surprises"],${P} [data-testid="report-tile-days"],${P} [data-testid="report-tile-boundary"]`, `border-color:${INK}!important`),
  rule(sel("d-head"), "align-items:center!important;padding-bottom:10px!important;border-bottom:3px solid var(--pf)!important;row-gap:6px!important"),
  rule(sel("d-head", "::before"), `content:counter(fig,decimal-leading-zero);font:700 11px/1 ${MONO};letter-spacing:.08em;background:var(--pf);color:var(--pb);padding:5px 6px 4px`),
  rule(sel("d-title"), heavy(18, 1.1, "-.01em")),
  rule(sel("d-en"), `font-family:${MONO}!important;font-weight:700!important;font-size:10px!important;letter-spacing:.1em!important;text-transform:uppercase`),
  rule(sel("d-meta"), `font-family:${MONO}!important;font-size:10px!important;letter-spacing:.04em!important`),
  rule(sel("d-figure"), `${display(88, 0.86)};color:var(--pf)!important;margin-top:6px!important`),
  rule(sel("d-foot"), "border-top:2px solid var(--pf)!important;margin-top:14px!important;padding-top:10px!important"),
  rule(sel("d-mark"), `font-size:0!important;line-height:0!important;width:10px!important;height:10px!important;min-width:10px!important;padding:0!important;margin-top:4px!important;background-color:${SIG}!important`),
  rule(sel("d-mark off"), "background-color:var(--ws-text-muted)!important"),
  rule(sel("d-num"), `font-family:${DISPLAY}!important;font-weight:400!important;letter-spacing:.01em!important;font-size:14px!important`),
  rule(sel("d-num big"), "font-size:24px!important;line-height:1.1!important"),
  rule(sel("d-rank"), `${display(18, 1)};color:${SIG}!important`),
  rule(sel("d-ringvalue"), display(24, 1)),
  rule(sel("d-cell"), `border:2px solid var(--pf)!important;background-color:${PAPER}!important`),
  rule(sel("d-track"), `border:2px solid ${INK}!important;background-color:${PAPER}!important;height:24px!important`),
  rule(sel("d-mosaic"), "border-width:3px!important"),
  rule(sel("d-mosaic dark"), `${ink(PAPER)};border-color:${INK}!important`),
  rule(sel("d-event"), "border-bottom:2px solid var(--pf)!important"),
  rule(sel("d-ititle"), heavy(14, 1.3, "0")),
  // 群点停画后留下的空位：不再是一块像空卡片的实心橙，改成海报里"这里本来就空着"的斜线底
  rule(sel("d-swarm"), `background-color:${PAPER}!important;background-image:repeating-linear-gradient(-45deg,${INK} 0 2px,transparent 2px 13px)!important;cursor:default!important`),
  rule(sel("d-swarm", " canvas"), "display:none!important"),
  rule(sel("d-swarmhint"), "display:none!important"),
  rule(`${P} [data-testid="report-tile-swarm"] svg path`, `stroke:${INK}!important;stroke-width:3px!important`),
  // 曲线：实心橙色面积 + 3px 墨线；峰值点改墨黑方块感的实心点
  rule(["hours", "months", "tail"].map((key) => `${P} [data-testid="report-tile-${key}"] svg path:not([fill="none"])`).join(","), `fill:${SIG}!important;fill-opacity:1!important`),
  rule(["hours", "months", "tail", "daynight"].map((key) => `${P} [data-testid="report-tile-${key}"] svg path[fill="none"]`).join(","), `stroke:${INK}!important;stroke-width:3px!important`),
  rule(["hours", "months"].map((key) => `${P} [data-testid="report-tile-${key}"] svg circle`).join(","), `fill:${INK}!important;r:5px`),
  rule(["completion", "concentration"].map((key) => `${P} [data-testid="report-tile-${key}"] svg circle`).join(","), "stroke-width:10px!important"),
  rule(`${P} [data-testid="report-tile-radar"] svg path`, "stroke-width:1.6px!important"),
  rule(`${P} [data-testid="report-tile-radar"] svg path:last-of-type`, `fill:${SIG}!important;fill-opacity:1!important;stroke:${INK}!important;stroke-width:2.5px!important`),
  // 半透明的橙叠在纸上会发粉：韦恩只留 3px 实线圈
  rule(`${P} [data-testid="report-tile-venn"] svg circle`, "stroke-width:3px!important;stroke-opacity:1!important;fill-opacity:0!important"),
  // 相关矩阵同理：强弱不用透明度，改成实心 / 斜线 / 描边三档，正相关橙、负相关黑
  rule(sel("d-mcell"), "opacity:1!important"),
  rule(sel("d-mcell pos s3"), `background-color:${SIG}!important`),
  rule(sel("d-mcell neg s3"), `background-color:${INK}!important`),
  rule(sel("d-mcell pos s2"), `background-color:${PAPER}!important;background-image:repeating-linear-gradient(-45deg,${SIG} 0 3px,transparent 3px 7px)!important`),
  rule(sel("d-mcell neg s2"), `background-color:${PAPER}!important;background-image:repeating-linear-gradient(-45deg,${INK} 0 3px,transparent 3px 7px)!important`),
  rule(sel("d-mcell pos s1"), `background-color:${PAPER}!important;box-shadow:inset 0 0 0 2px ${SIG}!important`),
  rule(sel("d-mcell neg s1"), `background-color:${PAPER}!important;box-shadow:inset 0 0 0 2px ${INK}!important`),

  // ---------- 聊天 ----------
  rule(sel("c-bar"), "border-bottom-width:0!important"),
  rule(sel("c-list"), `border-right:3px solid ${INK}!important;background-color:${PAPER}!important`),
  rule(sel("c-head"), `border-bottom:3px solid ${INK}!important;min-height:88px!important`),
  rule(sel("c-title"), heavy(36, 1)),
  rule(sel("c-search"), `border:3px solid ${INK}!important;background-color:${WHITE}!important;height:44px!important`),
  rule(sel("c-filters"), `border-bottom:3px solid ${INK}!important;gap:6px!important`),
  rule(sel("c-filter"), `border:2px solid ${INK}!important;height:30px!important`),
  rule(`${sel("c-filter on")},${sel("c-filter", ":hover")}`, `background-color:${INK}!important;${ink(PAPER)}`),
  rule(sel("c-conv"), `border-bottom:2px solid ${INK}!important`),
  rule(sel("c-conv on"), SIG_GROUND),
  rule(sel("c-mark"), "display:none!important"),
  rule(sel("c-name"), heavy(15, 1.2, "0")),
  rule(sel("c-avatar"), `background-color:${INK}!important;border:2px solid ${INK}!important`),
  rule(sel("c-avatar", " div[dir]"), `color:${PAPER}!important;font-family:${CJK}!important;font-weight:900!important`),
  rule(sel("c-avatar", " > svg"), `stroke:${PAPER}!important`),
  rule(sel("c-online"), `background-color:${SIG}!important;border-color:${INK}!important`),
  rule(sel("c-dhead"), `border-bottom:3px solid ${INK}!important;background-color:${PAPER}!important;min-height:88px!important`),
  rule(sel("c-dtitle"), heavy(26, 1.1)),
  rule(sel("c-bubble in"), `background-color:${WHITE}!important;border:2px solid ${INK}!important`),
  rule(sel("c-bubble own"), `background-color:${SIG}!important;border:2px solid ${INK}!important;${ink(INK)}`),
  rule(sel("c-system"), "align-self:center!important"),
  rule(sel("c-composer"), `border-top:3px solid ${INK}!important;background-color:${PAPER}!important`),
  rule(sel("c-input"), `border:3px solid ${INK}!important;background-color:${WHITE}!important`),
  rule(sel("c-send"), `${box()};background-color:${WHITE}!important`),
  rule(sel("c-send on"), `background-color:${SIG}!important`),
  rule(sel("c-send on", " svg"), `stroke:${INK}!important`),
  rule(sel("c-fact"), `${box()};background-color:${WHITE}!important;align-items:flex-start!important;padding:12px 14px!important;min-height:92px!important`),
  rule(sel("c-factvalue"), display(44)),
  rule(sel("c-sparklist"), `${box()};background-color:${WHITE}!important`),
  rule(sel("c-sectiontitle"), heavy(16, 1.2, "0")),
  rule(sel("c-sparkdays"), display(30, 1)),
  rule(sel("c-badge"), "padding:3px 4px 2px!important;font-size:9px!important"),

  // ---------- 探索 ----------
  rule(sel("e-title"), `${heavy(64, 1)};margin-top:18px!important`),
  rule(sel("e-sub"), `font-family:${CJK}!important;font-weight:500!important;font-size:15px!important;color:${INK}!important;margin-top:-4px!important`),
  rule(sel("e-panel"), `${box()};background-color:${WHITE}!important`),
  rule(sel("e-tabs"), `border-bottom:3px solid ${INK}!important;padding-left:0!important;gap:0!important`),
  rule(sel("e-tab"), `padding-left:16px!important;padding-right:16px!important;border-bottom-width:0!important;border-right:3px solid ${INK}!important`),
  rule(sel("e-tab on"), `background-color:${INK}!important;${ink(PAPER)}`),
  rule(sel("e-tab", `:not([data-ws~="on"]):hover`), `background-color:${SIG}!important;${ink(INK)}`),
  rule(sel("e-tab", " div[dir]"), "font-weight:700!important"),
  rule(sel("e-empty"), `${SIG_GROUND};border:3px solid ${INK}!important`),
  rule(sel("e-box"), `${box()};background-color:${WHITE}!important`),
  rule(sel("e-name"), heavy(26, 1.15, "-.01em")),
  rule(sel("e-name small"), heavy(18, 1.2, "0")),
  rule(sel("e-section"), heavy(20, 1.2, "-.01em")),
  rule(sel("e-badge"), "padding:4px 6px 3px!important"),

  // ---------- 窄屏：大字收一档，别把顶栏标题挤成省略号 ----------
  "@media (max-width:719px){" + [
    rule(sel("w-top"), "min-height:72px!important;padding-top:10px!important;padding-bottom:10px!important"),
    rule(sel("w-title"), "font-size:22px!important;margin-top:6px!important"),
    rule(sel("w-count"), "font-size:24px!important;margin-left:2px!important"),
    rule(sel("btn square"), "width:40px!important;height:40px!important"),
    rule(sel("e-title"), "font-size:36px!important"),
    rule(sel("w-htitle"), "font-size:36px!important"),
    rule(sel("w-hcount"), "font-size:72px!important"),
  ].join("") + "}",

  // 列表项、选项、页签按下时同样一记信号橙；放最后，压过前面各自的悬停色
  rule(sel("w-nav,s-opt,c-filter,c-conv,e-tab,w-row,d-event", `${notDisabled}:active`), `background-color:${SIG}!important;opacity:1!important;${ink(INK)}`),
];

export const posterCss = blocks.join("\n");
