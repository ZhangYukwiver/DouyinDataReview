/**
 * 档案馆风格的版式层：只挂在 :root[data-style="archive"] 下，海报和内容年志一条也匹配不到。
 * 色相与质感取自参考色块图（与 /story/story-archive.html 同一套）：新闻纸、墨黑、信号橙、灰纸、橙块里的锈褐字、
 * 4px 墨线、-45° 斜线（只给真的"没有数据"的地方用，而且一定写明缺的是什么）、OBSERVED 橙底戳 / PENDING 空心戳、方块项目符号。
 * 构图是卷宗柜，不是海报：墨黑桌面上摊开一份卷宗，左边灰纸索引栏，卡片顶上一条墨带（编号 + 宋体 900 标题），
 * 数字用 Archivo 压窄 900，戳用 Space Mono，台账用双横线，悬停时卡片从一摞里抽出来（硬投影）。
 * 组件上的 data-ws 角色与另两种风格共用（见 motion.tsx 的 ws / fx）；RN-web 的原子类要压过，所以版式声明一律 !important。
 */
const A = ':root[data-style="archive"]';
const INK = "#0A0A0A";
const PAPER = "#F2EEE6";
const PAPER2 = "#E9E4D9";
const WHITE = "#FFFFFF";
const SIG = "#FF4A1D";
const ASH = "#A9A397";
const RUST = "#3D1408";
const MUTE = "#6E6960";
const ASH_MUTE = "#3F3C36";
const LEDGER = "#C9C3B6";
const SERIF = "'Noto Serif SC', 'Songti SC', 'STSong', serif";
const NUM = "Archivo, 'Noto Sans SC', 'PingFang SC', sans-serif";
const SANS = "'Noto Sans SC', 'PingFang SC', 'Helvetica Neue', sans-serif";
const MONO = "'Space Mono', 'Noto Sans SC', 'PingFang SC', monospace";
/** 斜线底：只给"这里还没有东西"的块，块里必须有字说明缺什么。 */
const HATCH = `repeating-linear-gradient(-45deg,${INK} 0 2px,transparent 2px 15px)`;

/** 选中带某个角色的元素；"a b" 表示同一元素同时带 a 和 b。多个用逗号分开。 */
function sel(roles: string, suffix = ""): string {
  return roles.split(",").map((group) => `${A} ${group.trim().split(/\s+/u).map((role) => `[data-ws~="${role}"]`).join("")}${suffix}`).join(",");
}
const rule = (selector: string, body: string) => `${selector}{${body}}`;
const tile = (key: string, suffix = "") => `${A} [data-testid="report-tile-${key}"]${suffix}`;

/** 前景色一换，块里所有用 token 的字、线、图标跟着换。 */
function ink(fg: string, muted = fg): string {
  return [
    `--ws-text:${fg}`, `--ws-text-secondary:${fg}`, `--ws-text-muted:${muted}`, `--ws-figure:${fg}`,
    `--ws-accent:${fg}`, `--ws-cyan:${fg}`, `--ws-green:${fg}`, `--ws-amber:${fg}`, `--ws-signal:${fg}`,
    `--ws-button-text:${fg}`, `--ws-white:${fg}`, `--ws-black:${fg}`, `--ws-border:${fg}`, `--ws-border-soft:${fg}`, `--ws-frame:${fg}`,
    `color:${fg}`,
  ].join(";");
}

/** 一块底色：前景 / 背景 / 弱化字 / 强调色。--af / --ab 给描边、墨带、戳用。 */
function ground(fg: string, bg: string, muted: string, accent: string): string {
  return [
    `--af:${fg}`, `--ab:${bg}`,
    `--ws-canvas:${bg}`, `--ws-sidebar:${bg}`, `--ws-surface:${bg}`,
    `--ws-text:${fg}`, `--ws-text-secondary:${fg}`, `--ws-text-muted:${muted}`, `--ws-figure:${fg}`,
    `--ws-border:${fg}`, `--ws-border-soft:${fg}`, `--ws-frame:${fg}`,
    `--ws-accent:${accent}`, `--ws-amber:${accent}`, `--ws-signal:${accent}`, `--ws-cyan:${fg}`, `--ws-green:${fg}`,
    `--ws-button:${fg}`, `--ws-button-text:${bg}`, `--ws-white:${fg}`, `--ws-danger:${accent}`,
    `background-color:${bg}!important`, `color:${fg}`,
  ].join(";");
}
const INK_GROUND = ground(PAPER, INK, ASH, SIG);
const SIG_GROUND = ground(INK, SIG, RUST, INK);
const ASH_GROUND = ground(INK, ASH, ASH_MUTE, INK);
const PAPER_GROUND = ground(INK, PAPER, MUTE, SIG);

