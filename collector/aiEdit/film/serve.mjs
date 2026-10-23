import { randomBytes, timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";

import { ENCODER_PAGE } from "./encoder.mjs";
import { BRIDGE, HOST_FLAG, PAGE_CSP, filmStart, holdPages, injectFirst } from "./host.mjs";
import { DEFAULT_STAGE, FILM_FILE, readFilmFile } from "./vendor/film-doc.mjs";

// 网页片段和 film.html 的地址：/v1/ai-edit/film/<key>/<区>/<文件>。key 写在路径里，页面里的相对地址（图片、字体、
// timeline 的模块）自动带上；不用配对，看板的 iframe 和渲染浏览器都能直接开。只放 ai-edit 下的 pages/ renders/ media/。

const AREAS = new Set(["pages", "renders", "media"]);
const VENDOR = new Map(["timeline.mjs", "film-doc.mjs", "overrides.mjs"].map((name) => [name, new URL(`./vendor/${name}`, import.meta.url)]));
const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp",
  ".gif": "image/gif", ".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".aac": "audio/aac", ".wav": "audio/wav", ".ogg": "audio/ogg", ".flac": "audio/flac",
  ".mp4": "video/mp4", ".m4v": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm", ".woff2": "font/woff2", ".woff": "font/woff",
  ".ttf": "font/ttf", ".otf": "font/otf", ".glb": "model/gltf-binary", ".gltf": "model/gltf+json", ".wasm": "application/wasm", ".txt": "text/plain; charset=utf-8",
  ".vtt": "text/vtt; charset=utf-8",
};

const within = (folder, file) => file === folder || file.startsWith(folder.endsWith(path.sep) ? folder : folder + path.sep);

export function createFilmFiles({ root }) {
  const key = randomBytes(18).toString("base64url");
  const base = `/v1/ai-edit/film/${key}/`;
  let realRoot = null;
  const notFound = (response) => { response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("not found"); };
  const keyMatches = (given) => {
    const expected = Buffer.from(key);
    const actual = Buffer.from(given);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  };

  return {
    key,
    /** 采集器上某个文件的地址（相对 ai-edit 根目录），给页面和渲染浏览器用。 */
    urlFor(origin, relative) {
      return `${origin}${base}${relative.split(/[\\/]/u).map(encodeURIComponent).join("/")}`;
    },
    async handle(request, response, url) {
      const match = /^\/v1\/ai-edit\/film\/([^/]+)\/(.*)$/u.exec(url.pathname);
      if (!match) return false;
      if (request.method !== "GET" && request.method !== "HEAD") { response.writeHead(405).end(); return true; }
      if (!keyMatches(match[1])) { notFound(response); return true; }
      let rel;
      try { rel = decodeURIComponent(match[2]); } catch { notFound(response); return true; }
      if (rel.includes("\\") || rel.includes("\0")) { notFound(response); return true; }
      const headers = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
      if (rel === "__encoder.html") {
        response.writeHead(200, { ...headers, "Content-Type": "text/html; charset=utf-8" }).end(ENCODER_PAGE);
        return true;
      }
      // openfilm 的播放器：放在任何 film.html 旁边（film.html 按相对地址引用 __film/timeline.mjs）
      const vendor = /(?:^|\/)__film\/([^/]+)$/u.exec(rel);
      if (vendor) {
        if (VENDOR.has(vendor[1])) {
          response.writeHead(200, { ...headers, "Content-Type": "text/javascript; charset=utf-8" }).end(await readFile(VENDOR.get(vendor[1])));
        } else if (vendor[1] === "frame-duration" || vendor[1] === "media-facts") {
          // 这两个 openfilm 靠 ffprobe 答，我们没有：答「不知道」，timeline 自己按浏览器读到的算
          response.writeHead(200, { ...headers, "Content-Type": "application/json" }).end(vendor[1] === "frame-duration" ? JSON.stringify({ seconds: null }) : "null");
        } else notFound(response);
        return true;
      }
      if (!AREAS.has(rel.split("/")[0])) { notFound(response); return true; }
      realRoot ??= await realpath(root);
      const asked = path.normalize(path.join(realRoot, rel));
      let file;
      try { file = await realpath(asked); } catch { notFound(response); return true; }
      // 链接出去的不跟（导入的工程可能带着指向别处的链接）
      if (!within(path.join(realRoot, rel.split("/")[0]), file)) { notFound(response); return true; }
      let info;
      try { info = await stat(file); } catch { notFound(response); return true; }
      if (info.isDirectory()) { notFound(response); return true; }
      const type = TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream";
      if (type.startsWith("text/html")) {
        const html = await readFile(file, "utf8");
        const page = { ...headers, "Content-Type": type, "Content-Security-Policy": PAGE_CSP };
        if (url.searchParams.get("film-host") === "0") { response.writeHead(200, page).end(html); return true; }
        const film = path.basename(file) === FILM_FILE;
        const start = film ? `<script>${HOST_FLAG}</script>${filmStart(readFilmFile(html).doc?.stage ?? DEFAULT_STAGE)}` : `<script>${HOST_FLAG}${BRIDGE}</script>`;
        response.writeHead(200, page).end(injectFirst(film ? holdPages(html) : html, start));
        return true;
      }
      const plain = { ...headers, "Content-Type": type, "Accept-Ranges": "bytes",
        // 出好的片子和工程包：点链接就下载
        ...(url.searchParams.has("download") ? { "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(file))}` } : {}) };
      if (request.method === "HEAD") { response.writeHead(200, { ...plain, "Content-Length": info.size }).end(); return true; }
      const range = /^bytes=(\d*)-(\d*)$/u.exec(request.headers.range ?? "");
      if (range && (range[1] || range[2])) {
        const start = range[1] ? Number(range[1]) : Math.max(0, info.size - Number(range[2]));
        const end = range[1] && range[2] ? Math.min(Number(range[2]), info.size - 1) : info.size - 1;
        if (start > end || start >= info.size) { response.writeHead(416, { ...plain, "Content-Range": `bytes */${info.size}` }).end(); return true; }
        response.writeHead(206, { ...plain, "Content-Range": `bytes ${start}-${end}/${info.size}`, "Content-Length": end - start + 1 });
        await pipeline(createReadStream(file, { start, end }), response).catch(() => undefined);
        return true;
      }
      response.writeHead(200, { ...plain, "Content-Length": info.size });
      await pipeline(createReadStream(file), response).catch(() => undefined);
      return true;
    },
  };
}
