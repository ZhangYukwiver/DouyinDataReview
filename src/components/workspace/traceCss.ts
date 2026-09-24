/**
 * 内容年志风格的版式层：只挂在 :root[data-style="trace"] 下，档案馆和海报一条也匹配不到。
 * 唯一的风格来源是入口卡页（public/story/story-entry.html），这里把它的材料推到整个工作台：
 * 墨夜油画作固定底（body::before，按区域压暗）、半透明夜色玻璃卡（1px 半透白边 + 琥珀→蓝的淡渐变 + 内发光）、
 * Fraunces 细体 / 斜体的巨大数字带琥珀光、蓝描边胶囊按钮、宽字距等宽眉题 + 40px 细线、琥珀选中、半色调网点。
 * 组件上的 data-ws 角色与海报共用（见 motion.tsx 的 ws / fx）；RN-web 的原子类要压过，所以版式声明一律 !important。
 * 性能：画是一张固定层，不用 background-attachment:fixed；不用大面积 backdrop-filter；呼吸光晕只动 opacity。
 */
const T = ':root[data-style="trace"]';
const CREAM = "#F6F1E4";
const MIST = "#DEE2DE";
const BLUE = "#41A1CF";
const AMBER = "#EEA44E";
const NIGHT = "#0C1220";
const DEEP = "#070A12";
const SERIF = "Fraunces, 'Songti SC', 'STSong', 'Noto Serif SC', Georgia, serif";
const SANS = "Inter, 'PingFang SC', 'Helvetica Neue', sans-serif";
const MONO = "'SFMono-Regular', ui-monospace, 'Roboto Mono', monospace";
const PAINTING = "/story/story-images/entry-night.jpg";

/** 选中带某个角色的元素；"a b" 表示同一元素同时带 a 和 b。多个用逗号分开。 */
function sel(roles: string, suffix = ""): string {
  return roles.split(",").map((group) => `${T} ${group.trim().split(/\s+/u).map((role) => `[data-ws~="${role}"]`).join("")}${suffix}`).join(",");
}
const rule = (selector: string, body: string) => `${selector}{${body}}`;

// 入口卡的玻璃：琥珀→蓝的淡渐变压在一层夜色上（没有毛玻璃，靠夜色保证字读得清）
const GLASS_TINT = "linear-gradient(168deg,rgba(238,164,78,.18) 0%,rgba(210,154,78,.10) 42%,rgba(47,84,128,.13) 78%,rgba(254,255,252,.03) 100%)";
const INNER = "inset 0 0 40px rgba(254,255,252,.08)";
const HALO = "0 0 120px rgba(238,164,78,.32)";
function glass({ edge = 0.55, base = 0.46, radius = 24, halo = false }: { edge?: number; base?: number; radius?: number; halo?: boolean } = {}): string {
  return [
    `background-color:rgba(9,13,24,${base})!important`,
    `background-image:${GLASS_TINT}!important`,
    `border:1px solid rgba(254,255,252,${edge})!important`,
    `border-radius:${radius}px!important`,
    `box-shadow:${INNER}${halo ? `,${HALO}` : ""}!important`,
  ].join(";");
}
/** 更沉的一层夜色（玻璃里再嵌一块时用），不带渐变。 */
const dusk = (edge = 0.16, radius = 20) => `background-color:rgba(7,10,18,.46)!important;background-image:none!important;border:1px solid rgba(254,255,252,${edge})!important;border-radius:${radius}px!important;box-shadow:${INNER}!important`;
/** 半色调网点：入口探照灯的网点，当纹理和空态用。dotImage 给 background-image，dots 给 background 简写。 */
const dotImage = (tone = "rgba(246,241,228,.16)", r = 1) => `radial-gradient(${tone} ${r}px,transparent ${r + 0.6}px)`;
const dots = (tone = "rgba(246,241,228,.16)", gap = 10, r = 1) => `${dotImage(tone, r)} 0 0/${gap}px ${gap}px`;

/** 一块区域里所有用 token 的字、线、图标换成同一个颜色（按钮、选中项内部用）。 */
function tone(fg: string, muted = fg): string {
  return [
    `--ws-text:${fg}`, `--ws-text-secondary:${fg}`, `--ws-text-muted:${muted}`, `--ws-figure:${fg}`,
    `--ws-accent:${fg}`, `--ws-cyan:${fg}`, `--ws-green:${fg}`, `--ws-amber:${fg}`, `--ws-signal:${fg}`,
    `--ws-button-text:${fg}`, `--ws-black:${fg}`, `--ws-white:${fg}`, `--ws-canvas:${fg}`,
    `color:${fg}`,
  ].join(";");
}

// 巨大的细衬线数字，带琥珀光
const figure = (size: number, { italic = true, weight = 200, line = 0.95, glow = 0.55 }: { italic?: boolean; weight?: number; line?: number; glow?: number } = {}) => [
  `font-family:${SERIF}!important`, `font-weight:${weight}!important`, `font-style:${italic ? "italic" : "normal"}!important`,
  `font-size:${size}px!important`, `line-height:${line}!important`, `letter-spacing:-.035em!important`,
  "font-variant-numeric:lining-nums proportional-nums!important", `color:${CREAM}!important`,
  `text-shadow:0 0 ${Math.round(size * 0.45)}px rgba(238,164,78,${glow}),0 0 2px rgba(238,164,78,.35)!important`,
].join(";");
// Fraunces 300 的标题
const serif = (size: number, line = 1.18, track = "-.015em", weight = 300) => `font-family:${SERIF}!important;font-weight:${weight}!important;font-size:${size}px!important;line-height:${line}!important;letter-spacing:${track}!important;color:${CREAM}!important`;
// 宽字距等宽小字
const mono = (size = 9.5, track = ".24em") => `font-family:${MONO}!important;font-weight:400!important;font-size:${size}px!important;letter-spacing:${track}!important;text-transform:uppercase`;
// 眉题前那根 40px 细线
const LINE = 'content:"";display:block;flex:none;width:40px;height:1px;background:currentColor;opacity:.5';
const pill = (border: string, bg = "transparent") => `border:1px solid ${border}!important;border-radius:50px!important;background-color:${bg}!important;background-image:none!important;box-shadow:none!important`;
const notDisabled = ':not([aria-disabled="true"])';

