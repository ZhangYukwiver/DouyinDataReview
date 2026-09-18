import douyinEmoji from "./douyinEmoji.json";

export type ChatTextPart = { text: string } | { emoji: string; url: string };

const EMOJI_URLS: Record<string, string> = douyinEmoji;
export const CHAT_EMOJI: ReadonlyArray<readonly [code: string, url: string]> = Object.entries(EMOJI_URLS);

// 抖音内置小表情在私信里以文字代码传输（如 [宕机]），这里按字典切成文字段和表情段；没收录的代码保留原文。
export function splitChatEmoji(text: string): ChatTextPart[] {
  const parts: ChatTextPart[] = [];
  for (const piece of text.split(/(\[[^[\]]{1,8}\])/u)) {
    if (!piece) continue;
    const url = EMOJI_URLS[piece];
    parts.push(url ? { emoji: piece, url } : { text: piece });
  }
  return parts;
}