// 宋体 900 标题
const serif = (size: number, line = 1.12, track = "-.01em") => `font-family:${SERIF}!important;font-weight:900!important;font-size:${size}px!important;line-height:${line}!important;letter-spacing:${track}!important`;
// Archivo 压窄 900 数字
const num = (size: number, line = 0.86) => `font-family:${NUM}!important;font-weight:900!important;font-stretch:62%!important;font-variation-settings:"wdth" 62!important;font-size:${size}px!important;line-height:${line}!important;letter-spacing:-.01em!important;font-variant-numeric:lining-nums tabular-nums!important`;
// Space Mono 打字机戳
const mono = (size = 10, track = ".12em", weight = 700) => `font-family:${MONO}!important;font-weight:${weight}!important;font-size:${size}px!important;letter-spacing:${track}!important;text-transform:uppercase`;
const frame = (width = 2, tone = INK) => `border:${width}px solid ${tone}!important;border-radius:0!important`;
// 卡片从一摞里抽出来：往左上挪一点，身后留一块墨黑硬投影
const LIFT = `transform:translate(-3px,-3px)!important;box-shadow:6px 6px 0 ${INK}!important`;
const notDisabled = ':not([aria-disabled="true"])';

/** 采集器页只有一套自己的样式，全局规则跳过它。 */
const NOT_SETUP = ':not([data-testid="setup-workspace"] *)';