const blocks: string[] = [
  // ---------- 底：墨夜油画，固定一层，按区域压暗 ----------
  rule(T, `background-color:${DEEP}!important;color-scheme:dark;--ws-swarm:on`),
  rule(`${T} body`, "background:transparent!important"),
  // 左边侧栏、上边标题栏、下边地平线各压一道暗；中间留出积雨云里透出来的琥珀光
  rule(`${T} body::before`, [
    'content:""', "position:fixed", "inset:0", "z-index:-1", "pointer-events:none",
    `background:linear-gradient(90deg,rgba(7,10,18,.8) 0%,rgba(7,10,18,.46) 24%,rgba(7,10,18,.26) 58%,rgba(7,10,18,.5) 100%),linear-gradient(180deg,rgba(7,10,18,.6) 0%,rgba(7,10,18,.14) 30%,rgba(7,10,18,.2) 64%,rgba(14,9,6,.74) 100%),url("${PAINTING}") center 46%/cover no-repeat,${NIGHT}`,
  ].join(";")),
  // 网点压在地平线一带，再叠一团缓慢呼吸的琥珀光（只动 opacity）
  rule(`${T} #root::before`, [
    'content:""', "position:fixed", "inset:0", "z-index:-1", "pointer-events:none",
    `background:radial-gradient(46% 38% at 64% 44%,rgba(238,164,78,.16) 0%,rgba(238,164,78,0) 72%),${dots("rgba(246,241,228,.10)", 9, 0.9)}`,
    "-webkit-mask-image:linear-gradient(180deg,transparent 0%,rgba(0,0,0,.35) 45%,#000 100%)",
    "mask-image:linear-gradient(180deg,transparent 0%,rgba(0,0,0,.35) 45%,#000 100%)",
    "animation:tc-breathe 9s ease-in-out infinite alternate", "will-change:opacity",
  ].join(";")),
  "@keyframes tc-breathe{from{opacity:.55}to{opacity:1}}",
  "@keyframes tc-halo{from{opacity:.6}to{opacity:1}}",
  rule(`${T} ::selection`, `background:rgba(238,164,78,.35);color:${CREAM}`),
  rule(`${T} :focus-visible`, `outline:2px solid ${BLUE}!important;outline-offset:3px!important`),
  rule(`${T} input,${T} textarea`, `caret-color:${AMBER}`),
  rule(`${T} input::placeholder,${T} textarea::placeholder`, "color:rgba(222,226,222,.45)!important"),

  // ---------- 字：眉题、戳、等宽小字 ----------
  rule(sel("mono"), "letter-spacing:.08em!important"),
  rule(sel("stamp,stamp-sig,stamp-ghost"), `${mono(9.5)};display:flex;flex-direction:row;align-items:center;gap:12px;align-self:flex-start!important;background-color:transparent!important;border-width:0!important;padding:0!important;min-height:0!important;height:auto!important;white-space:nowrap`),
  rule(sel("stamp"), `color:${MIST}!important;opacity:.85`),
  rule(sel("stamp-sig"), `color:${AMBER}!important`),
  rule(sel("stamp-ghost"), "color:rgba(222,226,222,.62)!important"),
  // 眉题一律带 40px 细线；徽标、话题、封面角标这类小戳不带
  rule(sel("stamp,stamp-sig", "::before"), LINE),
  rule([
    sel("s-brandmeta", "::before"), sel("c-badge", "::before"), sel("e-badge", "::before"),
    sel("w-row", ' [data-ws~="stamp-sig"]::before'), sel("w-cover", ' [data-ws~="stamp"]::before'),
    sel("d-tile", ' [data-ws~="stamp-sig"]::before'), sel("stamp-bar", ' [data-ws~="stamp"]::before'),
    sel("w-card", ' [data-ws~="stamp"]::before'),
  ].join(","), "content:none!important;display:none!important"),
  // 封面角标 / 聊天未读这类小戳：夜色小胶囊
  rule([sel("w-cover", ' [data-ws~="stamp"]'), sel("e-badge"), sel("c-badge")].join(","), `${pill("rgba(254,255,252,.32)", "rgba(7,10,18,.62)")};padding:3px 8px!important;letter-spacing:.08em!important;font-size:9px!important;color:${CREAM}!important;opacity:1`),
  rule(sel("c-badge"), `border-color:${AMBER}!important;color:${AMBER}!important;padding:2px 5px!important;min-width:17px!important;justify-content:center`),
  rule(sel("w-row", ' [data-ws~="stamp-sig"]'), `${pill("rgba(238,164,78,.45)", "rgba(238,164,78,.08)")};padding:3px 9px!important;letter-spacing:.06em!important;text-transform:none;font-size:10px!important`),
  rule(`${sel("d-tile", ' [data-ws~="stamp-sig"]')},${sel("d-tile", ' [data-ws~="stamp-ghost"]')}`, `${pill("currentColor")};padding:2px 8px!important;letter-spacing:.14em!important;font-size:8.5px!important`),
  rule(sel("stamp-bar"), `${glass({ edge: 0.3, base: 0.5, radius: 50 })};border-left-width:1px!important;padding-left:18px!important;padding-right:18px!important`),
  rule(sel("stamp-bar", " div[dir]"), `color:${MIST}!important`),
  // 聊天详情顶上的提示条不贴边
  rule(sel("c-dhead", ' + [data-ws~="stamp-bar"]'), "margin:12px 18px 0!important"),
  rule(sel("stamp-bar", ' [data-ws~="stamp"]'), `color:${AMBER}!important;opacity:1`),
  rule(sel("rule-t"), "border-top-color:rgba(254,255,252,.14)!important"),
  rule(sel("dot"), "background-color:rgba(222,226,222,.45)!important;border-radius:50%!important"),
  rule(sel("dot on"), `background-color:${AMBER}!important;box-shadow:0 0 10px 1px rgba(238,164,78,.75)`),

  // ---------- 按钮：蓝描边胶囊；次要的是奶油色虚边；方钮是圆 ----------
  rule(sel("btn,btn-solid,btn-sig"), `${pill(BLUE, "transparent")};${tone(BLUE)};transition:background-color .3s,box-shadow .3s,border-color .3s!important`),
  rule(sel("btn,btn-solid,btn-sig", " div[dir]"), `font-family:${SANS}!important;font-weight:500!important;letter-spacing:.02em!important`),
  rule(sel("btn-solid,btn-sig"), `background-color:rgba(65,161,207,.1)!important;box-shadow:0 0 26px -6px rgba(65,161,207,.55),inset 0 0 18px rgba(65,161,207,.12)!important`),
  rule(sel("btn,btn-solid,btn-sig", `${notDisabled}:hover`), "background-color:rgba(65,161,207,.16)!important;transform:none!important"),
  rule(sel("btn,btn-solid,btn-sig", `${notDisabled}:active`), "background-color:rgba(65,161,207,.26)!important"),
  rule(sel("btn small"), `${pill("rgba(246,241,228,.3)")};${tone(CREAM, "rgba(222,226,222,.72)")}`),
  rule(sel("btn small", `${notDisabled}:hover`), "background-color:rgba(246,241,228,.08)!important;border-color:rgba(246,241,228,.55)!important"),
  // w-mbtn：窄屏顶栏里重看年志 / 设置两颗钮，只有年志认这个角色
  rule(sel("btn square,w-mbtn"), `${pill("rgba(246,241,228,.28)", "rgba(7,10,18,.38)")};border-radius:50%!important;${tone(MIST)}`),
  rule(sel("w-mbtn"), `--ws-accent:${AMBER}`),
  rule(sel("btn square,w-mbtn", `${notDisabled}:hover`), "background-color:rgba(246,241,228,.08)!important;border-color:rgba(246,241,228,.6)!important"),
  rule(`${sel("btn on")},${sel("btn square on")}`, `border-color:${AMBER}!important;background-color:rgba(238,164,78,.14)!important;box-shadow:0 0 22px -4px rgba(238,164,78,.6)!important;${tone(AMBER)}`),

  // ---------- 动效：跟入口卡一样慢、软；悬停是一圈光，不是阴影 ----------
  rule(`${T} [data-hover="lift"]:hover`, "box-shadow:0 0 0 1px rgba(254,255,252,.5),0 0 60px -10px rgba(238,164,78,.45)!important"),
  // 记录格子外框是方的，光只落在封面上（见 w-cover）
  rule(`${T} [data-hover="card"]:hover`, "box-shadow:none!important"),
  rule(`${T} [data-hover="tint"]:hover`, "background-color:rgba(246,241,228,.06)!important"),

  // ---------- 采集器页：胶囊导航 + 入口卡式的大标题 + 一张大玻璃卡 ----------
  rule(sel("s-top"), `${glass({ edge: 0.2, base: 0.4, radius: 50 })};background-image:none!important;background-color:rgba(255,255,255,.06)!important;box-shadow:rgba(0,0,0,.25) 0 2px 12px!important;height:60px!important;margin:18px 20px 0!important;padding-left:14px!important;padding-right:10px!important`),
  rule(sel("s-mark"), `border-color:rgba(246,241,228,.4)!important;background-color:transparent!important;${tone(CREAM)}`),
  rule(sel("s-brand"), `font-family:${SANS}!important;font-weight:600!important;font-size:14px!important;letter-spacing:.02em!important;color:${CREAM}!important`),
  rule(sel("s-brandmeta"), `font-size:8.5px!important;letter-spacing:.22em!important;color:${CREAM}!important;opacity:.72;margin-top:3px!important`),
  rule(sel("s-status"), `${mono(9.5, ".14em")};text-transform:none;color:rgba(246,241,228,.8)!important`),
  rule(sel("s-enter"), "min-height:40px!important;padding-left:16px!important;padding-right:10px!important"),
  rule(sel("btn s-enter"), `${pill("rgba(246,241,228,.35)")};${tone(CREAM)}`),
  rule(sel("btn s-enter", `${notDisabled}:hover`), "background-color:rgba(246,241,228,.09)!important"),
  // 圆圈箭头
  rule(sel("btn-sig s-enter", " svg"), "box-sizing:content-box;padding:3px;border:1px solid currentColor;border-radius:50%;width:12px!important;height:12px!important"),
  rule(sel("s-layout"), "background-color:transparent!important;border-width:0!important;box-shadow:none!important;overflow:visible!important;max-width:1320px!important;gap:28px"),
  rule(sel("s-intro"), "border-right-width:0!important"),
  "@media (min-width:900px){" + rule(sel("s-intro"), "width:420px!important;padding:34px 18px 34px 12px!important") + "}",
  rule(sel("s-title"), `${serif(46, 1.16)};margin-top:22px!important`),
  rule(sel("s-lead"), `font-size:13px!important;line-height:1.85!important;color:${CREAM}!important;opacity:.78;margin-top:18px!important;max-width:380px`),
  // 印章换成一张小入口卡：玻璃、呼吸的琥珀光晕、底部一个巨大的斜体年份
  rule(sel("s-seal"), `${glass()};position:relative;width:228px!important;height:300px!important;border-radius:24px!important;align-self:center!important;align-items:flex-start!important;justify-content:flex-start!important;padding:24px!important;margin-top:40px!important;overflow:visible!important;${tone(CREAM)}`),
  rule(sel("s-seal", "::after"), `content:"";position:absolute;inset:0;border-radius:24px;pointer-events:none;box-shadow:${HALO},0 0 0 1px rgba(254,255,252,.22);animation:tc-halo 5s ease-in-out infinite alternate`),
  rule(sel("s-seal", "::before"), `content:"";position:absolute;left:50%;top:44%;width:150px;height:150px;margin:-75px 0 0 -75px;border-radius:50%;pointer-events:none;background:radial-gradient(circle,rgba(238,164,78,.34) 0%,rgba(238,164,78,0) 60%),${dots("rgba(246,241,228,.42)", 7, 1)};-webkit-mask-image:radial-gradient(circle,#000 0%,rgba(0,0,0,.6) 45%,transparent 70%);mask-image:radial-gradient(circle,#000 0%,rgba(0,0,0,.6) 45%,transparent 70%)`),
  rule(sel("s-seal", " svg"), "width:22px!important;height:22px!important;opacity:.85"),
  rule(sel("s-sealtext"), `${mono(9, ".3em")};color:${CREAM}!important;opacity:.85;margin-top:16px!important`),
  rule(sel("s-year"), `${figure(92)};position:absolute;left:20px;bottom:14px;margin:0!important`),
  rule(sel("s-steplabel"), `font-family:${SANS}!important;font-weight:600!important;font-size:12px!important;letter-spacing:.04em!important;color:${CREAM}!important`),
  rule(sel("s-stepindex"), `${pill("rgba(246,241,228,.35)")};border-radius:50%!important`),
  rule(sel("s-stepindex on"), `border-color:${AMBER}!important;background-color:rgba(238,164,78,.14)!important;box-shadow:0 0 18px -2px rgba(238,164,78,.7)!important;--ws-button-text:${AMBER}`),
  rule(sel("s-opt"), `${glass({ edge: 0.2, base: 0.36, radius: 18 })};min-height:64px!important`),
  rule(sel("s-opt on"), `border-color:${AMBER}!important;background-image:linear-gradient(168deg,rgba(238,164,78,.26),rgba(238,164,78,.06))!important;box-shadow:${INNER},0 0 34px -8px rgba(238,164,78,.7)!important`),
  rule(sel("s-opt on", ' [data-ws~="s-optlabel"]'), `color:${AMBER}!important`),
  rule(sel("s-optlabel"), `font-family:${SERIF}!important;font-weight:400!important;font-size:15px!important;letter-spacing:.02em!important;color:${CREAM}!important`),
  rule(sel("s-ops"), `${glass({ halo: true })};padding:36px!important`),
  rule(sel("s-head"), "padding-bottom:22px!important;border-bottom:1px solid rgba(254,255,252,.14)!important"),
  rule(sel("s-optitle"), `${serif(40, 1.1)};margin-top:16px!important`),
  rule(sel("s-ready"), `${pill("rgba(246,241,228,.3)")};padding:8px 14px!important`),
  rule(sel("s-ready on"), `border-color:${AMBER}!important;background-color:rgba(238,164,78,.12)!important;box-shadow:0 0 22px -6px rgba(238,164,78,.7)!important;${tone(AMBER)}`),
  rule(sel("s-icon"), `${pill("rgba(246,241,228,.32)")};border-radius:50%!important;${tone(AMBER)}`),
  rule(sel("s-cardtitle"), `font-family:${SANS}!important;font-weight:600!important;font-size:13px!important;letter-spacing:.02em!important;color:${CREAM}!important`),
  rule(sel("s-cardtitle big"), `${serif(30, 1.15)};margin-top:12px!important`),
  rule(sel("s-input"), `${pill("rgba(254,255,252,.22)", "rgba(7,10,18,.5)")};height:46px!important;padding-left:18px!important;padding-right:18px!important;font-family:${MONO}!important;font-size:13px!important;color:${CREAM}!important`),
  rule(sel("s-input", " input"), `font-family:${MONO}!important;font-size:13px!important;color:${CREAM}!important`),
  // 连接面板：玻璃里嵌一块更沉的夜色，铺一层琥珀网点
  rule(sel("s-action"), `${dusk(0.18, 22)};background:${dots("rgba(238,164,78,.2)", 9, 0.9)},radial-gradient(90% 80% at 85% 0%,rgba(238,164,78,.16),transparent 70%),rgba(7,10,18,.5)!important;border-left-width:1px!important;padding:24px!important`),
  rule(sel("s-actionvalue"), `${figure(40, { weight: 300, line: 1.1, glow: 0.4 })};letter-spacing:-.01em!important;margin-top:12px!important`),
  rule(sel("s-counts"), "background-color:transparent!important;border-width:0!important;border-top:1px solid rgba(254,255,252,.14)!important;border-bottom:1px solid rgba(254,255,252,.14)!important;border-radius:0!important;margin-top:18px!important;overflow:visible!important"),
  rule(sel("s-count"), "flex-direction:column!important;align-items:flex-start!important;justify-content:flex-end!important;gap:14px!important;min-height:132px!important;padding:18px 18px 16px!important;border-right-color:rgba(254,255,252,.12)!important"),
  rule(sel("s-count", ":last-child"), "border-right-width:0!important"),
  rule(sel("s-count", " svg"), "opacity:.9"),
  rule(sel("s-countvalue"), `${figure(58)};font-size:clamp(40px,4vw,58px)!important`),
  rule(sel("s-countlabel"), `${mono(9, ".22em")};color:rgba(222,226,222,.7)!important;margin-top:10px!important`),
  rule(sel("s-actions"), "gap:10px!important;margin-top:18px!important"),
  rule(sel("s-auto"), `${glass({ edge: 0.16, base: 0.34, radius: 20 })};padding:14px 16px!important`),
  rule(sel("s-switch"), `${pill("rgba(246,241,228,.35)", "rgba(7,10,18,.5)")};width:36px!important;height:20px!important;padding:2px!important`),
  rule(sel("s-switch on"), `border-color:${AMBER}!important;background-color:rgba(238,164,78,.35)!important;box-shadow:0 0 14px -2px rgba(238,164,78,.7)!important`),
  rule(sel("s-switch", " > div"), `width:14px!important;height:14px!important;border-radius:50%!important;background-color:${CREAM}!important`),
  rule(sel("s-switch on", " > div"), "transform:translateX(16px)!important"),
  rule(sel("s-error"), `${dusk(0.2, 18)};border-color:rgba(232,130,111,.5)!important`),
  rule(sel("s-foot"), "justify-content:center!important;background-color:rgba(7,10,18,.42)!important;border-top-color:rgba(254,255,252,.12)!important"),
  rule(sel("s-foot", ' > [data-ws~="btn"]'), "flex:0 0 auto!important;min-width:220px!important;padding-left:22px!important;padding-right:22px!important"),
  rule(sel("s-progress"), glass({ edge: 0.2, base: 0.4, radius: 18 })),

  // ---------- 工作台外壳：舞台透明，侧栏是一张竖着的玻璃卡 ----------
  rule(sel("w-stage"), "background-color:transparent!important;border-width:0!important;box-shadow:none!important;border-radius:0!important"),
  rule(sel("w-side"), `${glass({ edge: 0.2, base: 0.5 })};background-image:linear-gradient(180deg,rgba(238,164,78,.08),rgba(47,84,128,.10) 60%,rgba(254,255,252,.02))!important;margin-right:18px`),
  rule(sel("w-toggle"), `${pill("rgba(246,241,228,.28)", "rgba(7,10,18,.4)")};border-radius:50%!important;top:12px!important;left:22px!important`),
  rule(sel("w-glider"), `background-color:${AMBER}!important;box-shadow:0 0 14px 2px rgba(238,164,78,.65);border-radius:0 3px 3px 0!important`),
  rule(sel("w-nav"), "border-radius:50px!important;border:1px solid transparent!important"),
  rule(sel("w-nav on"), `border-color:rgba(238,164,78,.42)!important;background-color:transparent!important;background-image:linear-gradient(90deg,rgba(238,164,78,.22),rgba(238,164,78,.03))!important;box-shadow:0 0 30px -10px rgba(238,164,78,.7)!important;${tone(AMBER)}`),
  rule(sel("w-navicon"), "background-color:transparent!important"),
  rule(sel("w-navlabel"), `font-family:${SANS}!important;font-weight:500!important;font-size:13px!important;letter-spacing:.1em!important`),
  rule(sel("w-nav on", ' [data-ws~="w-navlabel"]'), `font-family:${SERIF}!important;font-style:italic;font-weight:400!important;font-size:15px!important;letter-spacing:.04em!important`),
  rule(sel("w-navcount"), `font-family:${MONO}!important;font-size:10px!important;letter-spacing:.04em!important`),
  rule(sel("w-days", " div[dir]"), `${mono(8.5, ".12em")};text-transform:none;line-height:1.5!important`),
  rule(sel("w-settings"), "min-height:46px!important"),
  rule(sel("w-top"), "height:auto!important;min-height:92px!important;padding-top:14px!important;padding-bottom:14px!important;border-bottom-color:rgba(254,255,252,.12)!important;background-color:transparent!important"),
  rule(sel("w-title"), `${serif(34, 1.1, "-.01em")};margin-top:8px!important;max-width:70%!important`),
  rule(sel("w-count"), `${figure(34, { weight: 300, line: 1.1, glow: 0.6 })};color:${AMBER}!important;margin-left:8px!important`),
  rule(sel("w-bottom"), "background-color:rgba(7,10,18,.78)!important;border-top-color:rgba(254,255,252,.16)!important"),

  // ---------- 记录：封面是玻璃框，缺图时是网点 + 巨大的斜体编号 ----------
  rule(sel("w-ghead"), "border-bottom:1px solid rgba(254,255,252,.12)!important;padding-bottom:18px!important;margin-bottom:24px!important"),
  rule(sel("w-gtitle"), serif(36, 1.1, "-.01em")),
  rule(sel("w-switch"), `${pill("rgba(254,255,252,.22)", "rgba(7,10,18,.4)")};padding:3px!important;height:44px!important`),
  // w-lay：网格 / 列表两颗切换钮（RN-web 不给 tab 写 aria-selected，只能靠角色标记选中）
  rule(sel("w-lay"), "border-radius:50px!important;width:44px!important;height:36px!important;background-color:transparent!important"),
  rule(sel("w-lay on"), `background-color:rgba(238,164,78,.2)!important;box-shadow:inset 0 0 0 1px rgba(238,164,78,.5)!important;${tone(AMBER)}`),
  rule(sel("w-tile"), "margin-bottom:28px!important"),
  rule(sel("w-cover"), `border:1px solid rgba(254,255,252,.28)!important;border-radius:20px!important;background-image:radial-gradient(80% 60% at 70% 20%,rgba(238,164,78,.2),transparent 70%),${dotImage("rgba(246,241,228,.14)", 0.8)}!important;background-size:auto,8px 8px!important;box-shadow:${INNER}!important`),
  // 悬停：像穿卡那一下，白光从封面边缘往里渗一点
  rule(sel("w-cover"), "transition:box-shadow .5s cubic-bezier(.22,.61,.36,1),border-color .4s"),
  rule(sel("w-tile", `:hover [data-ws~="w-cover"]`), "border-color:rgba(254,255,252,.75)!important;box-shadow:inset 0 0 34px 2px rgba(254,255,252,.22),0 0 50px -8px rgba(238,164,78,.55)!important"),
  rule(sel("w-disc"), "width:40px!important;height:40px!important;border-color:rgba(246,241,228,.3)!important;background-color:transparent!important;position:absolute!important;top:34px;right:12px;--ws-cyan:rgba(246,241,228,.6);--ws-accent:rgba(246,241,228,.6);--ws-amber:rgba(246,241,228,.6)"),
  rule(sel("w-disc", " svg"), "width:16px!important;height:16px!important"),
  rule(sel("w-bignum"), `${figure(118)};opacity:1!important;left:12px!important;bottom:34px!important;right:auto!important;top:auto!important`),
  rule(sel("w-tilebar"), "background-color:transparent!important;background-image:linear-gradient(180deg,rgba(7,10,18,0),rgba(7,10,18,.82))!important;padding:18px 12px 11px!important"),
  rule(sel("w-tiletitle"), `font-family:${SANS}!important;font-weight:500!important;font-size:13px!important;line-height:1.5!important;color:${CREAM}!important;margin-top:12px!important`),
  rule(sel("w-overlay"), `background-color:rgba(7,10,18,.55)!important;border:1px solid rgba(238,164,78,.55)!important;border-radius:20px!important;box-shadow:inset 0 0 60px rgba(238,164,78,.18)!important`),
  rule(sel("w-play"), `border:1px solid rgba(246,241,228,.8)!important;background-color:rgba(7,10,18,.45)!important;box-shadow:0 0 30px rgba(238,164,78,.45)!important`),
  rule(sel("w-tileaction"), "min-height:34px!important;background-color:rgba(7,10,18,.62)!important"),
  rule(sel("w-row"), "border-bottom-color:rgba(254,255,252,.1)!important;padding-top:14px!important;padding-bottom:14px!important"),
  rule(sel("w-thumb"), `border:1px solid rgba(254,255,252,.24)!important;border-radius:14px!important;background-image:${dotImage("rgba(246,241,228,.14)", 0.7)}!important;background-size:7px 7px!important`),
  rule(sel("w-rowtitle"), `font-family:${SANS}!important;font-weight:600!important;font-size:14px!important;color:${CREAM}!important`),
  rule(sel("w-check"), `${pill("rgba(246,241,228,.5)", "rgba(7,10,18,.5)")};border-radius:50%!important`),
  rule(sel("w-check on"), `border-color:${AMBER}!important;background-color:rgba(238,164,78,.3)!important;--ws-button-text:${CREAM}`),
  rule(sel("w-batch"), "background-color:rgba(7,10,18,.6)!important;border-bottom-color:rgba(254,255,252,.14)!important"),
  // 空态：一圈网点里亮着的一粒光
  rule(sel("w-emptyicon"), `width:84px!important;height:84px!important;border-radius:50%!important;border:1px solid rgba(254,255,252,.3)!important;background:radial-gradient(circle,rgba(238,164,78,.34) 0%,rgba(238,164,78,0) 62%),${dots("rgba(246,241,228,.3)", 7, 0.8)},rgba(7,10,18,.4)!important;box-shadow:0 0 50px -6px rgba(238,164,78,.5)!important;${tone(AMBER)}`),
  rule(sel("w-emptytitle"), `${serif(30, 1.2)};margin-top:22px!important`),
  rule(sel("w-emptytitle small"), serif(20, 1.25)),

  // ---------- 变化线索 ----------
  rule(sel("w-hhead"), "border-bottom-color:rgba(254,255,252,.12)!important;padding-top:26px!important;padding-bottom:26px!important"),
  rule(sel("w-htitle"), `${serif(60, 1.05, "-.02em")};margin-top:16px!important`),
  rule(sel("w-hcountblock"), "border-left-color:rgba(254,255,252,.14)!important;width:230px!important"),
  rule(sel("w-hcount"), figure(140, { line: 0.9 })),
  rule(sel("w-card"), `${glass({ edge: 0.3 })};border-top-width:1px!important`),
  rule(sel("w-hvisual"), `border-bottom:1px solid rgba(254,255,252,.14)!important;background-image:radial-gradient(70% 70% at 30% 20%,rgba(238,164,78,.22),transparent 70%),${dotImage("rgba(246,241,228,.12)", 0.8)}!important;background-size:auto,8px 8px!important`),
  rule(sel("w-hvisual", ' [data-ws~="w-bignum"]'), "bottom:18px!important"),
  rule(sel("w-hvisual", " svg"), "position:absolute;top:20px;right:20px;width:26px!important;height:26px!important;opacity:.7"),
  rule(sel("w-hlabel"), `${pill("rgba(254,255,252,.35)", "rgba(7,10,18,.55)")};min-height:0!important;padding:5px 11px!important`),
  rule(sel("w-hlabeltext"), `${mono(9, ".18em")};color:${CREAM}!important`),
  rule(sel("w-cardtitle"), serif(19, 1.3, "0", 400)),
  rule(sel("w-hrule"), "border-top-color:rgba(254,255,252,.12)!important"),
  rule(sel("w-foot"), `${glass({ edge: 0.22, base: 0.42, radius: 50 })};border-left-width:1px!important;padding-left:20px!important`),

  // ---------- 持续报告：每格一张玻璃卡，数字是巨大的细斜体 ----------
  rule(sel("d-tile"), `${glass({ edge: 0.22, base: 0.44 })};padding:18px!important`),
  rule(["days", "events", "unique", "attention"].map((key) => `${T} [data-testid="report-tile-${key}"]`).join(","), `border-color:rgba(254,255,252,.5)!important;background-image:linear-gradient(168deg,rgba(238,164,78,.26) 0%,rgba(210,154,78,.12) 42%,rgba(47,84,128,.16) 78%,rgba(254,255,252,.03) 100%)!important;box-shadow:${INNER},0 0 60px -12px rgba(238,164,78,.45)!important`),
  rule(sel("d-head"), "align-items:center!important;row-gap:4px!important;padding-bottom:12px!important;border-bottom:1px solid rgba(254,255,252,.1)!important"),
  rule(sel("d-title"), serif(18, 1.2, ".01em")),
  rule(sel("d-en"), `${mono(8.5, ".22em")};color:rgba(222,226,222,.55)!important`),
  rule(sel("d-meta"), `${mono(9, ".06em")};text-transform:none;color:rgba(222,226,222,.6)!important`),
  // 格子宽度不一：数字按格宽封顶，放不下时说明文字换到下一行，不挤数字
  rule(sel("d-tile"), "container-type:inline-size"),
  rule(sel("d-figure"), `${figure(74)};font-size:min(74px,30cqi)!important;margin-top:10px!important`),
  rule(`${T} div:has(> [data-ws~="d-figure"])`, "flex-wrap:wrap!important;row-gap:2px!important"),
  rule(sel("d-foot"), "border-top:1px solid rgba(254,255,252,.1)!important;margin-top:12px!important;padding-top:12px!important"),
  rule(sel("d-mark"), `color:${AMBER}!important;text-shadow:0 0 10px rgba(238,164,78,.9)!important`),
  rule(sel("d-mark off"), "color:rgba(222,226,222,.45)!important;text-shadow:none!important"),
  rule(sel("d-num"), `font-family:${SERIF}!important;font-weight:400!important;font-variant-numeric:lining-nums tabular-nums!important`),
  rule(sel("d-num big"), `font-weight:300!important;font-style:italic!important;font-size:22px!important;line-height:1.15!important;color:${CREAM}!important;text-shadow:0 0 14px rgba(238,164,78,.45)!important`),
  rule(sel("d-rank"), `font-family:${MONO}!important;color:${AMBER}!important;letter-spacing:.06em!important`),
  rule(sel("d-ringvalue"), figure(26, { weight: 300, line: 1.1 })),
  rule(sel("d-cell"), `${dusk(0.14, 14)}`),
  rule(sel("d-track"), "border-radius:50px!important;overflow:hidden!important;background-color:rgba(246,241,228,.08)!important"),
  rule(sel("d-track", " > div"), "border-radius:50px!important"),
  rule(sel("d-mosaic"), "border-radius:14px!important;border-color:rgba(254,255,252,.18)!important"),
  rule(sel("d-mosaic", " div[dir]"), "text-shadow:0 1px 8px rgba(7,10,18,.85)"),
  rule(sel("d-event"), "border-bottom-color:rgba(254,255,252,.08)!important;border-radius:0!important"),
  rule(sel("d-ititle"), `font-family:${SERIF}!important;font-weight:400!important;font-size:14px!important;letter-spacing:.01em!important;color:${CREAM}!important`),
  rule(sel("d-mcell"), "border-radius:6px!important"),
  // 瀑布底下的空当：网点地里一团会跟着指针转的光（群点用 --ws-cyan / --ws-accent 上色：蓝边琥珀心）
  rule(sel("d-swarm"), `background-color:rgba(7,10,18,.28)!important;background-image:${dotImage("rgba(246,241,228,.14)", 0.9)}!important;background-size:9px 9px!important`),
  rule(sel("d-swarmhint"), `${mono(8.5, ".22em")};color:rgba(222,226,222,.6)!important`),
  rule(`${T} [data-testid="report-tile-swarm"] svg path`, "stroke:rgba(254,255,252,.3)!important;stroke-dasharray:3 5"),

  // ---------- 聊天 ----------
  rule(sel("c-bar"), "background-color:rgba(7,10,18,.42)!important;border-bottom-color:rgba(254,255,252,.1)!important"),
  rule(sel("c-list"), `${glass({ edge: 0.18, base: 0.5, radius: 24 })};background-image:linear-gradient(180deg,rgba(238,164,78,.07),rgba(47,84,128,.09) 70%,rgba(254,255,252,.02))!important;margin:14px 0 14px 14px!important;overflow:hidden!important`),
  rule(sel("c-head"), "border-bottom-color:rgba(254,255,252,.1)!important;min-height:84px!important"),
  rule(sel("c-title"), serif(30, 1.1, "-.01em")),
  rule(sel("c-search"), `${pill("rgba(254,255,252,.2)", "rgba(7,10,18,.45)")};height:42px!important;padding-left:16px!important`),
  rule(sel("c-filters"), "border-bottom-color:rgba(254,255,252,.1)!important;gap:6px!important"),
  rule(sel("c-filter"), `${pill("rgba(246,241,228,.2)")}`),
  rule(sel("c-filter on"), `border-color:${AMBER}!important;background-color:rgba(238,164,78,.14)!important;${tone(AMBER)}`),
  rule(sel("c-conv"), "border-bottom-color:rgba(254,255,252,.07)!important"),
  rule(sel("c-conv on"), `background-color:transparent!important;background-image:linear-gradient(90deg,rgba(238,164,78,.2),rgba(238,164,78,.02))!important`),
  rule(sel("c-conv on", ' [data-ws~="c-name"]'), `color:${AMBER}!important`),
  rule(sel("c-mark"), `background-color:${AMBER}!important;box-shadow:0 0 12px 2px rgba(238,164,78,.7)!important`),
  rule(sel("c-name"), `font-family:${SERIF}!important;font-weight:400!important;font-size:15px!important;letter-spacing:.01em!important`),
  rule(sel("c-avatar"), "border:1px solid rgba(254,255,252,.32)!important;box-shadow:inset 0 0 14px rgba(254,255,252,.08)"),
  rule(sel("c-avatar", " div[dir]"), `font-family:${SERIF}!important;font-weight:400!important`),
  rule(sel("c-online"), `background-color:${AMBER}!important;border-color:${DEEP}!important`),
  rule(sel("c-dhead"), "background-color:transparent!important;border-bottom-color:rgba(254,255,252,.1)!important;min-height:84px!important"),
  rule(sel("c-dtitle"), serif(26, 1.15)),
  rule(sel("c-ro"), `${pill("rgba(134,198,230,.45)")};padding:0 10px!important;height:26px!important`),
  rule(sel("c-bubble in"), `${glass({ edge: 0.2, base: 0.46, radius: 18 })};border-top-left-radius:6px!important`),
  rule(sel("c-bubble own"), `background-color:rgba(65,161,207,.16)!important;background-image:none!important;border:1px solid rgba(65,161,207,.5)!important;border-radius:18px!important;border-top-right-radius:6px!important;box-shadow:0 0 24px -8px rgba(65,161,207,.6)!important`),
  rule(sel("c-system"), `${pill("rgba(246,241,228,.18)", "rgba(7,10,18,.4)")};align-self:center!important;padding:5px 12px!important;text-transform:none;letter-spacing:.06em!important;white-space:normal`),
  rule(sel("c-composer"), "background-color:rgba(7,10,18,.42)!important;border-top-color:rgba(254,255,252,.1)!important"),
  rule(sel("c-input"), `${pill("rgba(254,255,252,.2)", "rgba(7,10,18,.45)")};border-radius:22px!important;padding-left:16px!important;padding-right:16px!important`),
  rule(sel("c-send"), `${pill("rgba(246,241,228,.22)")};border-radius:50%!important`),
  rule(sel("c-send on"), `border-color:${BLUE}!important;background-color:rgba(65,161,207,.12)!important;box-shadow:0 0 18px -4px rgba(65,161,207,.7)!important;${tone(BLUE)}`),
  rule(sel("c-fact"), `${glass({ edge: 0.26, base: 0.44, radius: 20 })};align-items:flex-start!important;padding:14px 16px!important;min-height:96px!important`),
  rule(sel("c-factvalue"), figure(44)),
  rule(sel("c-sparklist"), glass({ edge: 0.2, base: 0.44, radius: 20 })),
  rule(sel("c-sectiontitle"), serif(17, 1.2, ".01em", 400)),
  rule(sel("c-sparkdays"), figure(30, { weight: 300, line: 1 })),

  // ---------- 探索 ----------
  rule(sel("e-title"), `${serif(60, 1.05, "-.025em")};margin-top:20px!important`),
  rule(sel("e-sub"), `font-size:14px!important;color:${CREAM}!important;opacity:.78;margin-top:-2px!important`),
  rule(sel("e-panel"), glass({ edge: 0.3, base: 0.46 })),
  rule(sel("e-tabs"), "border-bottom-color:rgba(254,255,252,.1)!important"),
  rule(sel("e-tab"), "border-bottom-color:transparent!important"),
  rule(sel("e-tab on"), `border-bottom-color:${AMBER}!important;${tone(AMBER)}`),
  rule(sel("e-tab on", " div[dir]"), "text-shadow:0 0 14px rgba(238,164,78,.6)"),
  rule(sel("e-searchrow", " input"), `color:${CREAM}!important`),
  rule(sel("e-empty"), `border:1px solid rgba(254,255,252,.22)!important;border-radius:28px!important;background:radial-gradient(50% 60% at 50% 38%,rgba(238,164,78,.2) 0%,rgba(238,164,78,0) 70%),${dots("rgba(246,241,228,.18)", 10, 1)},rgba(7,10,18,.36)!important;box-shadow:${INNER}!important;padding-top:64px!important;padding-bottom:64px!important;--ws-cyan:${AMBER}`),
  rule(sel("e-empty", " > svg"), "filter:drop-shadow(0 0 10px rgba(238,164,78,.7))"),
  rule(sel("e-box"), glass({ edge: 0.26, base: 0.46, radius: 20 })),
  // 弹窗压在遮罩上，夜色要实一些
  rule(sel("e-modal,w-dialog"), `${glass({ halo: true })};background-color:rgba(9,13,24,.92)!important`),
  rule(sel("e-name"), serif(26, 1.2)),
  rule(sel("e-name small"), serif(18, 1.25, "0", 400)),
  rule(sel("e-section"), serif(21, 1.25, "0")),

  // ---------- 窄屏：巨物收一档，别把标题挤成省略号 ----------
  "@media (max-width:899px){" + [
    rule(sel("s-top"), "height:auto!important;border-radius:28px!important;margin:12px 12px 0!important;padding-top:10px!important;padding-bottom:10px!important"),
    rule(sel("s-title"), "font-size:34px!important"),
    rule(sel("s-ops"), "padding:22px!important"),
    rule(sel("s-optitle"), "font-size:30px!important"),
    rule(sel("s-countvalue"), "font-size:46px!important"),
    rule(sel("s-seal"), "width:200px!important;height:264px!important"),
    rule(sel("s-year"), "font-size:78px!important"),
  ].join("") + "}",
  "@media (max-width:719px){" + [
    rule(sel("w-top"), "min-height:70px!important;padding-top:10px!important;padding-bottom:10px!important"),
    rule(sel("w-title"), "font-size:22px!important;margin-top:4px!important;max-width:none!important;flex-shrink:1"),
    rule(sel("w-count"), "font-size:20px!important;margin-left:2px!important"),
    rule(sel("btn square,w-mbtn"), "width:40px!important;height:40px!important"),
    rule(sel("w-top", ' [data-ws~="stamp-sig"]::before'), "width:20px"),
    rule(sel("e-title"), "font-size:38px!important"),
    rule(sel("w-htitle"), "font-size:38px!important"),
    rule(sel("w-hcount"), "font-size:84px!important"),
    rule(sel("w-hcountblock"), "width:auto!important"),
    rule(sel("c-list"), "margin:0!important;border-radius:0!important;border-width:0!important"),
    rule(sel("w-bignum"), "font-size:92px!important"),
  ].join("") + "}",
  "@media (max-width:559px){" + rule(sel("s-title"), "font-size:30px!important") + rule(sel("s-countvalue"), "font-size:40px!important") + rule(sel("s-count"), "min-height:104px!important") + "}",
  "@media (prefers-reduced-motion:reduce){" + rule(`${T} #root::before,${sel("s-seal", "::after")}`, "animation:none!important") + "}",
];

export const traceCss = blocks.join("\n");
