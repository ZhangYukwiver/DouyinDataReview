import React from "react";
import { Image, Platform } from "react-native";
import { splitChatEmoji } from "../../domain/chatEmoji";

const webInline = Platform.OS === "web" ? ({ verticalAlign: "text-bottom" } as object) : null;

// 抖音内置小表情以文字代码传输（如 [宕机]），按字典换成行内小图，没收录的原样显示。放在 <Text> 里用。
export function renderEmojiText(text: string, size = 16): React.ReactNode {
  const parts = splitChatEmoji(text);
  if (!parts.some((part) => "emoji" in part)) return text;
  return parts.map((part, index) => "emoji" in part
    ? <Image accessibilityLabel={part.emoji} key={index} source={{ uri: part.url }} style={[{ width: size, height: size, marginHorizontal: 1 }, webInline]} />
    : part.text);
}
