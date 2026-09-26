/**
 * 档案馆风格的版式层：只挂在 :root[data-style="archive"] 下，海报和内容年志一条也匹配不到。
 * 这是档案馆原来那套"夜里的观测卷宗"再往前推一步，不借海报的语言——没有粗墨框、通栏墨带、戳、斜线填充、硬投影：
 * - 冷调近黑纸面，纸纹颗粒加重，四周压一圈暗角；
 * - 整页宋体（Noto Serif SC），数字用细而大的 Cormorant Garamond，浅金；英文是斜体小写，眉题是拉开字距的小号大写；
 * - 线一律 1px 青铜细线，卡头下面一行细点线；每张卡四角一对浅金 L 形角饰，标题前一颗四角星 ✦；
 * - 侧栏右缘、顶栏下缘各一把刻度尺；没有数据的地方铺一层淡淡的星尘，写明缺什么。
 * 颜色就是 native 的 palettes.archive（近黑纸面 / 暖金 / 冷青），主题色块、热力、饼图沿用组件自己的 slices / heat。
 * 组件上的 data-ws 角色与另两种风格共用（见 motion.tsx 的 ws / fx）；RN-web 的原子类要压过，所以版式声明一律 !important。
 */
const A = ':root[data-style="archive"]';
const DESK = "#0A0B0B";
const PAPER = "#131717";
const RAISED = "#181B1A";
const LINE = "#3A3228";
const FRAME = "#6E5D49";
const TEXT2 = "#CFC1B0";
// 弱化字：原色板的 #7C7266 在纸面上只有 3.8:1，提亮到 #A09383（≥5:1）
const MUTE = "#A09383";
const GOLD = "#C59861";
const GOLD_LIGHT = "#E3C8A6";
const SERIF = "'Noto Serif SC', 'Songti SC', 'STSong', serif";
const NUM = "'Cormorant Garamond', 'Noto Serif SC', 'Songti SC', Georgia, serif";

/** 选中带某个角色的元素；"a b" 表示同一元素同时带 a 和 b。多个用逗号分开。 */
function sel(roles: string, suffix = ""): string {
  return roles.split(",").map((group) => `${A} ${group.trim().split(/\s+/u).map((role) => `[data-ws~="${role}"]`).join("")}${suffix}`).join(",");
}
const rule = (selector: string, body: string) => `${selector}{${body}}`;
const tile = (key: string, suffix = "") => `${A} [data-testid="report-tile-${key}"]${suffix}`;

// 宋体标题
const serif = (size: number, weight = 700, track = ".12em", line = 1.25) => `font-family:${SERIF}!important;font-weight:${weight}!important;font-size:${size}px!important;line-height:${line}!important;letter-spacing:${track}!important`;
// 细而大的古典衬线数字
const figure = (size: number, tone = GOLD_LIGHT, line = 1) => `font-family:${NUM}!important;font-weight:300!important;font-style:normal!important;font-size:${size}px!important;line-height:${line}!important;letter-spacing:0!important;font-variant-numeric:lining-nums proportional-nums!important;color:${tone}!important`;
// 斜体英文。中文字不跟着斜：不许浏览器把宋体硬拉成伪斜体
const italic = (size: number, tone = MUTE, track = ".02em") => `font-family:${NUM}!important;font-style:italic!important;font-synthesis-style:none!important;font-weight:500!important;font-size:${size}px!important;letter-spacing:${track}!important;color:${tone}!important`;
// 拉开字距的小号大写（眉题）
const caps = (size = 12, tone = GOLD, track = ".32em") => `font-family:${NUM}!important;font-style:normal!important;font-weight:600!important;font-size:${size}px!important;letter-spacing:${track}!important;text-transform:uppercase;color:${tone}!important`;

/** 一行细点线：1px 的点，4px 一颗。 */
const dotted = (edge: "top" | "bottom", tone = FRAME) => `background-image:linear-gradient(90deg,${tone} 0 1px,transparent 1px)!important;background-size:4px 1px!important;background-repeat:repeat-x!important;background-position:0 ${edge === "top" ? "0" : "100%"}!important`;

