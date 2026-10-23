import { randomBytes } from "node:crypto";
import { createReadStream, createWriteStream, mkdirSync } from "node:fs";
import { mkdir, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { once } from "node:events";

import { Unzip, UnzipInflate, Zip, ZipDeflate, ZipPassThrough } from "fflate";

import { AiEditError } from "../library.mjs";
import { openTab } from "./browser.mjs";
import { encodeMp4 } from "./encoder.mjs";
import { FILM_FILE, droppedText, filmToPlan, projectToFilm, transformOf } from "./filmFile.mjs";
import { createPages } from "./pages.mjs";
import { createFilmFiles } from "./serve.mjs";

// openfilm 工程化接进 AI 剪辑：网页片段（pages.mjs）、film.html 工程导出 / 导入（zip）、按 film.html 在本机出 MP4。
// 出片和 openfilm 的 render 一样：film.html 由 vendor/timeline.mjs 播放，逐帧画好截图；编码和混音在渲染浏览器里（encoder.mjs）。

const MAX_IMPORT_BYTES = 4 * 1024 ** 3;
const MAX_IMPORT_FILES = 3_000;
const US = 1_000_000;

const within = (folder, file) => file === folder || file.startsWith(folder + path.sep);
const safeName = (name) => String(name ?? "").replace(/[\\/:*?"<>|\u0000-\u001f]/gu, " ").trim().slice(0, 60) || "未命名剪辑";

export function createFilmStudio({ root, library, provider, getOrigin }) {
  const files = createFilmFiles({ root });
  const pages = createPages({ root, library, files, provider, getOrigin });
  const renders = path.join(root, "renders");

  const mediaOf = (filePath) => {
    const id = library.idForPath(filePath);
    return id ? library.get(id) : null;
  };

  return {
    files,
    pages,

    /** 工程打包成 zip（film.html + assets/ + pages/ + text/）写进 out（文件写入流）。回没带过去的说明。 */
    async exportZip(project, out, { signal } = {}) {
      const names = new Map();
      const assets = [];
      const pageFolders = new Set();
      const srcFor = (item, filePath) => {
        if (!names.has(filePath)) {
          const base = path.basename(item?.name || filePath).replace(/[\\/]/gu, "_");
          const ext = path.extname(filePath);
          let name = `${path.basename(base, path.extname(base)) || "素材"}${ext}`;
          for (let n = 2; [...names.values()].includes(`assets/${name}`); n += 1) name = `${path.basename(base, path.extname(base))}-${n}${ext}`;
          names.set(filePath, `assets/${name}`);
          assets.push({ zip: `assets/${name}`, file: filePath });
        }
        return names.get(filePath);
      };
      const pageSrc = (rel) => {
        pageFolders.add(rel.split("/")[0]);
        return `pages/${rel}`;
      };
      const { html, texts, dropped } = projectToFilm(project, { mediaOf, srcFor, pageSrc, textSrc: (segment) => `text/${segment.id}.html` });
      const folder = safeName(project.name);
      const finished = once(out, "finish");
      const zip = new Zip((error, chunk, final) => {
        if (error) { out.destroy(error); return; }
        out.write(chunk);
        if (final) out.end();
      });
      const text = (name, value) => {
        const entry = new ZipDeflate(`${folder}/${name}`, { level: 6 });
        zip.add(entry);
        entry.push(Buffer.from(value), true);
      };
      const stream = async (name, file) => {
        const entry = new ZipPassThrough(`${folder}/${name}`);
        zip.add(entry);
        for await (const chunk of createReadStream(file)) {
          signal?.throwIfAborted();
          entry.push(chunk);
          if (out.writableNeedDrain) await once(out, "drain");
        }
        entry.push(new Uint8Array(0), true);
      };
      text(FILM_FILE, html);
      for (const page of texts) text(page.src, page.html);
      for (const asset of assets) await stream(asset.zip, asset.file);
      // 网页片段整个文件夹带上（页面可能引用旁边的图片、字体）
      for (const id of pageFolders) {
        const base = path.join(pages.directory, id);
        const walk = async (dir) => {
          for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) await walk(full);
            else if (entry.isFile() && !entry.name.endsWith(".tmp")) await stream(`pages/${id}/${path.relative(base, full).split(path.sep).join("/")}`, full);
          }
        };
        await walk(base);
      }
      zip.end();
      await finished;
      return droppedText(dropped);
    },

    /**
     * 收一个工程 zip（openfilm 的工程文件夹打的包），解到 pages/<导入 id>/，读 film.html。
     * 回 { folder, rel, canvas, plan, skipped }：rel 是 film.html 所在文件夹相对 pages/ 的路径。
     */
    async receiveZip(request) {
      const id = randomBytes(8).toString("hex");
      const folder = path.join(pages.directory, id);
      await mkdir(folder, { recursive: true, mode: 0o700 });
      try {
        let total = 0;
        let count = 0;
        const writes = [];
        let failure = null;
        const fail = (error) => { failure ??= error; };
        const unzip = new Unzip((file) => {
          const name = file.name.replace(/\\/gu, "/");
          if (name.endsWith("/")) return;
          count += 1;
          if (count > MAX_IMPORT_FILES) { fail(new AiEditError("film_too_many_files", "工程里的文件太多了。", 413)); return; }
          // 跳过 macOS 打包带的 __MACOSX 和隐藏文件
          if (name.split("/").some((part) => part === "__MACOSX" || part.startsWith("."))) return;
          const target = path.resolve(folder, name);
          if (!within(folder, target) || name.split("/").includes("..")) { fail(new AiEditError("film_bad_zip", "压缩包里有不安全的路径。", 422)); return; }
          // 数据是同步回调进来的：当场开文件、当场 start，写入交给写入流排队
          mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
          const out = createWriteStream(target, { mode: 0o600 });
          const done = new Promise((resolve, reject) => {
            out.on("error", reject);
            out.on("finish", resolve);
            file.ondata = (error, data, final) => {
              if (error) { reject(error); out.destroy(); return; }
              total += data.length;
              if (total > MAX_IMPORT_BYTES) { reject(new AiEditError("film_too_large", "工程超过 4GB 了。", 413)); out.destroy(); return; }
              out.write(data);
              if (final) out.end();
            };
          });
          file.start();
          writes.push(done.catch(fail));
        });
        unzip.register(UnzipInflate);
        for await (const chunk of request) {
          unzip.push(chunk);
          if (failure) throw failure;
        }
        unzip.push(new Uint8Array(0), true);
        await Promise.all(writes);
        if (failure) throw failure;
        // film.html 可能在压缩包根上，也可能在一层文件夹里：取最浅的那个
        const found = [];
        const walk = async (dir, depth) => {
          for (const entry of await readdir(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isFile() && entry.name === FILM_FILE) found.push({ full, depth });
            else if (entry.isDirectory() && depth < 3) await walk(full, depth + 1);
          }
        };
        await walk(folder, 0);
        found.sort((a, b) => a.depth - b.depth);
        if (!found.length) throw new AiEditError("film_not_found", "压缩包里没有 film.html，这不是 openfilm 的工程。", 422);
        const filmFile = found[0].full;
        let plan;
        try { plan = filmToPlan(await readFile(filmFile, "utf8"), path.dirname(filmFile)); }
        catch (error) { throw new AiEditError("film_invalid", `film.html 读不懂：${String(error.message).split("\n").slice(0, 3).join("；")}`, 422); }
        return { folder, rel: path.relative(pages.directory, path.dirname(filmFile)).split(path.sep).join("/"), ...plan };
      } catch (error) {
        await rm(folder, { recursive: true, force: true }).catch(() => undefined);
        if (error instanceof AiEditError) throw error;
        throw new AiEditError("film_bad_zip", "压缩包解不开，要 .zip 格式的工程文件夹。", 422);
      }
    },

    /**
     * 照 receiveZip 排好的计划往工程里建轨道、放片段。素材复制进素材库，网页片段渲成素材（有透明的地方就带透明，叠在下面的轨道上）。
     * 回 { added, skipped }。onStep(done, total) 报进度。
     */
    async applyPlan(store, projectId, received, { fps = 30, onStep = () => undefined, signal } = {}) {
      const { folder, canvas, tracks } = received;
      const skipped = { ...received.skipped };
      const skip = (name) => { skipped[name] = (skipped[name] ?? 0) + 1; };
      const realFolder = await realpath(folder);
      const imported = new Map();
      const total = tracks.reduce((sum, track) => sum + track.clips.length, 0);
      let done = 0;
      let added = 0;
      const names = { video: 0, audio: 0 };
      for (const track of tracks) {
        names[track.type] += 1;
        const created = await store.createTrack(projectId, { track_type: track.type, name: `${track.type === "video" ? "画面" : "声音"} ${names[track.type]}` });
        const trackId = created.tracks?.at(-1)?.id ?? created.id;
        for (const clip of track.clips) {
          signal?.throwIfAborted();
          onStep(done, total);
          done += 1;
          let file;
          try { file = await realpath(clip.file); } catch { skip("找不到的文件"); continue; }
          if (!within(realFolder, file)) { skip("工程文件夹外的文件"); continue; }
          let item;
          try {
            if (clip.kind === "page") {
              const rel = path.relative(pages.directory, file).split(path.sep).join("/");
              const key = `${rel}|${clip.size?.w ?? canvas.width}x${clip.size?.h ?? canvas.height}|${clip.time?.join(",") ?? ""}`;
              if (!imported.has(key)) {
                imported.set(key, (await pages.render({
                  rel, name: clip.name.replace(/\.html?$/iu, ""), width: clip.size?.w ?? canvas.width, height: clip.size?.h ?? canvas.height,
                  duration: clip.time?.length === 2 ? clip.time[1] : null, transparent: "auto", fps, signal,
                })).item);
              }
              item = imported.get(key);
            } else {
              if (!imported.has(file)) imported.set(file, await library.importFile(file, clip.name));
              item = imported.get(file);
            }
          } catch (error) {
            if (error?.name === "AbortError") throw error;
            skip(clip.kind === "page" ? "没渲出来的网页" : "读不了的素材");
            continue;
          }
          const length = item.durationUs ? item.durationUs / US : null;
          const still = item.kind === "image";
          const [from, to] = clip.time?.length === 2 ? clip.time : [clip.time?.[0] ?? 0, length ?? 3];
          const speed = still || clip.kind === "page" ? 1 : clip.speed;
          const sourceTo = clip.kind === "page" ? Math.min(to, length ?? to) : to;
          const room = clip.until !== undefined ? clip.until - clip.at : Infinity;
          const duration = Math.min(room, still ? to - from : (sourceTo - from) / speed);
          if (!(duration > 0)) { skip("时长不对的片段"); continue; }
          const transform = clip.kind === "sound" ? null : transformOf(canvas, { width: item.width, height: item.height }, clip.box);
          const alpha = clip.opacity !== undefined ? { alpha: clip.opacity } : {};
          const request = {
            path: library.filePath(library.get(item.id)),
            // 截到下一段开头时按微秒对齐，免得浮点误差又叠上 1 微秒
            timeline: { start_us: Math.round(clip.at * US), duration_us: duration === room ? Math.round(clip.until * US) - Math.round(clip.at * US) : Math.round(duration * US) },
            ...(still ? {} : { source: { start_us: Math.round(from * US), duration_us: Math.round(duration * speed * US) } }),
            ...(clip.kind === "sound" || clip.kind === "video" ? { volume: Math.min(clip.volume, 10) } : {}),
            ...(Math.abs(speed - 1) > 1e-9 ? { speed } : {}),
            ...(transform || alpha.alpha !== undefined ? { transform: { ...(transform ?? {}), ...alpha } } : {}),
            material_name: item.name,
          };
          try {
            const before = new Set((await store.getProject(projectId)).tracks.find((entry) => entry.id === trackId)?.segments?.map((entry) => entry.id) ?? []);
            const project = await store.addMediaSegment(projectId, trackId, request);
            added += 1;
            const segment = project.tracks.find((entry) => entry.id === trackId)?.segments?.find((entry) => !before.has(entry.id));
            if (segment && clip.fade && (clip.fade[0] > 0 || clip.fade[1] > 0)) {
              await store.addFade(projectId, segment.id, { in_duration_us: Math.round(clip.fade[0] * US), out_duration_us: Math.round(clip.fade[1] * US) }).catch(() => skip("淡入淡出"));
            }
          } catch {
            skip("放不上时间线的片段（和别的片段重叠或时长不对）");
          }
        }
      }
      onStep(total, total);
      return { added, skipped };
    },

    /**
     * 按工程出 MP4：先写成 film.html（片段直接引用素材库和网页片段），再逐帧画、编码、混音。
     * 回 { file, name, dropped, silent }；file 在 renders/<会话 id>/ 下。
     */
    async renderMp4(sessionId, project, { onProgress = () => undefined, signal } = {}) {
      if (!provider) throw new AiEditError("film_unavailable", "这个环境没有能渲染网页的浏览器。", 503);
      const duration = Math.max(0, ...project.tracks.flatMap((track) => (track.segments ?? []).map((segment) => segment.timeline.start_us + segment.timeline.duration_us))) / US;
      if (!(duration > 0)) throw new AiEditError("project_empty", "时间线还是空的，先放点素材再出片。", 422);
      const folder = path.join(renders, sessionId);
      await rm(folder, { recursive: true, force: true });
      await mkdir(path.join(folder, "text"), { recursive: true, mode: 0o700 });
      const { html, texts, dropped } = projectToFilm(project, {
        mediaOf,
        srcFor: (_item, filePath) => `../../media/${path.basename(filePath)}`,
        pageSrc: (rel) => `../../pages/${rel}`,
        textSrc: (segment) => `text/${segment.id}.html`,
      });
      await writeFile(path.join(folder, FILM_FILE), html, { mode: 0o600 });
      for (const page of texts) await writeFile(path.join(folder, page.src), page.html, { mode: 0o600 });
      const origin = getOrigin();
      const { width, height, fps } = project.canvas;
      const film = await openTab(provider, files.urlFor(origin, `renders/${sessionId}/${FILM_FILE}`), { width, height, background: "black" });
      let encoder = null;
      const name = `${safeName(project.name)}.mp4`;
      const file = path.join(folder, name);
      try {
        encoder = await openTab(provider, files.urlFor(origin, "__encoder.html"), { plain: true });
        const count = Math.max(1, Math.round(duration * fps));
        const result = await encodeMp4({
          encoderTab: encoder, file, width, height, fps, count, signal,
          frame: async (index) => { await film.seek(index / fps); return film.capture({ format: "jpeg", quality: 90 }); },
          sounds: film.meta.sounds,
          onProgress: (share) => onProgress(share * 0.95),
        });
        onProgress(1);
        return { file, name, dropped: droppedText(dropped), silent: result.silent, size: (await stat(file)).size };
      } finally {
        await Promise.allSettled([film.close(), encoder?.close()]);
      }
    },
  };
}
