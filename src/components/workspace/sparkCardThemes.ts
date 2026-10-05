import type { ChatMemorial } from "../../domain/chatMemorial";
import { H, sparkCardLines, sparkCardText, W, type SparkCardStyle, type SparkCardTheme } from "./sparkCard";
import { archive } from "./sparkCardArchive";
import { poster } from "./sparkCardPoster";
import { trace } from "./sparkCardTrace";

export const SPARK_CARD_THEMES: Record<SparkCardStyle, SparkCardTheme> = { trace, archive, poster };

const fontSheets: Partial<Record<SparkCardStyle, Promise<void>>> = {};
function fontSheet(style: SparkCardStyle): Promise<void> {
  fontSheets[style] ??= new Promise<void>((resolve) => {
    const link = Object.assign(document.createElement("link"), { rel: "stylesheet", href: `https://fonts.googleapis.com/css2?${SPARK_CARD_THEMES[style].fontCss}&display=swap` });
    link.onload = link.onerror = () => resolve();
    setTimeout(resolve, 4000); // 离线或很慢：不等了，退回系统字体
    document.head.append(link);
  });
  return fontSheets[style]!;
}

export async function renderSparkCard(memorial: ChatMemorial, style: SparkCardStyle): Promise<HTMLCanvasElement> {
  const theme = SPARK_CARD_THEMES[style];
  const lines = sparkCardLines(memorial);
  await fontSheet(style);
  const text = sparkCardText(lines);
  await Promise.all(theme.fonts.map((font) => document.fonts.load(font, text))).catch(() => { /* 离线：系统字体 */ });
  const canvas = Object.assign(document.createElement("canvas"), { width: W, height: H });
  theme.draw(canvas.getContext("2d")!, lines);
  return canvas;
}

export async function saveSparkCard(canvas: HTMLCanvasElement, fileName: string): Promise<void> {
  const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((value) => (value ? resolve(value) : reject(new Error("toBlob returned null"))), "image/png"));
  const url = URL.createObjectURL(blob);
  const link = Object.assign(document.createElement("a"), { href: url, download: fileName });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
