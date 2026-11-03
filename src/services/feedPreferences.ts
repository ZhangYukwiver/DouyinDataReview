import { loadFeedWords, saveFeedWords } from "./appStyle";
import { collectorFeedFilter } from "./localCollector";

/** 采集器保存软件和网页共用的词条；本机存档只用于旧版迁移及离线回退。 */
export async function readFeedPreferences(baseUrl: string, token: string) {
  const cached = loadFeedWords();
  let settings = await collectorFeedFilter(baseUrl, token);
  if (settings.words === null) settings = await collectorFeedFilter(baseUrl, token, { words: loadFeedWords().slice(0, 2000) });
  const words = settings.words ?? loadFeedWords();
  // 翻页的后台读取可能比用户刚点的保存更晚回来，不让旧响应盖掉新缓存。
  if (loadFeedWords() === cached) saveFeedWords(words);
  return { ...settings, words };
}
