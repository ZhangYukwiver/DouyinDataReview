/** 设置「关于」里的更新记录：每版只写这一版比上一版改了什么 */
export interface ReleaseNotes {
  version: string;
  title: string;
  notes: string[];
}

/**
 * 取每个「## vX 标题」节：标题加上「- 」开头的每条改动（链接、粗体、代码标记只留文字），
 * 「验证」和「## 安装」这类别的节不要。可以是几份 .github/release-notes.md 拼在一起，同一版只留第一次出现的。
 */
export function parseReleaseNotes(markdown: string): ReleaseNotes[] {
  const releases: ReleaseNotes[] = [];
  for (const section of `\n\n${markdown.replace(/\r\n/gu, "\n")}`.split("\n\n## ")) {
    const [head = "", ...lines] = section.split("\n");
    const [, version, title] = /^v(\S+)\s+(.+)$/u.exec(head.trim()) ?? [];
    if (!version || !title || releases.some((release) => release.version === version)) continue;
    const notes = lines
      .filter((line) => line.startsWith("- "))
      .map((line) => line.slice(2).replace(/\[([^\]]+)\]\([^)]+\)/gu, "$1").replace(/\*\*|`/gu, "").trim());
    releases.push({ version, title: title.trim(), notes });
  }
  return releases;
}

// 发版只写 .github/release-notes.md：metro.config.js 打包时把它和前几个发版标签里的同一个文件拼在一起放进这个变量
export const RELEASE_NOTES = parseReleaseNotes(process.env.EXPO_PUBLIC_RELEASE_NOTES ?? "").slice(0, 5);
