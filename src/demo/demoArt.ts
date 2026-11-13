// 在线体验版的封面和头像：按主题配色现画的 SVG，演示采集器和演示创作者中心共用

export const TOPIC_COLORS: Record<string, [string, string]> = {
  美食: ["#f59e0b", "#9a3412"], 旅行: ["#38bdf8", "#1e3a8a"], 知识: ["#818cf8", "#1e1b4b"], 萌宠: ["#fda4af", "#9d174d"],
  科技: ["#34d399", "#064e3b"], 读书: ["#d6b98c", "#57391b"], 运动: ["#a3e635", "#166534"], 绘画: ["#f0abfc", "#6b21a8"],
  人文: ["#a8a29e", "#292524"], 生活: ["#fcd34d", "#b45309"], 音乐: ["#fb7185", "#4c0519"], 三农: ["#bef264", "#3f6212"],
  日常: ["#93c5fd", "#334155"], 搞笑: ["#fde047", "#c2410c"], 情感: ["#c4b5fd", "#4338ca"], 直播: ["#f472b6", "#831843"], 推荐: ["#cbd5e1", "#475569"],
};

// 封面、头像是现画的 SVG：localCollector 的 parseImageUrl、聊天头像只在这个构建里放行 data:image/svg+xml，长度要在 2048 以内
const svgUrl = (svg: string) => `data:image/svg+xml,${svg.replace(/[#<>%"]/gu, (char) => encodeURIComponent(char))}`;
const FONT = "PingFang SC,Microsoft YaHei,sans-serif";
const xml = (text: string) => text.replace(/[&<>]/gu, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[char]!);

// 封面大字：去掉 #话题，取逗号或竖线前那半句（太短就连上后半句），每行约 5 个汉字宽，英文单词不拆开，最多三行
function coverLines(title: string): string[] {
  const parts = title.replace(/\s*#\S+/gu, "").split(/[，,｜|]/u).map((part) => part.trim()).filter(Boolean);
  const hook = (parts[0]?.length ?? 0) >= 4 ? parts[0]! : parts.slice(0, 2).join(" ");
  const lines: string[] = [];
  let line = "";
  let width = 0;
  for (const token of hook.match(/[A-Za-z0-9]+|\s|./gu) ?? []) {
    const size = /\s/u.test(token) ? 0.3 : /^[A-Za-z0-9]/u.test(token) ? token.length * 0.6 : 1;
    if (width + size > 5.2 && line.trim()) {
      if (lines.push(line.trim()) === 3) return lines;
      line = "";
      width = 0;
    }
    line += token;
    width += size;
  }
  if (line.trim()) lines.push(line.trim());
  return lines;
}

export function cover(title: string, topic: string, n: number): string {
  const [from, to] = TOPIC_COLORS[topic] ?? TOPIC_COLORS.日常!;
  const lines = coverLines(title);
  const top = 210 - lines.length * 22;
  const text = lines.map((line, index) => `<tspan x='22' y='${top + index * 50}'>${xml(line)}</tspan>`).join("");
  return svgUrl(`<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 300 400'><defs><linearGradient id='g' x2='.6' y2='1'><stop stop-color='${from}'/><stop offset='1' stop-color='${to}'/></linearGradient></defs>`
    + `<rect width='300' height='400' fill='url(#g)'/><circle cx='${190 + (n % 5) * 20}' cy='${60 + (n % 3) * 35}' r='${55 + (n % 4) * 16}' fill='#fff' opacity='.15'/>`
    + `<text font-family='${FONT}' font-size='42' font-weight='800' fill='#fff' stroke='#000' stroke-opacity='.22' stroke-width='3' paint-order='stroke'>${text}</text></svg>`);
}

export function avatar(name: string, color: string): string {
  return svgUrl(`<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'><rect width='64' height='64' fill='${color}'/>`
    + `<text x='32' y='43' text-anchor='middle' font-family='${FONT}' font-size='28' font-weight='700' fill='#fff'>${xml([...name][0] ?? "")}</text></svg>`);
}

export const ACCOUNT_AVATAR = avatar("示", "#3f6212");
