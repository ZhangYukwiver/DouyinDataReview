import type { StoryData } from "../services/storyData";
import { nativeBridge } from "./nativeBridge";

export const STORY_PAGES = ["story-entry.html", "story-draft_副本.html", "story-archive.html", "story-poster.html"] as const;
export type StoryPage = typeof STORY_PAGES[number];
const SKY = ["sky-s0-dawn", "sky-s1-morning", "sky-s2-dusk", "sky-s3-night", "sky-s4-ember"];
const json = (value: unknown) => JSON.stringify(value).replace(/</gu, "\\u003c").replace(/\u2028/gu, "\\u2028").replace(/\u2029/gu, "\\u2029");
const code = (value: string) => value.replace(/<\/script/giu, "<\\/script");

export function storyExportScript(page: StoryPage, bridgeId: string, requestId: string): string {
  return `(()=>{const privacy=document.body.classList.contains('privacy-on');const data=privacy?window.StoryExport.scrub(window.__STORY_EXPORT__.data,{privateTopics:${page === "story-archive.html"}}):window.__STORY_EXPORT__.data;window.ReactNativeWebView.postMessage(JSON.stringify({type:'story-export',bridgeId:${json(bridgeId)},requestId:${json(requestId)},privacy,data}));})();true;`;
}

export async function storyDocument(page: StoryPage, data: StoryData, { offline = false, privacy = false, bridgeId = "" } = {}): Promise<string> {
  // The stories were written for the desktop collector; here the records live on the phone.
  let html = (await nativeBridge.readStoryAsset(page)).replaceAll("这台电脑", "这台手机");
  const assets: Record<string, string> = {};
  if (offline && page === "story-draft_副本.html") {
    for (const key of SKY) assets[key] = await nativeBridge.readStoryAsset(`story-images/${key}-m.jpg`);
  }
  let entryTextures = "";
  if (page === "story-entry.html") {
    const textures = Object.fromEntries(await Promise.all(["entry-night", "entry-mix"].map(async name => [name, await nativeBridge.readStoryAsset(`story-images/${name}-m.jpg`)])));
    entryTextures = `window.SKY_TEX=${json(textures)};`;
    // Android loads the two small portrait textures directly; the desktop file:// helper is unnecessary.
    html = html.replace(/<script>if \(location\.protocol === "file:"\)[\s\S]*?<\/script>/u, "");
  }
  if (offline) {
    for (const name of ["story-glide.js", "story-export.js", "story-card.js"]) {
      const script = code(await nativeBridge.readStoryAsset(name));
      html = html.replace(`<script src="${name}"></script>`, () => `<script>${script}</script>`);
    }
  } else {
    html = html.replaceAll("window.parent !== window", "true").replaceAll("window.self !== window.top", "true");
    // Local file origins are 'null'; send only a close signal, never data, through this callback.
    html = html.replace('parent.postMessage({ type: "trace:open-dashboard" }, location.origin)', 'parent.postMessage({ type: "trace:open-dashboard" }, "*")');
  }
  const bridge = offline ? "" : `addEventListener('message',event=>{if(event.source===window&&event.data&&event.data.type==='trace:open-dashboard')window.ReactNativeWebView.postMessage(JSON.stringify({type:'story-close',bridgeId:${json(bridgeId)}}));});`;
  const entryCounts = page === "story-entry.html" ? `addEventListener('DOMContentLoaded',()=>{document.querySelectorAll('.gc-rows b').forEach((el,i)=>{const n=[${data.counts.watch},${data.counts.liked},${data.counts.favorite},null][i];el.textContent=n===null?'—':n.toLocaleString('zh-CN');});const y=document.querySelector('.gc-year');if(y)y.dataset.year=${json(String(data.year))};const t=document.querySelector('.gc-top span:last-child');if(t)t.textContent=${json(String(data.year))};const src=document.querySelector('.nav-center span');if(src)src.textContent='本机数据';const fine=document.querySelector('.gate-fine');if(fine)fine.lastChild.textContent='本地快照 LOCAL SNAPSHOT';});` : "";
  return html.replace(/<head[^>]*>/iu, head => `${head}\n<script>window.__STORY_EXPORT__=${json({ data, privacy, assets })};${entryTextures}${bridge}${entryCounts}</script>`);
}