const blocks: string[] = [
  // ---------- 底子：零圆角零阴影，墨黑桌面上摊开一份新闻纸卷宗 ----------
  rule(A, `--af:${INK};--ab:${PAPER};--ws-swarm:off`),
  rule(`${A} *${NOT_SETUP}`, "border-radius:0!important;box-shadow:none!important;text-shadow:none!important"),
  rule(`${A} ${NOT_SETUP}::selection`, `background:${SIG};color:${INK}`),
  rule(`${A} :focus-visible${NOT_SETUP}`, `outline:3px solid ${SIG}!important;outline-offset:2px!important`),
  rule(`${A} input${NOT_SETUP},${A} textarea${NOT_SETUP}`, `caret-color:${SIG}`),
  rule(`${A} input${NOT_SETUP}::placeholder,${A} textarea${NOT_SETUP}::placeholder`, `color:${MUTE}!important`),
  rule(sel("g-ink"), INK_GROUND),
  rule(sel("g-sig"), SIG_GROUND),

  // ---------- 字：戳、项目符号、台账线 ----------
  rule(sel("mono"), `font-family:${MONO}!important;font-weight:400!important;text-transform:uppercase;letter-spacing:.04em!important`),
  rule(sel("stamp,stamp-sig,stamp-ghost"), `display:flex;align-self:flex-start!important;flex-direction:row;align-items:center;gap:6px;${mono(10, ".14em")};line-height:1!important;padding:5px 7px 4px!important;white-space:nowrap;border-width:0!important;min-height:0!important;height:auto!important`),
  // 墨底戳 / OBSERVED 橙底墨字 / PENDING 空心描边
  rule(sel("stamp"), `background-color:var(--af)!important;${ink("var(--ab)")};color:var(--ab)!important`),
  rule(sel("stamp-sig"), `background-color:${SIG}!important;${ink(INK)};color:${INK}!important`),
  rule(sel("stamp-ghost"), `background-color:transparent!important;border:2px solid var(--af)!important;padding:3px 5px 2px!important;${ink("var(--af)")};color:var(--af)!important`),
  rule(sel("stamp-bar"), `${SIG_GROUND};border-width:0!important;border-left:6px solid ${INK}!important;margin-left:0!important;margin-right:0!important`),
  rule(sel("stamp-bar", " div[dir]"), "font-weight:700!important"),
  rule(sel("stamp-bar", ' [data-ws~="stamp"]'), `background-color:${INK}!important;color:${SIG}!important`),
  rule(sel("dot"), `width:9px!important;height:9px!important;background-color:${ASH}!important`),
  rule(sel("dot on"), `background-color:${SIG}!important`),
  rule(sel("rule-t"), "border-top:4px solid var(--af)!important"),

  // ---------- 按钮：2px 墨线；悬停信号橙，按下反相 ----------
  rule(sel("btn,btn-solid,btn-sig"), "border-radius:0!important;border-style:solid!important;border-width:2px!important"),
  rule(sel("btn,btn-solid,btn-sig", " div[dir]"), `font-family:${SANS}!important;font-weight:700!important;letter-spacing:.04em!important`),
  rule(sel("btn"), `background-color:transparent!important;border-color:var(--af)!important;${ink("var(--af)")}`),
  rule(sel("btn", `${notDisabled}:hover`), `background-color:${SIG}!important;border-color:${INK}!important;${ink(INK)}`),
  rule(sel("btn on"), `background-color:${INK}!important;border-color:${INK}!important;${ink(PAPER)}`),
  rule(sel("btn-solid"), `background-color:var(--af)!important;border-color:var(--af)!important;${ink("var(--ab)")}`),
  rule(sel("btn-solid", `${notDisabled}:hover`), `background-color:${SIG}!important;border-color:${INK}!important;${ink(INK)}`),
  rule(sel("btn-sig"), `background-color:${SIG}!important;border-color:${INK}!important;${ink(INK)}`),
  rule(sel("btn-sig", `${notDisabled}:hover`), `background-color:${INK}!important;border-color:${INK}!important;${ink(PAPER)}`),
  rule(sel("btn,btn-solid,btn-sig", `${notDisabled}:active`), `background-color:${INK}!important;border-color:${INK}!important;opacity:1!important;${ink(SIG)}`),
  // 不可点：原来靠 opacity 压成一块冷灰、白字发虚；改成灰白纸上的虚线空框，字用弱墨色，仍看得清
  rule(sel("btn,btn-solid,btn-sig", '[aria-disabled="true"]'), `opacity:1!important;background-color:${PAPER2}!important;border-style:dashed!important;border-color:${MUTE}!important;${ink(MUTE)}`),

  // ---------- 动效：进场照旧；悬停不浮起，改成从一摞里抽出来 ----------
  "@keyframes ws-archive-blink{0%,49%{opacity:1}50%,100%{opacity:.25}}",
  rule(`${A} [data-motion="pulse"]`, "animation:ws-archive-blink 1.2s steps(1,end) infinite!important"),
  rule(`${A} [data-hover] svg`, "transform:none!important"),
  rule(`${A} [data-hover="lift"]:hover,${A} [data-hover="card"]:hover`, LIFT),
  // 记录格子本身没有外框，抽出来只会拖出一块黑影；它只把封面框换成信号橙
  rule(sel("w-tile", ":hover"), "transform:none!important;box-shadow:none!important"),
  rule(`${A} [data-hover="raise"]:hover`, "transform:none!important"),
  rule(`${A} [data-hover="tint"]:hover`, `background-color:${PAPER2}!important`),

  // ---------- 工作台外壳：墨黑桌面、灰纸索引栏、宋体卷名 ----------
  rule(`${A} [data-testid="content-workspace"]`, `background-color:${INK}!important`),
  rule(sel("w-stage"), `border:0!important;background-color:${PAPER}!important`),
  // 纸纹留着当新闻纸的颗粒；原来压暗纸面的那层与四角框线不要
  rule(sel("w-grain"), "opacity:.22!important;mix-blend-mode:multiply"),
  rule(sel("w-tint,w-corners"), "display:none!important"),
  rule(sel("w-side"), `${ASH_GROUND};border-right:4px solid ${INK}!important`),
  rule(sel("w-glider"), "display:none!important"),
  rule(sel("w-nav"), `min-height:50px!important;margin-left:-14px!important;margin-right:-14px!important;padding-left:22px!important;border-bottom:1px solid rgba(10,10,10,.28)!important`),
  rule(sel("w-nav", `:not([data-ws~="on"]):hover`), `background-color:#BDB7AA!important`),
  // 抽出来的那一格：墨带，左边一道橙色索引
  rule(sel("w-nav on"), `${INK_GROUND};border-left:6px solid ${SIG}!important;padding-left:16px!important`),
  rule(sel("w-navicon"), "background-color:transparent!important"),
  rule(sel("w-navlabel"), `${serif(15, 1.2, ".04em")}`),
  rule(sel("w-navcount"), `${num(17, 1)};letter-spacing:.01em!important;text-transform:none`),
  rule(sel("w-nav on", ' [data-ws~="w-navcount"]'), `color:${SIG}!important`),
  rule(sel("w-replay"), "border-bottom-width:0!important"),
  // 浅轨 + 墨弧在收起的侧栏里只剩一个圈，看着像加载转圈；改成墨轨 + 橙弧的刻度盘
  rule(sel("w-days"), `--ws-border:${INK};--ws-cyan:${SIG}`),
  rule(sel("w-days", " div[dir]"), `font-family:${MONO}!important;font-size:9.5px!important;letter-spacing:.02em!important;color:${ASH_MUTE}!important`),
  rule(sel("w-settings"), "min-height:46px!important"),
  rule(sel("w-toggle"), `background-color:${ASH}!important;${ink(INK)}`),
  rule(sel("w-toggle", `:hover`), `background-color:${SIG}!important`),
  // g-ink 把 --af 换成了纸色，2px 边框和纸底同色，钮看着像索引栏上缺了一块；和顶栏的图标钮一样上墨框
  rule(sel("btn square w-toggle"), `border-color:${INK}!important;${ink(INK)}`),

  // 顶栏：卷名 + 卷号，下面一道 4px 墨线
  rule(sel("w-top"), `height:auto!important;min-height:92px!important;padding-top:14px!important;padding-bottom:14px!important;border-bottom:4px solid ${INK}!important;background-color:${PAPER}!important`),
  rule(sel("w-top", ' [data-ws~="stamp-sig"]'), `background-color:${INK}!important;color:${PAPER}!important;padding-left:18px!important;background-image:linear-gradient(${SIG},${SIG})!important;background-size:7px 7px!important;background-position:6px 50%!important;background-repeat:no-repeat!important`),
  rule(sel("w-title"), `${serif(34, 1.12)};margin-top:8px!important`),
  rule(sel("w-count"), `${num(40, 1)};color:${INK}!important;margin-left:10px!important`),
  // NO. 做成橙底墨字的小索引签（橙字直接压在纸上太细，看不清）
  rule(sel("w-count", "::before"), `content:"NO.";font-family:${MONO};font-weight:700;font-size:10px;line-height:1;letter-spacing:.08em;font-stretch:100%;font-variation-settings:normal;margin-right:6px;padding:3px 3px 2px 4px;vertical-align:1.3em;background:${SIG};color:${INK}`),
  rule(sel("btn square"), `background-color:${PAPER}!important`),
  rule(sel("btn square on"), `background-color:${INK}!important`),
  rule(sel("btn square", `${notDisabled}:hover`), `background-color:${SIG}!important`),

  // ---------- 记录：卷宗卡片、文件标签编号 ----------
  rule(sel("w-ghead"), `border-bottom:4px solid ${INK}!important;padding-bottom:14px!important;margin-bottom:24px!important`),
  rule(sel("w-gtitle"), serif(32, 1.1)),
  rule(sel("w-gtitle", "::before"), `content:"";display:inline-block;width:.42em;height:.42em;background:${SIG};margin-right:.3em;vertical-align:.12em`),
  rule(sel("w-switch"), `${frame()};padding:0!important;height:44px!important;background-color:${WHITE}!important`),
  rule(sel("w-switch", " > div"), "height:40px!important;width:44px!important"),
  rule(sel("w-lay on"), `background-color:${INK}!important;${ink(PAPER)}`),
  rule(sel("w-lay", ':not([data-ws~="on"]):hover'), `background-color:${SIG}!important;${ink(INK)}`),
  rule(sel("w-tile"), `margin-bottom:26px!important;border-bottom:1px solid ${INK}!important;padding-bottom:6px!important`),
  rule(sel("w-cover"), frame()),
  rule(sel("w-tile", `:hover [data-ws~="w-cover"]`), `border-color:${SIG}!important`),
  rule(sel("w-disc"), "display:none!important"),
  // 没有封面时：色块上贴一张文件标签，写编号和"无封面"
  rule(sel("w-bignum"), `${num(46, 0.9)};opacity:1!important;color:${INK}!important;background-color:${WHITE}!important;border:2px solid ${INK}!important;left:10px!important;right:auto!important;top:auto!important;bottom:48px!important;padding:6px 9px 4px!important`),
  rule(sel("w-bignum", "::before"), `content:"NO.";display:block;width:fit-content;font-family:${MONO};font-weight:700;font-size:9px;line-height:1;letter-spacing:.1em;font-stretch:100%;font-variation-settings:normal;background:${SIG};color:${INK};padding:2px 3px 1px 4px;margin-bottom:4px`),
  rule(sel("w-bignum", "::after"), `content:"无封面";display:block;font-family:${SANS};font-weight:700;font-size:9px;line-height:1;letter-spacing:.1em;font-stretch:100%;font-variation-settings:normal;color:${MUTE};margin-top:5px`),
  rule(sel("w-tilebar"), `${INK_GROUND};--ws-accent:${SIG};--ws-amber:${SIG};--ws-cyan:${SIG};padding:8px 9px 7px!important`),
  rule(sel("w-tiletitle"), `${serif(14, 1.42, "0")};margin-top:10px!important`),
  // 悬停时两颗按钮落在底条上，底条的"▶ 记录"会从按钮之间露出半截：按钮底下垫一条墨带把它盖住
  rule(sel("w-overlay"), `background-color:transparent!important;background-image:linear-gradient(to top,${INK} 58px,transparent 58px)!important;border:4px solid ${SIG}!important`),
  // 类型小方块：描一圈墨线，落在橙色底上也看得见；多选时勾选框压在它上面只露一角，藏起来
  // （用 visibility 不用 display:none：它和时长戳是 space-between 的一对，拿掉它时长戳会滑到左边被勾选框压住）
  rule(sel("w-type"), `width:10px!important;height:10px!important;border:2px solid ${INK}!important`),
  rule(sel("w-cover", ':has([data-ws~="w-check"]) [data-ws~="w-type"]'), "visibility:hidden!important"),
  rule(sel("w-play"), `border:2px solid ${INK}!important;background-color:${SIG}!important;${ink(INK)}`),
  rule(sel("w-tileaction"), "min-height:34px!important"),
  rule(sel("w-row"), `border-bottom:1px solid ${INK}!important;padding-top:14px!important;padding-bottom:14px!important`),
  rule(sel("w-thumb"), frame()),
  // lucide 的描边写在每条 path 的属性上，要连子元素一起压
  rule(`${sel("w-thumb", " svg")},${sel("w-thumb", " svg *")}`, `stroke:${INK}!important`),
  rule(sel("w-rowtitle"), serif(16, 1.35, "0")),
  rule(sel("w-check"), `${frame()};background-color:${WHITE}!important`),
  rule(sel("w-check on"), `background-color:${SIG}!important;--ws-button-text:${INK}`),
  // 不能选的记录：原来勾选框被压成半透明，封面透上来一片糊；改成和不可点按钮一样的虚线空框
  rule(`${A} [aria-disabled="true"] [data-ws~="w-check"]`, `opacity:1!important;background-color:${PAPER2}!important;border-style:dashed!important;border-color:${MUTE}!important`),
  rule(sel("w-batch"), `border-bottom:2px solid ${INK}!important;background-color:${WHITE}!important`),
  rule(sel("w-emptyicon"), `${frame()};background-color:${INK}!important;${ink(PAPER)}`),
  rule(sel("w-emptytitle"), `${serif(28, 1.15)};margin-top:18px!important`),
  rule(sel("w-emptytitle small"), serif(20, 1.2)),

  // ---------- 变化线索：卷宗夹，顶上一枚橙色索引标签 ----------
  rule(sel("w-hhead"), `border-bottom:4px solid ${INK}!important`),
  rule(sel("w-htitle"), `${serif(54, 1.06)};margin-top:14px!important`),
  rule(sel("w-hcountblock"), `${SIG_GROUND};border-left:0!important;padding:14px 18px 12px!important;width:200px!important`),
  rule(sel("w-hcountblock", " div[dir]"), `color:${RUST}!important;font-family:${SANS}!important;font-weight:700!important`),
  // 上一条的 div[dir] 更具体，会把大数字也染成锈褐；数字要墨黑，得写得比它更具体
  rule(sel("w-hcountblock", ' [data-ws~="w-hcount"][dir]'), `${num(112, 0.82)};color:${INK}!important`),
  rule(sel("w-card"), `${frame()};border-top-width:2px!important;background-color:${PAPER}!important`),
  rule(sel("w-hvisual"), `border-bottom:2px solid ${INK}!important`),
  rule(sel("w-hvisual", " svg"), "display:none!important"),
  rule(sel("w-hvisual", ' [data-ws~="w-bignum"]'), "bottom:14px!important"),
  rule(sel("w-card void", ' [data-ws~="w-hvisual"]'), `background-color:${PAPER2}!important;background-image:${HATCH}!important`),
  rule(sel("w-card void", ' [data-ws~="w-bignum"]::after'), `content:"没有对应记录"`),
  rule(sel("w-hlabel"), `background-color:${SIG}!important;border-width:0!important;border-right:2px solid ${INK}!important;border-bottom:2px solid ${INK}!important;top:0!important;left:0!important;min-height:0!important;padding:7px 10px 6px!important`),
  rule(sel("w-hlabeltext"), `font-family:${SANS}!important;font-weight:900!important;font-size:12px!important;letter-spacing:.06em!important;color:${INK}!important`),
  rule(sel("w-cardtitle"), serif(18, 1.3, "0")),
  rule(sel("w-hrule"), `border-top:6px double ${INK}!important`),
  // 章节提示（比如"N 条记录没进时间图表"）：原来是 9px 信号橙字压在纸上，看不清；改墨字，前面一颗橙方块
  rule(sel("w-notice"), `font-family:${SANS}!important;font-weight:700!important;font-size:11px!important;line-height:1.6!important;color:${INK}!important;border-top:1px solid ${INK}!important`),
  rule(sel("w-notice", "::before"), `content:"";display:inline-block;width:8px;height:8px;background:${SIG};margin-right:7px`),
  rule(sel("w-foot"), `${ASH_GROUND};border-left:6px solid ${INK}!important`),

  // ---------- 持续报告：卷宗卡片，墨带卡头 + 编号，台账双横线 ----------
  rule(`${A} [data-testid="report-board"]`, "counter-reset:fig"),
  rule(sel("d-tile"), `${frame(2, "var(--af)")};background-color:var(--ab)!important;padding:0 14px 14px!important;counter-increment:fig`),
  rule(`${tile("attention")},${tile("surprises")}`, INK_GROUND),
  rule(tile("days"), SIG_GROUND),
  rule(tile("boundary"), ASH_GROUND),
  rule(`${tile("attention")},${tile("surprises")},${tile("days")},${tile("boundary")}`, `border-color:${INK}!important`),
  // 卡头：一条通栏墨带；墨黑的卡换成橙带
  rule(sel("d-head"), `${INK_GROUND};align-items:baseline!important;margin:0 -14px 14px!important;padding:9px 14px 8px!important;row-gap:4px!important`),
  rule(`${tile("attention", ' [data-ws~="d-head"]')},${tile("surprises", ' [data-ws~="d-head"]')}`, SIG_GROUND),
  rule(sel("d-head", "::before"), `content:counter(fig,decimal-leading-zero);font-family:${NUM};font-weight:900;font-stretch:62%;font-variation-settings:"wdth" 62;font-size:20px;line-height:1;color:var(--ws-accent);margin-right:2px`),
  rule(sel("d-title"), serif(16, 1.2, ".02em")),
  rule(sel("d-en"), `${mono(9.5, ".12em")};color:var(--ws-text-muted)!important`),
  rule(sel("d-meta"), `${mono(9.5, ".04em", 400)};color:var(--ws-text-muted)!important`),
  rule(sel("d-figure"), `${num(92, 0.8)};color:var(--ws-figure)!important;margin-top:6px!important`),
  // 大数字旁边的小字做成一枚歪着盖上去的空心戳；观测事件那一格是 OBSERVED 橙底戳
  rule(sel("d-figure", ' + [data-ws~="mono"]'), `${mono(10, ".14em")};border:2px solid var(--ws-text)!important;padding:5px 7px 4px!important;transform:rotate(-4deg);align-self:flex-end!important;margin-bottom:6px!important;color:var(--ws-text)!important;flex-shrink:0!important`),
  rule(tile("events", ' [data-ws~="d-figure"] + [data-ws~="mono"]'), `background-color:${SIG}!important;border-color:${SIG}!important;color:${INK}!important`),
  rule(sel("d-foot"), `border-top:6px double var(--af)!important;margin-top:14px!important;padding-top:10px!important`),
  rule(sel("d-mark"), `font-size:0!important;line-height:0!important;width:9px!important;height:9px!important;min-width:9px!important;padding:0!important;margin-top:5px!important;background-color:${SIG}!important`),
  rule(sel("d-mark off"), `background-color:${ASH}!important`),
  rule(`${tile("days", ' [data-ws~="d-mark"]')}`, `background-color:${INK}!important`),
  rule(sel("d-num"), `${num(16, 1.1)};color:var(--ws-text)!important`),
  rule(sel("d-num big"), `font-size:26px!important;line-height:1!important`),
  rule(sel("d-rank"), `${num(18, 1)};color:${SIG}!important`),
  rule(sel("d-ringvalue"), num(30, 1)),
  rule(sel("d-tile", " svg text"), `font-family:${SANS}!important;font-weight:700!important`),
  rule(sel("d-cell"), `background-color:${WHITE}!important;border-left:4px solid ${INK}!important`),
  rule(sel("d-track"), `${frame()};background-color:${WHITE}!important;height:22px!important`),
  // 每块都描墨边：dark 那块的 ink() 会把 --ws-border 换成纸色（看着像缩了一圈），最大那块原来描的是和底同色的橙边
  rule(sel("d-mosaic"), `border-width:2px!important;border-color:${INK}!important`),
  rule(sel("d-mosaic dark"), `${ink(PAPER, ASH)}`),
  rule(sel("d-event"), `border-bottom:1px solid ${LEDGER}!important`),
  rule(sel("d-ititle"), serif(13.5, 1.35, "0")),
  // 真的没有数据的地方：斜线底，上面贴一张写明缺什么的纸条
  rule(sel("d-empty"), `align-self:stretch!important;text-align:center!important;color:${INK}!important;background-color:${PAPER2}!important;background-image:linear-gradient(${PAPER},${PAPER}),${HATCH}!important;background-clip:content-box,padding-box!important;padding:22px 14px!important;border:2px solid ${INK}!important`),
  // 群点在档案馆里不画；剩下的补位块只是一块空白，看着像没加载出来的组件：整块不要
  rule(`${A} [data-testid="report-tile-swarm"]`, "display:none!important"),
  // 曲线：灰纸面积 + 2px 墨线，峰值一颗橙点
  rule(["hours", "months", "tail", "daynight"].map((key) => tile(key, ' svg path:not([fill="none"])')).join(","), `fill:#D9D3C7!important;fill-opacity:1!important`),
  rule(["hours", "months", "tail", "daynight"].map((key) => tile(key, ' svg path[fill="none"]')).join(","), `stroke:${INK}!important;stroke-width:2px!important`),
  rule(tile("daynight", ' svg path[stroke-dasharray="4 3"]'), `stroke:${SIG}!important;stroke-width:2.5px!important`),
  rule(["hours", "months"].map((key) => tile(key, " svg circle")).join(","), `fill:${SIG}!important;stroke:${INK};stroke-width:2px;r:5px`),
  rule(["completion", "concentration"].map((key) => tile(key, " svg circle")).join(","), "stroke-width:12px!important"),
  rule(tile("radar", " svg path"), `stroke:${INK}!important;stroke-opacity:.35`),
  rule(tile("radar", " svg path:last-of-type"), `fill:${ASH}!important;fill-opacity:.9!important;stroke:${INK}!important;stroke-opacity:1;stroke-width:2px!important`),
  rule(tile("venn", " svg circle"), "stroke-width:2.5px!important;stroke-opacity:1!important;fill-opacity:0!important"),
  // 相关矩阵：强弱不用透明度（橙色一透就发粉），改成格子里方块的大小，正相关橙、负相关墨
  rule(sel("d-mcell"), "opacity:1!important"),
  rule(sel("d-mcell pos s3"), `background:${SIG}!important`),
  rule(sel("d-mcell neg s3"), `background:${INK}!important`),
  rule(sel("d-mcell pos s2"), `background:linear-gradient(${SIG},${SIG}) center/58% 58% no-repeat,${WHITE}!important`),
  rule(sel("d-mcell neg s2"), `background:linear-gradient(${INK},${INK}) center/58% 58% no-repeat,${WHITE}!important`),
  rule(sel("d-mcell pos s1"), `background:linear-gradient(${SIG},${SIG}) center/26% 26% no-repeat,${WHITE}!important`),
  rule(sel("d-mcell neg s1"), `background:linear-gradient(${INK},${INK}) center/26% 26% no-repeat,${WHITE}!important`),
  // 对角线是自己和自己，白格看着像"零相关"：台账里的做法，划一道斜杠表示此格不计
  rule(sel("d-mcell self"), `background:linear-gradient(to top right,transparent calc(50% - 1px),${INK} calc(50% - 1px) calc(50% + 1px),transparent calc(50% + 1px)),${PAPER2}!important;border-width:0!important`),
  // 样本不够算不出来的格子：原来是一块没字的灰；白格里写一道"—"
  rule(sel("d-mcell nil"), `background:${WHITE}!important;align-items:center!important;justify-content:center!important`),
  rule(sel("d-mcell nil", "::after"), `content:"—";font-family:${NUM};font-weight:900;font-size:12px;line-height:1;color:${MUTE}`),

  // ---------- 聊天：灰白索引栏 + 新闻纸正文 ----------
  rule(sel("c-bar"), `${PAPER_GROUND};background-color:${PAPER2}!important;border-bottom:2px solid ${INK}!important`),
  rule(sel("c-list"), `border-right:4px solid ${INK}!important;background-color:${PAPER2}!important`),
  rule(sel("c-head"), `border-bottom:2px solid ${INK}!important;min-height:86px!important`),
  rule(sel("c-title"), serif(32, 1)),
  rule(sel("c-search"), `${frame()};background-color:${WHITE}!important;height:42px!important`),
  rule(sel("c-filters"), `border-bottom:2px solid ${INK}!important;gap:6px!important`),
  rule(sel("c-filter"), `${frame()};height:30px!important;background-color:${PAPER}!important`),
  rule(sel("c-filter", " div[dir]"), `font-family:${SANS}!important;font-weight:700!important`),
  rule(`${sel("c-filter on")},${sel("c-filter", ":hover")}`, `background-color:${INK}!important;${ink(PAPER)}`),
  rule(sel("c-conv"), `border-bottom:1px solid ${ASH}!important`),
  // 橙条用内阴影画：左边框会把整行内容往右推 6px，和没选中的行对不齐
  rule(sel("c-conv on"), `background-color:${PAPER}!important;box-shadow:inset 6px 0 0 ${SIG}!important`),
  rule(sel("c-mark"), "display:none!important"),
  rule(sel("c-name"), serif(15, 1.25, "0")),
  rule(sel("c-avatar"), `background-color:${INK}!important;border:0!important`),
  rule(sel("c-avatar", " div[dir]"), `color:${PAPER}!important;font-family:${SERIF}!important;font-weight:900!important`),
  rule(`${sel("c-avatar", " svg")},${sel("c-avatar", " svg *")}`, `stroke:${PAPER}!important`),
  rule(sel("c-conv on", ' [data-ws~="c-avatar"]'), `background-color:${SIG}!important`),
  rule(sel("c-conv on", ' [data-ws~="c-avatar"] div[dir]'), `color:${INK}!important`),
  rule(`${sel("c-conv on", ' [data-ws~="c-avatar"] svg')},${sel("c-conv on", ' [data-ws~="c-avatar"] svg *')}`, `stroke:${INK}!important`),
  rule(sel("c-online"), `background-color:${SIG}!important;border-color:${INK}!important`),
  rule(sel("c-dhead"), `border-bottom:4px solid ${INK}!important;background-color:${PAPER}!important;min-height:86px!important`),
  rule(sel("c-dtitle"), serif(26, 1.1)),
  rule(sel("c-bubble in"), `background-color:${WHITE}!important;${frame()}`),
  rule(sel("c-bubble own"), `background-color:${INK}!important;border:2px solid ${INK}!important;${ink(PAPER, ASH)}`),
  rule(sel("c-system"), "align-self:center!important"),
  rule(sel("c-composer"), `border-top:2px solid ${INK}!important;background-color:${PAPER2}!important`),
  rule(sel("c-input"), `${frame()};background-color:${WHITE}!important`),
  rule(sel("c-send"), `${frame()};background-color:${WHITE}!important`),
  rule(sel("c-send on"), `background-color:${SIG}!important`),
  rule(`${sel("c-send on", " svg")},${sel("c-send on", " svg *")}`, `stroke:${INK}!important`),
  rule(sel("c-fact"), `${frame()};background-color:${WHITE}!important;align-items:flex-start!important;padding:12px 14px!important;min-height:92px!important`),
  rule(sel("c-factvalue"), num(46, 0.9)),
  rule(sel("c-sparklist"), `${frame()};background-color:${WHITE}!important`),
  rule(sel("c-sectiontitle"), serif(16, 1.2, "0")),
  rule(sel("c-sparkdays"), num(30, 1)),
  rule(sel("c-badge"), "padding:3px 4px 2px!important;font-size:9px!important"),

  // ---------- 探索 ----------
  rule(sel("e-title"), `${serif(56, 1.08)};margin-top:18px!important`),
  rule(sel("e-sub"), `font-family:${SANS}!important;font-weight:500!important;font-size:15px!important;color:${INK}!important;margin-top:-4px!important`),
  rule(sel("e-panel"), `${frame()};background-color:${WHITE}!important`),
  rule(sel("e-tabs"), `border-bottom:2px solid ${INK}!important;padding-left:0!important;gap:0!important`),
  rule(sel("e-tab"), `padding-left:16px!important;padding-right:16px!important;border-bottom-width:0!important;border-right:2px solid ${INK}!important`),
  rule(sel("e-tab on"), `background-color:${INK}!important;${ink(PAPER)}`),
  rule(sel("e-tab", `:not([data-ws~="on"]):hover`), `background-color:${SIG}!important;${ink(INK)}`),
  rule(sel("e-tab", " div[dir]"), "font-weight:700!important"),
  // 还没连上、还没搜过：斜线底，字贴在纸条上
  rule(sel("e-empty"), `${frame()};background-color:${PAPER2}!important;background-image:${HATCH}!important;padding:34px 20px!important`),
  rule(sel("e-empty", " > div[dir]"), `background-color:${PAPER}!important;padding:4px 12px!important`),
  rule(sel("e-empty", " > svg"), `background-color:${PAPER}!important;padding:8px!important;box-sizing:content-box!important`),
  rule(sel("e-empty", ' [data-ws~="w-emptytitle"]'), "margin-top:14px!important"),
  rule(sel("e-box"), `${frame()};background-color:${WHITE}!important`),
  rule(sel("e-name"), serif(26, 1.15, "0")),
  rule(sel("e-name small"), serif(18, 1.2, "0")),
  rule(sel("e-section"), serif(20, 1.2, "0")),
  rule(sel("e-badge"), "padding:4px 6px 3px!important"),

  // 矮窗口（桌面最小 612 高）：索引栏收一档，免得活跃天数的圈压到底部的按钮
  "@media (max-height:720px){" + [
    rule(sel("w-nav"), "min-height:44px!important"),
    rule(sel("w-days"), "margin-top:12px!important"),
    rule(sel("w-settings"), "min-height:42px!important"),
  ].join("") + "}",

  // 列表项、选项、页签按下时一记信号橙；放最后，压过前面各自的悬停色
  rule(sel("w-nav,c-filter,c-conv,e-tab,w-row,d-event", `${notDisabled}:active`), `background-color:${SIG}!important;opacity:1!important;${ink(INK)}`),
];

export const archiveCss = blocks.join("\n");
