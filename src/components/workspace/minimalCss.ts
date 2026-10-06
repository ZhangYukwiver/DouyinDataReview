/**
 * 极简风格的版式层：只挂在 :root[data-style="minimal"] 下，另外三种风格一条也匹配不到。
 * 颜色、字体、圆角由 token 给（workspaceTheme 的 minimal），这里只做“少”：
 * - 白底、侧栏 #FAFAFA、1px 发丝线分区，没有外框、投影、纹理、发光、渐变；
 * - 一种系统无衬线，字重只有 400 / 500 / 600，中文不拉字距，数字等宽，正文和标签不小于 12px
 *   （封面时长、未读数这类压在深色底上的角标除外）；
 * - 墨黑是选中和主按钮，蓝只给数据和可点的字，绿 / 琥珀 / 红只在状态上；图表分类色是蓝的深浅档加中性灰；
 * - 去掉装饰性的英文小标、编号水印、唱片圆盘、色条，缺封面是一块安静的浅灰；
 * - 悬停不抬、不放大，只换底色。
 * 写法同 posterCss / archiveCss：按 data-ws 角色选，声明一律 !important 压过 RN-web 的原子类和行内样式。
 * 只管工作台和它弹出的对话框；采集器页（MinimalSetupWorkspace）和设置面板各有自己的样式，这里不碰
 * （唯一例外是 body 上的 text-wrap:pretty，靠继承一起管到）。
 */
const M = ':root[data-style="minimal"]';
const INK = "#18181B";
const TEXT2 = "#3F3F46";
const MUTE = "#71717A";
const FAINT = "#A1A1AA";
const LINE = "#E4E4E7";
const SOFT = "#EFEFF1";
const RAIL = "#F4F4F5";
const SIDE = "#FAFAFA";
const WHITE = "#FFFFFF";
const BLUE = "#2563EB";
// 侧栏、会话列表里选中的那一项：比悬停的 #F4F4F5 深一档的浅灰
const PICKED = "#EBEBED";
const SANS = "var(--ws-font-body)";

/** 选中带某个角色的元素；"a b" 表示同一元素同时带 a 和 b。多个用逗号分开。 */
function sel(roles: string, suffix = ""): string {
  return roles.split(",").map((group) => `${M} ${group.trim().split(/\s+/u).map((role) => `[data-ws~="${role}"]`).join("")}${suffix}`).join(",");
}
const rule = (selector: string, body: string) => `${selector}{${body}}`;

// 工作台本体和它弹出的对话框（批量下载、纪念卡、探索里的确认框）
const SCOPES = ['[data-testid="content-workspace"]', '[data-ws~="w-dialog"]', '[data-ws~="e-modal"]'];
/** 工作台里的任意后代；:where 把优先级压到最低，按角色写的规则总能盖过它。 */
const within = (inner: string) => `${M} :where(${SCOPES.flatMap((scope) => inner.split("|").map((part) => `${scope} ${part}`)).join(",")})`;
/** 一组容器里的字（低优先级的“下限”，具体角色再覆盖）。 */
const textIn = (roles: string[]) => `${M} :where(${roles.map((role) => `[data-ws~="${role}"] [dir]`).join(",")})`;

/** 字号、字重、颜色；中文一律不拉字距。 */
const type = (size: number, weight = 400, tone?: string, line?: number) => [
  `font-size:${size}px!important`, `font-weight:${weight}!important`, "letter-spacing:0!important",
  ...(tone ? [`color:${tone}!important`] : []), ...(line ? [`line-height:${line}px!important`] : []),
].join(";");
/** 一块区域里用 token 上色的图标和字统一成一个颜色（按钮、选中项、占位图标）。 */
const tint = (tone: string) => [
  `--ws-text:${tone}`, `--ws-text-secondary:${tone}`, `--ws-text-muted:${tone}`, `--ws-figure:${tone}`,
  `--ws-accent:${tone}`, `--ws-cyan:${tone}`, `--ws-green:${tone}`, `--ws-amber:${tone}`,
  `--ws-white:${tone}`, `--ws-black:${tone}`, `--ws-canvas:${tone}`, `--ws-button-text:${tone}`,
].join(";");
const line = (edge: "top" | "bottom" | "left" | "right", tone = LINE) => `border-${edge}:1px solid ${tone}!important`;
const notDisabled = ':not([aria-disabled="true"])';
const TRANSITION = "transition:background-color .14s ease,border-color .14s ease,color .14s ease!important";

/**
 * 组件里为衬线体调的 700 / 800 / 900 / bold。RN-web 把字重编成原子类：开发版叫 r-fontWeight-<哈希>，
 * 打包版（expo export）只剩 r-<哈希>，哈希段两边一样（murmurhash("fontWeight" + 值)），所以两种类名都写上，
 * 不能按 r-fontWeight- 前缀去匹配。哈希由测试拿 RN-web 自己的 compiler 现算核对，RN-web 升级后对不上会报错。
 */
export const HEAVY_WEIGHT_HASHES = { "700": "b88u0q", "800": "1vr29t4", "900": "ovu0ai", bold: "vw2c0b" } as const;
const HEAVY = [
  ...Object.values(HEAVY_WEIGHT_HASHES).flatMap((hash) => [`.r-${hash}`, `.r-fontWeight-${hash}`]),
  // 不走 StyleSheet 的写法会落成行内 style
  ...Object.keys(HEAVY_WEIGHT_HASHES).map((weight) => `[style*="font-weight: ${weight}"]`),
].join("|");

