/** 设置「关于」里的「本版更新」：只写这一版比上一版改了什么 */
export interface ReleaseNotes {
  version: string;
  title: string;
  notes: string[];
}

/**
 * 取 .github/release-notes.md 开头那一节：「## vX 标题」加上「- 」开头的每条改动（链接、粗体、代码标记只留文字），
 * 「验证」和后面的安装说明不要。格式对不上就返回 null，关于页不显示这一块。
 */
export function parseReleaseNotes(markdown: string): ReleaseNotes | null {
  const [head = "", ...lines] = (markdown.replace(/\r\n/gu, "\n").split("\n\n## ")[0] ?? "").split("\n");
  const [, version, title] = /^## v(\S+)\s+(.+)$/u.exec(head.trim()) ?? [];
  if (!version || !title) return null;
  const notes = lines
    .filter((line) => line.startsWith("- "))
    .map((line) => line.slice(2).replace(/\[([^\]]+)\]\([^)]+\)/gu, "$1").replace(/\*\*|`/gu, "").trim());
  return { version, title: title.trim(), notes };
}

// 发版只写 .github/release-notes.md：metro.config.js 打包时把原文放进这个变量，开发服务器和生产包都一样
export const RELEASE_NOTES = parseReleaseNotes(process.env.EXPO_PUBLIC_RELEASE_NOTES ?? "");