/** 四角的 L 形角饰：每个角一横一竖两道 1px 的浅金短线，离边框 5px。 */
function corners(tone = GOLD, inset = 5, arm = 10): string {
  const bar = `linear-gradient(${tone},${tone})`;
  const spots = ["left", "right"].flatMap((x) => ["top", "bottom"].map((y) => `${x} ${inset}px ${y} ${inset}px`));
  return spots.flatMap((at) => [`${bar} ${at}/${arm}px 1px no-repeat`, `${bar} ${at}/1px ${arm}px no-repeat`]).join(",");
}
// 角饰画在 ::before 上，压在封面、图表之上，但不挡点击
const CORNERS = `content:"";position:absolute;left:0;top:0;right:0;bottom:0;z-index:2;pointer-events:none;opacity:.8;background:${corners()}`;

/** 星尘：三层错开的小亮点（金、青、羊皮纸），给"还没有观测到"的地方。 */
const DUST = [
  "radial-gradient(circle at 30% 40%,rgba(197,152,97,.5) 0 .9px,transparent 1.5px)",
  "radial-gradient(circle at 70% 65%,rgba(127,166,172,.4) 0 .8px,transparent 1.4px)",
  "radial-gradient(circle at 15% 85%,rgba(239,223,204,.22) 0 .7px,transparent 1.3px)",
].join(",");
const DUST_BG = `background-image:${DUST}!important;background-size:37px 29px,53px 41px,23px 31px!important;background-repeat:repeat!important`;

// 标题前的四角星
const STAR = `content:"✦";display:inline-block;margin-right:.55em;font-size:.62em;line-height:1;vertical-align:.3em;letter-spacing:0;color:${GOLD}`;
const notDisabled = ':not([aria-disabled="true"])';

/** 采集器页只有一套自己的样式，全局规则跳过它。 */
const NOT_SETUP = ':not([data-testid="setup-workspace"] *)';