const blocks: string[] = [
  // ---------- 底子 ----------
  // 段落最后一行别只剩一两个字（「就行。」「存好。」）：text-wrap 会继承，挂在 body 上采集器页、工作台、设置面板一起生效
  rule(`${M} body`, "-webkit-font-smoothing:antialiased;font-variant-numeric:tabular-nums;text-wrap:pretty"),
  // 700 以上的字重一律收成 600（见 HEAVY）；中文不拉字距，工作台里的字一律归零，不靠类名认
  rule(within(HEAVY), "font-weight:600!important"),
  rule(within("[dir]|[dir] *"), "letter-spacing:0!important"),
  rule(`${within("*")}::selection`, `background:#DBEAFE;color:${INK}`),
  rule(`${within(":focus-visible")}`, `outline:2px solid ${BLUE}!important;outline-offset:2px!important`),
  rule(within("input|textarea"), `caret-color:${BLUE}`),

  // ---------- 动效：悬停不抬不放大，只换底色；进场只淡入；不发光、不脉冲 ----------
  rule(`${M} [data-hover]`, TRANSITION),
  rule(`${M} [data-hover] svg`, "transition:none!important;transform:none!important"),
  rule(`${M} [data-hover="lift"]:hover,${M} [data-hover="card"]:hover,${M} [data-hover="raise"]:hover`, "transform:none!important;box-shadow:none!important"),
  rule(`${M} [data-hover="tint"]:hover`, `background-color:${RAIL}!important`),
  rule(`${M} [data-motion="rise"],${M} [data-reveal="in"],${M} [data-motion="pop"]`, "animation-name:ws-fade!important;animation-duration:.24s!important;animation-timing-function:ease-out!important"),
  rule(`${M} [data-motion="pulse"]`, "animation:none!important"),

  // ---------- 外壳：没有外框，侧栏 + 主区平铺，发丝线分开 ----------
  rule(`${M} [data-testid="content-workspace"]`, `padding:0!important;background-color:${WHITE}!important`),
  rule(sel("w-stage"), `border-width:0!important;border-radius:0!important;box-shadow:none!important;background-color:${WHITE}!important`),
  rule(sel("w-side"), `background-color:${SIDE}!important;${line("right")}`),
  rule(sel("w-side", " > div:first-child"), "margin-top:56px!important"),
  rule(sel("w-glider"), "display:none!important"),
  rule(sel("w-nav"), `min-height:40px!important;border-radius:8px!important;background-color:transparent!important`),
  rule(sel("w-navicon"), "background-color:transparent!important"),
  rule(sel("w-navlabel"), type(13, 400, TEXT2)),
  rule(sel("w-nav", " [dir]"), "letter-spacing:0!important"),
  rule(sel("w-replay", " [dir]"), type(13, 400, TEXT2)),
  rule(sel("w-navcount"), `${type(12, 400, MUTE)};font-family:${SANS}!important`),
  rule(sel("w-nav", `${notDisabled}:hover`), `background-color:${RAIL}!important`),
  rule(sel("w-nav on"), `background-color:${PICKED}!important;${tint(INK)}`),
  rule(sel("w-nav on", ' [data-ws~="w-navlabel"]'), type(13, 600, INK)),
  rule(sel("w-nav on", ' [data-ws~="w-navcount"]'), `color:${TEXT2}!important`),
  rule(sel("w-days"), "margin-top:16px!important;padding-right:0!important"),
  // 12px 的「2026 年有 110 天留下记录」要 143px：文字块借右边的 8px 内边距
  rule(sel("w-days", " > div:last-child"), "width:152px!important"),
  rule(sel("w-days", " [dir]"), `${type(12, 400, MUTE)};margin-left:6px!important`),
  rule(sel("w-settings"), `min-height:36px!important;border-radius:8px!important`),
  rule(sel("w-settings", " [dir]"), type(13, 500, INK)),

  // 顶栏：标题 + 条数，右边两颗 32px 的方钮
  rule(sel("w-top"), `height:56px!important;min-height:56px!important;${line("bottom")};background-color:${WHITE}!important`),
  rule(sel("w-title"), `${type(18, 600, INK)};font-family:${SANS}!important`),
  rule(sel("w-count"), `${type(13, 400, MUTE)};font-family:${SANS}!important`),

  // ---------- 按钮：主 = 墨黑实底，次 = 白底发丝线，方钮 32px ----------
  rule(sel("btn,btn-solid"), `border-radius:8px!important;border-width:1px!important;border-style:solid!important;box-shadow:none!important;transform:none!important;${TRANSITION}`),
  rule(sel("btn"), `background-color:${WHITE}!important;border-color:${LINE}!important;${tint(TEXT2)};--ws-text:${INK}`),
  rule(sel("btn", " [dir]"), type(13, 500, INK)),
  rule(sel("btn", `${notDisabled}:hover`), `background-color:${RAIL}!important`),
  rule(sel("btn-solid"), `background-color:${INK}!important;border-color:${INK}!important;${tint(WHITE)}`),
  rule(sel("btn-solid", " [dir]"), type(13, 500, WHITE)),
  rule(sel("btn-solid", `${notDisabled}:hover`), "background-color:#27272A!important"),
  rule(sel("btn small"), "border-radius:6px!important;padding-top:5px!important;padding-bottom:5px!important"),
  rule(sel("btn small", " [dir]"), type(12, 500, INK)),
  rule(sel("btn square"), `width:32px!important;height:32px!important;min-height:32px!important;padding:0!important`),
  rule(`${sel("btn on")},${sel("btn small on")},${sel("btn square on")}`, `background-color:${INK}!important;border-color:${INK}!important;${tint(WHITE)}`),
  rule(`${sel("btn on", " [dir]")},${sel("btn small on", " [dir]")}`, `color:${WHITE}!important`),
  // 侧栏收放钮：没有框的幽灵钮，悬停才有底（放在按钮规则后面，压过 btn 的白底发丝线）
  rule(sel("w-toggle"), `left:24px!important;top:12px!important;border-color:transparent!important;background-color:transparent!important;${tint(MUTE)}`),
  rule(sel("w-toggle", ":hover"), `background-color:${RAIL}!important;${tint(INK)}`),

  // ---------- 提示条：浅底、不带色条 ----------
  rule(sel("stamp-bar"), "border-width:0!important;border-radius:8px!important;min-height:36px!important;padding:8px 12px!important;box-shadow:none!important"),
  rule(sel("stamp-bar", " [dir]"), "font-size:12px!important;line-height:18px!important;letter-spacing:0!important"),
  rule(sel("stamp-bar", " [dir]:not([data-ws])"), "font-weight:500!important"),
  rule(sel("stamp-bar", ' [data-ws~="stamp"]'), "font-weight:600!important"),
  rule(sel("w-top", ' + [data-ws~="stamp-bar"]'), "margin:12px 28px 0!important"),

  // ---------- 记录：缺封面是一块安静的浅灰，没有唱片、编号水印、灰色压条 ----------
  rule(sel("w-ghead"), "min-height:0!important;margin-bottom:16px!important;row-gap:10px!important"),
  rule(sel("w-gtitle"), "display:none!important"),
  rule(sel("w-ghead", ' [data-ws~="mono"]'), `${type(12, 400, MUTE)};margin-top:0!important`),
  rule(sel("c-search"), `height:34px!important;border-radius:8px!important;border-color:${LINE}!important;background-color:${WHITE}!important;${TRANSITION}`),
  rule(sel("c-search", ":focus-within"), `border-color:${FAINT}!important`),
  rule(sel("c-search", " input"), `font-size:13px!important;color:${INK}!important;outline:none!important`),
  rule(sel("w-switch"), `height:34px!important;padding:2px!important;border-width:0!important;border-radius:8px!important;background-color:${RAIL}!important`),
  // 页头一排（搜索、批量下载、直播链接框、进入直播间、视图切换）都是 34 高，别有两颗 38 的凸出来
  rule(sel("w-ghead", ' [data-ws~="btn"]'), "height:34px!important;min-height:34px!important;padding-top:0!important;padding-bottom:0!important"),
  rule(sel("w-ghead", ' [data-ws~="c-input"]'), "height:34px!important"),
  rule(sel("w-lay"), `width:36px!important;height:30px!important;border-radius:6px!important;background-color:transparent!important;${TRANSITION}`),
  rule(sel("w-lay on"), `background-color:${WHITE}!important;box-shadow:inset 0 0 0 1px ${LINE}!important;${tint(INK)}`),
  rule(sel("w-tile"), "margin-bottom:24px!important"),
  rule(sel("w-cover"), "border-radius:8px!important"),
  // 悬停时封面原地放大：极简不放大
  rule(sel("w-cover", ' [style*="transition-property: transform"]'), "transform:none!important"),
  rule(sel("w-disc"), `width:auto!important;height:auto!important;border-width:0!important;background-color:transparent!important;${tint(FAINT)}`),
  rule(sel("w-bignum"), "display:none!important"),
  // 类型小圆点不要了，但占着位，时长角标仍靠右
  rule(sel("w-type"), "visibility:hidden!important"),
  rule(sel("w-cover", ' [data-ws~="stamp"]'), `${type(11, 500, WHITE)};background-color:rgba(24,24,27,.64)!important;border-radius:4px!important;padding:2px 6px!important`),
  rule(sel("w-tilebar"), "background-color:transparent!important;padding:8px!important"),
  rule(sel("w-tilebar", " > div:first-child:not(:last-child)"), "height:3px!important;border-radius:999px!important;background-color:rgba(255,255,255,.4)!important;margin-bottom:6px!important"),
  rule(sel("w-tilebar", " > div:first-child:not(:last-child) > div"), "height:3px!important;border-radius:999px!important"),
  rule(sel("w-tilebar", " > div:last-child"), "align-self:flex-start!important;padding:2px 7px!important;border-radius:999px!important;background-color:rgba(24,24,27,.64)!important"),
  rule(sel("w-tilebar", ' [data-ws~="mono"]'), type(11, 500, WHITE)),
  // 没有封面时：角标和播放数直接写在浅灰上
  rule(`${M} [data-ws~="w-cover"]:has([data-ws~="w-disc"]) [data-ws~="stamp"]`, `background-color:transparent!important;color:${MUTE}!important;padding-right:0!important`),
  rule(`${M} [data-ws~="w-cover"]:has([data-ws~="w-disc"]) [data-ws~="w-tilebar"] > div:last-child`, `background-color:transparent!important;padding-left:0!important;${tint(MUTE)}`),
  rule(`${M} [data-ws~="w-cover"]:has([data-ws~="w-disc"]) [data-ws~="w-tilebar"] [data-ws~="mono"]`, `color:${MUTE}!important`),
  rule(`${M} [data-ws~="w-cover"]:has([data-ws~="w-disc"]) [data-ws~="w-tilebar"] > div:first-child:not(:last-child)`, "background-color:rgba(24,24,27,.08)!important"),
  rule(textIn(["w-tile", "w-row", "w-card", "w-batch", "w-ghead", "d-tile", "w-days"]), "font-size:12px!important;letter-spacing:0!important"),
  rule(sel("w-tiletitle"), `${type(13, 500, INK, 19)};margin-top:10px!important`),
  rule(sel("w-tiletitle", " + div [dir]"), `color:${MUTE}!important`),
  rule(sel("w-overlay"), "background-color:rgba(24,24,27,.36)!important;border-width:0!important;border-radius:8px!important;box-shadow:none!important"),
  rule(sel("w-play"), `width:52px!important;height:52px!important;margin:-26px 0 0 -26px!important;border-width:0!important;background-color:rgba(255,255,255,.94)!important;box-shadow:none!important;${tint(INK)}`),
  rule(sel("w-tileaction"), `min-height:32px!important;border-width:0!important;border-radius:8px!important;background-color:${WHITE}!important;${tint(INK)};${TRANSITION}`),
  rule(sel("w-tileaction", `${notDisabled}:hover`), `background-color:${RAIL}!important`),
  rule(sel("w-tileaction", " [dir]"), type(12, 500, INK)),
  rule(sel("w-check"), `border-radius:6px!important;border-color:${FAINT}!important`),
  rule(sel("w-check on"), `border-color:${INK}!important;background-color:${INK}!important`),
  rule(sel("w-row"), `${line("bottom", SOFT)};padding-top:12px!important;padding-bottom:12px!important`),
  rule(sel("w-thumb"), `border-radius:6px!important;${tint(FAINT)}`),
  rule(sel("w-rowtitle"), type(14, 500, INK, 20)),
  rule(sel("w-rowtitle", " + [dir]"), `color:${TEXT2}!important`),
  rule(sel("w-row", ' [data-ws~="mono"]'), `color:${MUTE}!important`),
  rule(sel("w-row", ' [data-ws~="stamp-sig"]'), type(12, 400, MUTE)),
  rule(sel("w-batch"), `padding:12px 28px!important;background-color:${SIDE}!important;${line("bottom")}`),
  rule(sel("w-batch", " > [dir]:first-child"), type(13, 500, INK)),
  rule(sel("w-batch", " > [dir]:last-child"), `color:${MUTE}!important`),

  // 空状态：浅灰圆角方块里一个灰图标，标题 16px
  rule(sel("w-emptyicon"), `width:48px!important;height:48px!important;border-width:0!important;border-radius:12px!important;background-color:${RAIL}!important;box-shadow:none!important;${tint(MUTE)}`),
  rule(sel("w-emptytitle"), `${type(16, 600, INK)};font-family:${SANS}!important;margin-top:16px!important`),
  rule(sel("w-emptytitle small"), "font-size:15px!important"),
  rule(sel("w-emptytitle", " + [dir]"), `font-size:13px!important;line-height:20px!important;color:${MUTE}!important`),
  rule(sel("w-emptytitle", ' ~ [data-ws~="btn-solid"]'), "min-height:36px!important;border-radius:8px!important;padding:0 14px!important;margin-top:20px!important"),

  // ---------- 变化线索：页头只留一句说明（标题和条数顶栏已经有了），卡片一圈发丝线 ----------
  rule(sel("w-hhead"), `min-height:0!important;padding:4px 0 20px!important;${line("bottom")}`),
  rule(`${sel("w-hhead", ' [data-ws~="stamp-sig"]')},${sel("w-htitle,w-hcountblock")}`, "display:none!important"),
  rule(sel("w-htitle", " + [dir]"), `${type(14, 400, TEXT2, 22)};margin-top:0!important`),
  rule(sel("w-card"), `border:1px solid ${LINE}!important;border-radius:12px!important;box-shadow:none!important;background-color:${WHITE}!important`),
  rule(sel("w-card void"), "opacity:1!important"),
  // 窄窗口里三张一排放不下 260 的最小宽度，会掉成两张一排、右边空一大块：改成按三等分排
  rule(`${M} [data-testid="highlights-view"] [data-ws~="w-card"]`, "min-width:0!important;width:calc((100% - 28px) / 3)!important"),
  rule(sel("w-hvisual"), `height:160px!important;background-color:${RAIL}!important;${tint(FAINT)}`),
  rule(sel("w-hlabel"), `min-height:24px!important;padding:0 8px!important;border:1px solid ${LINE}!important;border-radius:6px!important;background-color:${WHITE}!important`),
  rule(sel("w-hlabeltext"), type(12, 500, TEXT2)),
  rule(sel("w-cardtitle"), `${type(14, 600, INK, 20)};font-family:${SANS}!important`),
  rule(sel("w-cardtitle", " ~ [dir]"), `font-size:12px!important;line-height:18px!important`),
  rule(sel("w-hrule"), line("top", SOFT)),
  rule(sel("w-hrule", " [dir]"), `color:${MUTE}!important`),
  rule(sel("w-foot"), `border-width:0!important;border-radius:8px!important;background-color:${SIDE}!important;padding:12px 16px!important;${tint(MUTE)}`),
  rule(sel("w-foot", " [dir]"), type(12, 400, TEXT2, 18)),
  rule(sel("w-notice"), `${type(12, 400)};line-height:18px!important;${line("top", SOFT)}`),
  // 持续报告里的线索卡（living）：小标、状态、信号行
  rule(sel("w-card", ' [data-ws~="stamp"]'), type(12, 500, MUTE)),
  rule(sel("w-card", ' [data-ws~="stamp"] + [dir]'), type(12, 500)),
  rule(sel("w-card", ' [data-ws~="w-cardtitle"] + [dir]'), `font-size:13px!important;line-height:20px!important`),

  // ---------- 持续报告：发丝线卡片，标题一行中文，大数字等宽 ----------
  rule(`${M} [data-testid="report-dashboard"] > div`, "padding-left:28px!important;padding-right:28px!important"),
  rule(sel("d-tile"), `padding:16px!important;border:1px solid ${LINE}!important;border-radius:12px!important;box-shadow:none!important;background-color:${WHITE}!important;${TRANSITION}`),
  rule(`${M} [data-ws~="d-tile"][data-hover="lift"]:hover`, "border-color:#D4D4D8!important"),
  rule(sel("d-head"), "align-items:baseline!important;column-gap:8px!important"),
  rule(sel("d-title"), `${type(14, 600, INK)};font-family:${SANS}!important`),
  rule(sel("d-en,d-latin"), "display:none!important"),
  rule(sel("d-meta"), `${type(12, 400, MUTE)};margin-left:auto!important`),
  rule(sel("d-figure"), `${type(32, 500, INK, 40)};font-family:${SANS}!important;font-variant-numeric:tabular-nums!important`),
  rule(sel("d-foot"), `${line("top", SOFT)};margin-top:12px!important;padding-top:12px!important`),
  rule(sel("d-foot", ' [data-ws~="d-mark"]'), "display:none!important"),
  rule(sel("d-foot", " [dir]"), `line-height:18px!important;color:${MUTE}!important`),
  rule(sel("d-tile", ' [data-ws~="mono"]'), `${type(12, 400, MUTE)};font-family:${SANS}!important`),
  // 一周热力的行头：M T W… 换成中文的一二三
  rule(sel("d-wk"), "font-size:0!important;width:14px!important"),
  ...["一", "二", "三", "四", "五", "六", "日"].map((day, index) => rule(`${M} [data-testid="report-tile-heat"] div:nth-child(${index + 1}) > [data-ws~="d-wk"]::after`, `content:"${day}";font-size:12px;color:${MUTE}`)),
  rule(sel("d-ringvalue"), `${type(20, 500, INK)};font-family:${SANS}!important`),
  rule(sel("d-num"), `${type(12, 500)};font-family:${SANS}!important;font-variant-numeric:tabular-nums!important`),
  rule(sel("d-num big"), type(18, 500, INK)),
  rule(sel("d-rank"), `${type(12, 500, MUTE)};font-family:${SANS}!important`),
  rule(sel("d-mosaic"), "border-width:0!important;border-radius:6px!important"),
  rule(sel("d-mosaic hi", " div[dir]"), `color:${WHITE}!important`),
  rule(sel("d-track"), `height:8px!important;border-radius:999px!important;overflow:hidden!important;background-color:${RAIL}!important`),
  rule(sel("d-track", " > div"), "height:8px!important;border-radius:999px!important"),
  rule(sel("d-cell"), `border-radius:8px!important;background-color:${SIDE}!important;padding:10px 12px!important`),
  rule(sel("d-mcell"), "border-radius:3px!important"),
  rule(sel("d-mcell pos"), `background-color:${BLUE}!important`),
  rule(sel("d-mcell neg"), `background-color:${INK}!important`),
  rule(sel("d-event"), `min-height:36px!important;${line("bottom", SOFT)}`),
  rule(sel("d-event", " [dir]:not([data-ws])"), `font-size:13px!important;color:${TEXT2}!important`),
  rule(sel("d-ititle"), type(13, 600, INK, 20)),
  // 意外发现：✦ 换成一颗小圆点，observed / pending 换成中文
  rule(sel("d-mark"), `font-size:0!important;line-height:0!important;width:6px!important;min-width:6px!important;height:6px!important;padding:0!important;margin-top:7px!important;border-radius:50%!important;background-color:${BLUE}!important`),
  rule(sel("d-mark off"), "background-color:#D4D4D8!important"),
  rule(`${sel("d-tile", ' [data-ws~="stamp-sig"]')},${sel("d-tile", ' [data-ws~="stamp-ghost"]')}`, "font-size:0!important;letter-spacing:0!important"),
  rule(sel("d-tile", ' [data-ws~="stamp-sig"]::after'), `content:"已点亮";font-size:12px;color:${BLUE}`),
  rule(sel("d-tile", ' [data-ws~="stamp-ghost"]::after'), `content:"还没点亮";font-size:12px;color:${MUTE}`),
  rule(sel("d-empty"), `color:${MUTE}!important`),
  // 面积图：填充压到极淡；长尾和雷达也用数据蓝
  rule(["hours", "months", "daynight"].map((key) => `${M} [data-testid="report-tile-${key}"] svg path:not([fill="none"])`).join(","), "fill-opacity:.07!important"),
  rule(`${M} [data-testid="report-tile-tail"] svg path:not([fill="none"])`, `fill:${BLUE}!important;fill-opacity:.06!important`),
  rule(`${M} [data-testid="report-tile-tail"] svg path[fill="none"]`, `stroke:${BLUE}!important`),
  rule(`${M} [data-testid="report-tile-radar"] svg path:last-of-type`, `fill:${BLUE}!important;fill-opacity:.08!important;stroke:${BLUE}!important;stroke-width:1.5px!important`),
  // 漏斗末档、集中度环：GOLD 在极简里是墨黑，换成深一档的数据蓝；维恩「喜欢」用中性灰，和观看 / 收藏两种蓝分开
  rule(`${M} [data-testid="report-tile-funnel"],${M} [data-testid="report-tile-concentration"]`, "--ws-accent:#1E40AF"),
  rule(`${M} [data-testid="report-tile-venn"]`, `--ws-accent:${MUTE}`),
  // 维恩、雷达的标签是 SVG 字，字号写在行内（9 / 9.5px），[dir] 的 12px 下限管不到；维恩最后一个 text 是中间 13px 的交集数，不动
  rule(`${M} [data-testid="report-tile-venn"] svg text:not(:last-of-type),${M} [data-testid="report-tile-radar"] svg text`, "font-size:12px!important"),
  // 雷达最上面的标签放大后会顶出 svg 上沿几像素；左右两个标签（第 2、5 个）居中会压到外圈顶点，改成朝外对齐
  rule(`${M} [data-testid="report-tile-radar"] svg`, "overflow:visible!important"),
  rule(`${M} [data-testid="report-tile-radar"] svg text:nth-of-type(2)`, "text-anchor:start!important"),
  rule(`${M} [data-testid="report-tile-radar"] svg text:nth-of-type(5)`, "text-anchor:end!important"),
  // 图上的字（报告、创作者中心）没设字体时会落到浏览器默认的衬线体
  rule(`${M} [data-testid="content-workspace"] svg text`, `font-family:${SANS}`),
  // 补位块：白底上一群蓝点，提示字 12px
  rule(sel("d-swarm"), `background-color:${WHITE}!important;--ws-accent:${BLUE};--ws-cyan:${BLUE}`),
  rule(sel("d-swarmhint"), `${type(12, 400, MUTE)};opacity:1!important`),

  // ---------- 聊天 ----------
  // 聊天里的说明字原来 8–10px：一律不小于 12px（头像缩写、未读数按自己的大小）
  rule(`${M} :where([data-testid="chat-workspace"] [dir]:not([data-ws~="c-avatar"] *):not([data-ws~="c-badge"] *))`, "font-size:12px!important;letter-spacing:0!important"),
  rule(sel("c-bar"), `background-color:${SIDE}!important;${line("bottom")}`),
  rule(sel("c-bar", ' [data-ws~="mono"]'), type(12, 400, TEXT2)),
  rule(sel("c-list"), `background-color:${SIDE}!important;${line("right")}`),
  rule(sel("c-head"), `min-height:64px!important;${line("bottom")}`),
  rule(sel("c-title"), `${type(16, 600, INK)};font-family:${SANS}!important`),
  rule(sel("c-head", ' [data-ws~="mono"]'), type(12, 400, MUTE)),
  rule(sel("c-badge"), `min-width:16px!important;height:16px!important;border-width:0!important;padding:0 4px!important`),
  rule(sel("c-badge", " [dir]"), type(10, 600, WHITE)),
  rule(sel("c-list", ' [data-ws~="c-search"]'), "margin-top:12px!important"),
  rule(sel("c-filters"), `min-height:44px!important;gap:4px!important;${line("bottom")}`),
  rule(sel("c-filter"), `height:28px!important;border-radius:6px!important;background-color:transparent!important;${tint(MUTE)}`),
  rule(sel("c-filter", " [dir]:first-child"), type(13, 500)),
  rule(sel("c-filter", " [dir]:last-child"), `${type(12, 400)};color:${FAINT}!important`),
  rule(sel("c-filter", `${notDisabled}:hover`), `background-color:${RAIL}!important`),
  rule(sel("c-filter on"), `background-color:${PICKED}!important;${tint(INK)}`),
  rule(sel("c-filter on", " [dir]:last-child"), `color:${MUTE}!important`),
  rule(sel("c-conv"), line("bottom", SOFT)),
  rule(sel("c-conv on"), `background-color:${PICKED}!important`),
  rule(sel("c-mark"), "display:none!important"),
  rule(sel("c-name"), `${type(14, 600, INK)};font-family:${SANS}!important`),
  rule(sel("c-conv", ' [data-ws~="mono"]'), `font-size:12px!important;color:${MUTE}!important;font-weight:400!important`),
  rule(sel("c-avatar"), `background-color:${RAIL}!important;border-color:transparent!important`),
  rule(sel("c-avatar", " > div[dir]"), `color:${TEXT2}!important;font-weight:500!important;letter-spacing:0!important`),
  rule(`${sel("c-avatar", " > svg")},${sel("c-avatar", " > svg *")}`, "stroke:#52525B!important"),
  rule(sel("c-online"), `border-color:${WHITE}!important;box-shadow:none!important`),
  // 详情
  rule(sel("c-dhead"), `min-height:64px!important;background-color:${WHITE}!important;${line("bottom")}`),
  rule(sel("c-dhead", ' + [data-ws~="stamp-bar"]'), "margin:12px 20px 0!important"),
  rule(sel("c-dtitle"), `${type(15, 600, INK)};font-family:${SANS}!important`),
  rule(sel("c-dhead", " [dir]:not([data-ws])"), "font-size:12px!important"),
  rule(sel("c-dhead", ' [data-ws~="mono"]'), type(12, 400, MUTE)),
  rule(sel("c-ro"), `height:auto!important;padding:0 4px!important;border-width:0!important;background-color:transparent!important;${tint(MUTE)}`),
  rule(sel("c-ro", " [dir]"), type(12, 400, MUTE)),
  rule(sel("c-bubble"), "border-radius:12px!important"),
  rule(sel("c-bubble in"), `border:1px solid ${LINE}!important;background-color:${WHITE}!important;border-top-left-radius:4px!important`),
  rule(sel("c-bubble own"), `border:1px solid ${RAIL}!important;background-color:${RAIL}!important;border-top-right-radius:4px!important`),
  rule(sel("c-bubble", " [dir]"), "font-size:13px!important;line-height:20px!important"),
  rule(sel("c-system"), `${type(12, 400, MUTE, 18)};border-radius:999px!important;padding:4px 12px!important;background-color:${RAIL}!important`),
  rule(`${M} [data-testid="chat-workspace"] [data-ws~="c-bubble"] ~ [data-ws~="mono"]`, `color:${MUTE}!important`),
  rule(sel("c-composer"), `background-color:${WHITE}!important;${line("top")}`),
  rule(sel("c-input"), `border:1px solid ${LINE}!important;border-radius:8px!important;background-color:${WHITE}!important;font-size:13px!important;outline:none!important;${TRANSITION}`),
  rule(sel("c-input", ":focus"), `border-color:${FAINT}!important`),
  rule(sel("c-send"), `width:36px!important;height:36px!important;border-radius:8px!important;background-color:${RAIL}!important;${TRANSITION}`),
  rule(sel("c-send on"), `background-color:${INK}!important`),
  // 群聊摘要、火花看板
  rule(sel("c-fact"), `min-height:76px!important;border:1px solid ${LINE}!important;border-radius:12px!important;background-color:${WHITE}!important`),
  rule(sel("c-factvalue"), `${type(24, 600, INK, 30)};font-family:${SANS}!important;font-variant-numeric:tabular-nums!important`),
  rule(sel("c-factvalue", " + [dir]"), type(12, 400, MUTE)),
  rule(sel("c-sectiontitle"), `${type(14, 600, INK)};font-family:${SANS}!important`),
  rule(sel("c-sectiontitle", " + [dir]"), type(12, 400, MUTE)),
  rule(sel("c-sparklist"), `border:1px solid ${LINE}!important;border-radius:12px!important;box-shadow:none!important;background-color:${WHITE}!important`),
  rule(sel("c-sparklist", ' [data-ws~="c-avatar"] + div > [dir]:first-child'), type(14, 500, INK)),
  rule(sel("c-sparkstrip"), `--ws-amber:${BLUE}`),
  rule(sel("c-sparkstrip", " > div"), "border-radius:2px!important"),
  // 天数一栏收窄一点，把地方让给状态说明
  rule(sel("c-sparklist", ' [role="button"] > div:last-child'), "width:84px!important"),
  rule(sel("c-sparkdays"), `${type(20, 600, INK)};font-family:${SANS}!important;font-variant-numeric:tabular-nums!important`),
  // 一键续火花：选中、勾选、开始按钮都是墨黑
  rule(`${M} [data-testid="chat-spark-renew"]`, `--ws-amber:${INK}`),
  rule(`${M} [data-testid="chat-spark-renew"] [data-ws~="c-avatar"] + div > [dir]:first-child`, "font-size:13px!important"),

  // ---------- 探索 ----------
  // 英文眉题和它旁边的连接状态一起收掉：没连上时下面的空状态会写明
  rule(`${M} [data-testid="explore-workspace"] div:has(> [data-ws~="stamp-sig"])`, "display:none!important"),
  rule(`${M} [data-testid="explore-workspace"] > div`, "padding:28px!important;padding-bottom:64px!important"),
  rule(sel("e-title"), `${type(24, 600, INK, 32)};font-family:${SANS}!important;margin-top:0!important`),
  rule(sel("e-sub"), type(14, 400, MUTE, 22)),
  rule(sel("e-panel,e-box"), `border:1px solid ${LINE}!important;border-radius:12px!important;box-shadow:none!important;background-color:${WHITE}!important`),
  rule(sel("e-tabs"), `${line("bottom", SOFT)};gap:24px!important`),
  rule(sel("e-tab"), `${tint(MUTE)};${TRANSITION}`),
  rule(sel("e-tab on"), `border-bottom-color:${INK}!important;${tint(INK)}`),
  rule(sel("e-searchrow", " input"), `font-size:14px!important;color:${INK}!important;outline:none!important`),
  // 空状态的图标一律灰：探索用 cyan、创作者中心用 accent（极简里是墨黑），两个都换掉
  rule(sel("e-empty"), `background-color:transparent!important;border-width:0!important;padding-top:56px!important;--ws-cyan:${MUTE};--ws-accent:${MUTE}`),
  rule(sel("e-empty", ' [data-ws~="w-emptytitle"]'), "margin-top:4px!important"),
  // 标题下第二行说明原来 11px
  rule(sel("e-empty", ' [data-ws~="w-emptytitle"] + [dir] + [dir]'), type(12, 400, MUTE, 18)),
  rule(sel("e-empty", ' [data-ws~="btn-solid"]'), "margin-top:4px!important;min-height:36px!important"),
  rule(sel("e-name"), `font-family:${SANS}!important;font-weight:600!important`),
  rule(sel("e-section"), `${type(16, 600, INK)};font-family:${SANS}!important`),
  rule(sel("e-badge"), `${type(11, 500, WHITE)};background-color:rgba(24,24,27,.64)!important;border-radius:4px!important`),

  // ---------- 创作者中心 ----------
  // 图表数据色：CreatorCharts 的 chartPalette 先取 --ws-chart-N（另外三种风格没定义，回退到原 token）。
  // 极简接持续报告饼图那组：主数据是蓝，分类是蓝的深浅档 + 中性灰，不借绿 / 琥珀 / 红；选中、标签仍是墨黑
  rule(M, Array.from({ length: 6 }, (_, index) => `--ws-chart-${index}:var(--ws-slices-${index})`).join(";")),
  // 刻度、轴名、说明、表头原来 10–11px；刻度字放大后最长的「62.5万」会贴到 svg 左沿，放开裁切
  rule(`${M} [data-testid="creator-workspace"] svg text`, "font-size:12px!important"),
  rule(`${M} [data-testid="creator-workspace"] svg`, "overflow:visible!important"),
  // 折线下的面积、雷达「我的指标」的填充压到和持续报告一样淡（组件里是 12% / 22%）
  rule(`${M} [data-testid="creator-workspace"] svg path:not([fill="none"])`, "fill-opacity:.6!important"),
  rule(`${M} [data-testid="creator-workspace"] svg polygon:last-of-type`, "fill-opacity:.4!important"),
  rule(sel("cr-note"), "font-size:12px!important;letter-spacing:0!important"),
  // 封面角标和记录页、探索的角标一样 11px
  rule(sel("cr-badge"), "font-size:11px!important;letter-spacing:0!important"),
  // 选中的指标块：e-box 那条把边框和底色统一掉了，补回墨黑描边
  rule(sel("e-box on"), `border-color:${INK}!important;background-color:${SIDE}!important`),

  // ---------- 对话框：一圈发丝线，没有投影 ----------
  rule(`${sel("w-dialog", ':not([data-testid="settings-dialog"])')},${sel("e-modal")}`, `border:1px solid ${LINE}!important;border-radius:12px!important;box-shadow:none!important;background-color:${WHITE}!important`),
  rule(`${M} [data-testid="batch-download-dialog"]`, "padding:24px!important;gap:12px!important"),
  rule(`${M} [data-testid="batch-download-dialog"] > [role="heading"]`, `${type(16, 600, INK)};font-family:${SANS}!important`),
  rule(`${M} [data-testid="batch-download-dialog"] [role="button"]`, `min-height:34px!important;justify-content:center!important;padding:0 14px!important;border-radius:8px!important;${TRANSITION}`),
  rule(`${M} [data-testid="batch-download-dialog"] [role="button"] [dir]`, "font-size:13px!important;font-weight:500!important"),
  rule(`${M} [data-testid="batch-download-dialog"] [role="progressbar"]`, `height:4px!important;border-radius:999px!important;background-color:${RAIL}!important`),
  rule(`${M} [data-testid="batch-download-dialog"] [role="progressbar"] > div`, "height:4px!important"),
  rule(`${M} [data-testid="spark-card-preview"]`, "padding:20px!important;gap:24px!important"),
  rule(`${M} [data-testid="spark-card-preview"] [role="heading"]`, `${type(16, 600, INK)};font-family:${SANS}!important`),
  rule(`${M} [data-testid="spark-card-preview"] [role="radio"]`, `min-height:40px!important;padding:0 12px!important;border:1px solid ${LINE}!important;border-radius:8px!important;background-color:${WHITE}!important`),
  rule(`${M} [data-testid="spark-card-preview"] [role="radio"] [dir]`, type(13, 400, TEXT2)),
  rule(`${M} [data-testid="spark-card-preview"] [role="radio"] [dir] + [dir]`, type(12, 400, MUTE)),
  rule(`${M} [data-testid="spark-card-preview"] [role="radio"][aria-checked="true"]`, `border-color:${INK}!important;background-color:${SIDE}!important`),
  rule(`${M} [data-testid="spark-card-preview"] [role="radio"][aria-checked="true"] [dir]:first-child`, `color:${INK}!important;font-weight:600!important`),
  rule(`${M} [data-testid="spark-card-preview"] [data-testid="spark-card-save"],${M} [data-testid="spark-card-preview"] [data-testid="spark-card-close"]`, "min-height:36px!important;justify-content:center!important;padding:0 14px!important"),

  // 窄窗口（桌面最小 900 宽）：火花行里的两周小方格缩一号，状态说明少折行
  "@media (max-width:1180px){" + [
    rule(sel("c-sparkstrip"), "gap:2px!important"),
    rule(sel("c-sparkstrip", " > div"), "width:6px!important;height:6px!important"),
  ].join("") + "}",
];

export const minimalCss = blocks.join("\n");