const blocks: string[] = [
  // ---------- 底子：补位块的群点照常画 ----------
  rule(A, "--ws-swarm:on"),
  rule(`${A} ${NOT_SETUP}::selection`, `background:${GOLD};color:${DESK}`),
  rule(`${A} :focus-visible${NOT_SETUP}`, `outline:1px solid ${GOLD}!important;outline-offset:3px!important`),
  rule(`${A} input${NOT_SETUP},${A} textarea${NOT_SETUP}`, `caret-color:${GOLD}`),
  rule(`${A} input${NOT_SETUP}::placeholder,${A} textarea${NOT_SETUP}::placeholder`, `color:${MUTE}!important`),

  // ---------- 外壳：近黑桌面、夜色纸面、颗粒与暗角 ----------
  // 桌面顶上透一点冷青的天光。Cormorant 默认是旧式数字（0 像小写 o），小字里认不清：整个工作台统一用齐线数字
  rule(`${A} [data-testid="content-workspace"]`, `background-color:${DESK}!important;background-image:radial-gradient(ellipse 70% 55% at 50% 0%,rgba(127,166,172,.07),transparent 72%)!important`),
  rule(`${A} [data-testid="content-workspace"] [dir]`, "font-variant-numeric:lining-nums"),
  // 纸面四周自己压暗（在卡片底下，只落在卡片之间的空处）
  rule(sel("w-stage"), `border-color:${FRAME}!important;background-color:${PAPER}!important;background-image:radial-gradient(ellipse 90% 80% at 50% 40%,transparent 50%,rgba(0,0,0,.42) 100%)!important`),
  // 纸纹颗粒加重；最上层再压一圈很轻的暗角（最暗 15%：落在四角的弱化字仍 ≥4.5:1）
  rule(sel("w-grain"), "opacity:.52!important"),
  rule(sel("w-tint"), "background-color:transparent!important;background-image:radial-gradient(ellipse 82% 76% at 50% 46%,transparent 62%,rgba(2,3,3,.15) 100%)!important"),
  rule(sel("w-corners", " > div"), `border-color:${GOLD}!important;opacity:.6!important`),

  // ---------- 侧栏：右缘一把刻度尺，每 8px 一道短刻度、48px 一道长刻度 ----------
  rule(sel("w-side"), `border-right-color:${LINE}!important;background-image:repeating-linear-gradient(180deg,${FRAME} 0 1px,transparent 1px 48px),repeating-linear-gradient(180deg,${LINE} 0 1px,transparent 1px 8px)!important;background-size:9px 100%,5px 100%!important;background-position:100% 0,100% 0!important;background-repeat:no-repeat!important`),
  rule(sel("w-nav on"), `background-color:rgba(197,152,97,.07)!important`),
  rule(sel("w-nav on", ' [data-ws~="w-navlabel"]'), `color:${GOLD_LIGHT}!important`),
  rule(sel("w-navcount"), `${italic(14, MUTE, ".02em")};text-transform:none!important`),
  rule(sel("w-nav on", ' [data-ws~="w-navcount"]'), `color:${GOLD}!important`),
  // 活跃天数的圆环外面加一圈罗盘刻度：每 15° 一道细刻度，四个正方位描金
  rule(sel("w-days", " > div:first-child::before"), `content:"";position:absolute;left:0;top:0;right:0;bottom:0;pointer-events:none;background:repeating-conic-gradient(from -2.5deg,${GOLD} 0 5deg,transparent 5deg 90deg),repeating-conic-gradient(from -1.5deg,${FRAME} 0 3deg,transparent 3deg 15deg);-webkit-mask:radial-gradient(circle,transparent 15px,#000 15.5px 18px,transparent 18.5px);mask:radial-gradient(circle,transparent 15px,#000 15.5px 18px,transparent 18.5px)`),

  // ---------- 顶栏：拉开字距的金色眉题、宋体卷名、细体斜体计数，下缘一把刻度尺 ----------
  rule(sel("w-top"), `height:auto!important;min-height:84px!important;padding-top:12px!important;padding-bottom:16px!important;border-bottom-color:${LINE}!important;background-image:repeating-linear-gradient(90deg,${FRAME} 0 1px,transparent 1px 48px),repeating-linear-gradient(90deg,${LINE} 0 1px,transparent 1px 8px)!important;background-size:100% 8px,100% 4px!important;background-position:0 100%,0 100%!important;background-repeat:no-repeat!important`),
  rule(sel("w-title"), serif(26, 700, ".16em", 1.2)),
  rule(sel("w-count"), `${figure(30, GOLD_LIGHT, 1)};font-style:italic!important;font-synthesis-style:none!important;margin-left:4px!important`),
  // 眉题：LIVING REPORT / HIGHLIGHTS / EXPLORE……（聊天里的火花小签、列表行的话题签不算）
  rule(`${A} [data-ws~="stamp-sig"]:not([data-ws~="c-badge"]):not([data-ws~="w-row"] *):not([data-ws~="d-tile"] *)`, caps(11.5, GOLD, ".34em")),
  rule(sel("btn,btn-solid", `${notDisabled}:hover`), `border-color:${GOLD}!important`),

  // ---------- 记录：细线封面，斜体编号与时长 ----------
  rule(sel("w-ghead"), `padding-bottom:16px!important;margin-bottom:22px!important;${dotted("bottom")}`),
  rule(sel("w-gtitle"), serif(22, 700, ".16em")),
  rule(sel("w-gtitle", "::before"), STAR),
  rule(sel("w-cover"), `position:relative;border:1px solid ${LINE}!important`),
  rule(sel("w-cover", "::before"), `${CORNERS};opacity:.7;background:${corners(GOLD, 6, 8)}`),
  rule(sel("w-tile", `:hover [data-ws~="w-cover"]`), `border-color:${GOLD}!important`),
  // 无封面时的编号：原来是 20% 透明的水印字；改成浅金斜体细字，亮到大字的 3:1，挪到播放条上面不被压住
  rule(sel("w-bignum"), `font-family:${NUM}!important;font-style:italic!important;font-weight:300!important;font-size:44px!important;line-height:1!important;letter-spacing:0!important;color:${GOLD_LIGHT}!important;opacity:.5!important`),
  rule(sel("w-tile", ' [data-ws~="w-bignum"]'), "bottom:48px!important"),
  rule(sel("w-cover", ' [data-ws~="stamp"]'), `${italic(13.5, "#EFDFCC", ".02em")};font-weight:600!important;background-color:rgba(10,11,11,.78)!important;border:1px solid ${LINE}!important;padding:1px 6px!important`),
  rule(sel("w-tiletitle"), serif(14, 700, ".04em", 1.45)),
  rule(sel("w-rowtitle"), serif(15, 700, ".04em", 1.4)),
  rule(sel("w-emptytitle"), serif(22, 700, ".14em")),
  rule(sel("w-emptytitle small"), serif(18, 700, ".12em")),

  // ---------- 变化线索：大号细体计数、观测卷宗卡 ----------
  rule(sel("w-hhead"), `padding-bottom:24px!important;${dotted("bottom")}`),
  rule(sel("w-htitle"), `${serif(40, 700, ".12em", 1.2)};margin-top:12px!important`),
  rule(sel("w-hcount"), figure(104, GOLD_LIGHT, 0.95)),
  // 卡顶原来是一道 4px 的色条，收成 1px 细线（颜色照旧分青 / 金），四角加角饰
  rule(sel("w-card"), "position:relative;border-top-width:1px!important"),
  rule(sel("w-card", "::before"), CORNERS),
  // 没有对应记录的那张：铺一层星尘，底下写明
  rule(sel("w-card void", ' [data-ws~="w-hvisual"]'), DUST_BG),
  rule(sel("w-card void", ' [data-ws~="w-hvisual"]::after'), `content:"尚未观测到对应记录";position:absolute;left:16px;bottom:16px;font-family:${SERIF};font-size:11px;letter-spacing:.24em;color:${MUTE}`),
  rule(sel("w-hlabeltext"), serif(11, 700, ".16em", 1.3)),
  rule(sel("w-cardtitle"), serif(17, 700, ".04em", 1.35)),
  rule(sel("w-hrule"), `border-top-width:0!important;padding-top:1px!important;${dotted("top")}`),
  rule(sel("w-notice", "::before"), STAR),
  rule(sel("w-foot"), `border-top-width:0!important;${dotted("top")}`),

  // ---------- 持续报告：细线卷宗卡，四角角饰，卡头一行宋体 + 斜体英文 + 点线 ----------
  rule(sel("d-tile"), `border-color:${LINE}!important;background-image:linear-gradient(180deg,rgba(239,223,204,.03),transparent 140px)!important`),
  rule(sel("d-tile", "::before"), CORNERS),
  // 悬停照旧微抬，细线描亮，不落影
  rule(`${A} [data-hover="lift"]:hover`, `border-color:${FRAME}!important;box-shadow:none!important`),
  rule(sel("d-head"), `padding-bottom:11px!important;${dotted("bottom")}`),
  rule(sel("d-title"), serif(16, 700, ".18em")),
  rule(sel("d-title", "::before"), STAR),
  rule(sel("d-en"), `${italic(14.5, MUTE)};text-transform:lowercase`),
  rule(sel("d-meta"), `color:${MUTE}!important;font-size:10.5px!important`),
  rule(sel("d-figure"), `${figure(68, GOLD_LIGHT, 1)};margin-top:6px!important`),
  // 图表刻度、事件时间：Cormorant 比同字号的宋体小一圈，放大到能读
  rule(sel("d-tile", ' [data-ws~="mono"]'), `${italic(11.5, MUTE, ".02em")};font-weight:600!important`),
  rule(sel("d-event", ' [data-ws~="mono"]'), `font-size:13px!important`),
  rule(sel("d-figure", ' + [data-ws~="mono"]'), italic(15, MUTE)),
  // 意外发现的状态：斜体小写 observed；还没成形的是弱化色 pending
  rule(sel("d-tile", ' [data-ws~="stamp-sig"]'), `${italic(14, GOLD, ".04em")};font-weight:600!important;text-transform:lowercase`),
  rule(sel("d-tile", ' [data-ws~="stamp-ghost"]'), `${italic(14, MUTE, ".04em")};text-transform:lowercase`),
  rule(sel("d-foot"), `margin-top:12px!important;padding-top:12px!important;${dotted("top", LINE)}`),
  rule(sel("d-mark"), `color:${GOLD}!important`),
  rule(sel("d-num"), `font-family:${NUM}!important;font-weight:500!important;font-size:17px!important;font-variant-numeric:lining-nums!important`),
  rule(sel("d-num big"), figure(32, GOLD_LIGHT, 1.1)),
  rule(sel("d-rank"), `${italic(16, GOLD, "0")};font-weight:600!important`),
  rule(sel("d-ringvalue"), figure(34, GOLD_LIGHT, 1)),
  rule(sel("d-ititle"), serif(13.5, 700, ".04em", 1.4)),
  // 主题色块：最大那块是暖金底，字压成墨色；其余深青、深铜底上的字提亮一档（都 ≥4.5:1）
  rule(sel("d-mosaic", " div[dir]"), "color:#F7EEE2!important"),
  rule(sel("d-mosaic hi", " div[dir]"), `color:${DESK}!important`),
  rule(sel("d-mosaic hi", ' [data-ws~="d-num"]'), "font-weight:600!important"),
  rule(sel("d-event"), `border-bottom-width:0!important;${dotted("bottom", LINE)}`),
  // 真的没有数据的地方：一片淡星尘，字写明缺什么
  rule(sel("d-empty"), `align-self:stretch!important;text-align:center!important;padding:22px 14px!important;color:${TEXT2}!important;letter-spacing:.08em!important;${DUST_BG}`),
  // 补位块：夜色纸面上一群光点绕着转，点一下散开
  rule(sel("d-swarm"), `background-color:${PAPER}!important;${DUST_BG}`),
  rule(sel("d-swarmhint"), `font-family:${SERIF}!important;font-size:10.5px!important;letter-spacing:.3em!important;color:${MUTE}!important;opacity:1!important`),
  rule(tile("swarm", " svg path"), `stroke:${LINE}!important`),

  // ---------- 聊天 ----------
  rule(sel("c-head"), dotted("bottom", LINE)),
  rule(sel("c-title"), serif(24, 700, ".14em", 1.2)),
  rule(sel("c-dtitle"), serif(18, 700, ".1em", 1.2)),
  rule(sel("c-name"), serif(14, 700, ".04em", 1.3)),
  // 头像里的字原来是和底同色相的深青 / 深铜，只有 2–3:1；底色留着认人，字提成羊皮纸色
  rule(sel("c-avatar", " div[dir]"), "color:#EFDFCC!important"),
  rule(sel("c-bubble own"), "border:1px solid rgba(197,152,97,.38)!important;background-color:rgba(197,152,97,.1)!important"),
  rule(sel("c-bubble in"), `border:1px solid ${LINE}!important;background-color:${RAISED}!important`),
  rule(sel("c-fact"), `position:relative;border-color:${LINE}!important`),
  rule(sel("c-fact", "::before"), CORNERS),
  rule(sel("c-factvalue"), figure(42, GOLD_LIGHT, 1)),
  rule(sel("c-sparkdays"), figure(32, GOLD_LIGHT, 1)),
  rule(sel("c-sectiontitle"), serif(15, 700, ".12em", 1.3)),

  // ---------- 探索 ----------
  rule(sel("e-title"), serif(40, 700, ".08em", 1.25)),
  rule(sel("e-panel"), `position:relative;border-color:${LINE}!important`),
  rule(sel("e-panel", "::before"), CORNERS),
  rule(sel("e-empty"), DUST_BG),
  rule(sel("e-section"), serif(18, 700, ".1em", 1.3)),
  rule(sel("e-name"), serif(24, 700, ".04em", 1.25)),
  rule(sel("e-name small"), serif(18, 700, ".04em", 1.3)),

  // 矮窗口（桌面最小 612 高）：索引栏收一档，免得活跃天数的罗盘压到底部的「重翻年度档案」
  "@media (max-height:720px){" + [
    rule(sel("w-nav"), "min-height:46px!important"),
    rule(sel("w-days"), "margin-top:10px!important"),
    rule(sel("w-settings"), "min-height:42px!important"),
  ].join("") + "}",
];

export const archiveCss = blocks.join("\n");
