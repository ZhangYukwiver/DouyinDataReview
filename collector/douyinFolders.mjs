import { setTimeout as delay } from "node:timers/promises";
import { DirectHistoryError } from "./directHistory.mjs";
import { directWrite } from "./directWrites.mjs";

// 「收藏」栏的文件夹和抖音收藏夹对上：文件夹上的 douyinId 是抖音收藏夹 id（collects_id_str）。
// 读取时抖音为准（抖音客户端里改的会带回来）；在软件里整理时先改到抖音上再存本地。

const REFERER = "https://www.douyin.com/user/self?showTab=favorite_collection";
const NAME_MAX = 15;
const BATCH = 100;
const VIDEO_ID = /^\d{5,30}$/u;

async function* pages(api, pathname, query, signal) {
  const cursors = new Set();
  let cursor = "0";
  for (;;) {
    if (cursors.has(cursor)) throw new DirectHistoryError("pagination_stalled", "收藏夹分页游标重复，已停止读取。");
    cursors.add(cursor);
    const page = await api.request(pathname, { query: { ...query, cursor, count: "20" }, referer: REFERER, signal });
    if (page.status_code !== 0) throw new DirectHistoryError("douyin_error", `抖音收藏夹接口返回状态码 ${page.status_code}。`);
    yield page;
    if (![true, 1, "1"].includes(page.has_more)) return;
    cursor = String(page.cursor ?? "");
    if (!/^\d{1,20}$/u.test(cursor)) throw new DirectHistoryError("pagination_missing", "收藏夹响应缺少下一页游标。");
    await delay(300, undefined, { signal });
  }
}

async function listFolders(api, signal) {
  const folders = [];
  for await (const page of pages(api, "/aweme/v1/web/collects/list/", {}, signal)) {
    for (const item of page.collects_list ?? []) {
      // collects_id 是超过安全整数的数字，只能用 _str
      const douyinId = String(item?.collects_id_str ?? "");
      const name = typeof item?.collects_name === "string" ? item.collects_name.trim() : "";
      // 实测私密收藏夹 status 是 0
      if (/^\d{1,30}$/u.test(douyinId) && name) folders.push({ douyinId, name, public: item.status !== 0, videos: [] });
    }
  }
  return folders;
}

/** 抖音上的全部收藏夹和夹里的作品。哪一页读不出就整个失败，不拿半份去改本地 */
// ponytail: 每次读取都把所有夹从头读一遍；夹里作品上千时再改成按 total_number 判断哪些夹要重读
export async function readDouyinFolders(api, { signal } = {}) {
  const folders = await listFolders(api, signal);
  for (const folder of folders) {
    for await (const page of pages(api, "/aweme/v1/web/collects/video/list/", { collects_id: folder.douyinId }, signal)) {
      for (const item of page.aweme_list ?? []) {
        const id = String(item?.aweme_id ?? "");
        if (VIDEO_ID.test(id)) folder.videos.push(id);
      }
    }
  }
  return folders;
}

/** 读取时：抖音收藏夹并进本地收藏栏。抖音上删掉的夹跟着删，在抖音收藏夹里的作品按抖音放 */
// ponytail: 不按名字认领本地同名文件夹，免得本地多放的作品被抖音那份冲掉；同名就并排两个
export function mergeDouyinFolders(list, remote) {
  const mine = new Map(list.folders.filter((folder) => folder.douyinId).map((folder) => [folder.douyinId, folder.id]));
  const linked = new Map(remote.map((folder) => [mine.get(folder.douyinId) ?? `dy-${folder.douyinId}`, folder]));
  const folders = list.folders.flatMap((folder) => {
    if (!folder.douyinId) return [folder];
    const match = linked.get(folder.id);
    return match ? [{ id: folder.id, name: match.name, douyinId: match.douyinId }] : [];
  });
  const kept = new Set(folders.map((folder) => folder.id));
  for (const [id, folder] of linked) if (!kept.has(id)) folders.push({ id, name: folder.name, douyinId: folder.douyinId });

  // 一个作品可以在抖音的好几个夹里，本地只放一个：已经在其中一个就不动，否则放进抖音列表里靠前的那个
  const homes = new Map();
  for (const [id, folder] of linked) for (const video of folder.videos) homes.set(video, [...(homes.get(video) ?? []), id]);
  const local = new Set(folders.filter((folder) => !folder.douyinId).map((folder) => folder.id));
  const entries = Object.entries(list.items).filter(([key, id]) => !homes.has(key) && local.has(id));
  for (const [key, ids] of homes) entries.push([key, ids.includes(list.items[key]) ? list.items[key] : ids[0]]);
  return { folders, items: Object.fromEntries(entries) };
}

const failure = (message, code = "douyin_folders_failed") => Object.assign(new Error(message), { code });

async function send(api, action, input) {
  const reply = await directWrite(api, action, input);
  if (reply.status_code === 8) throw failure("抖音登录已失效，请重新登录后再整理收藏。", "login_required");
  if (reply.status_code !== 0) throw failure(`抖音没有接受（${reply.status_msg || `状态码 ${reply.status_code}`}）。`);
  return reply;
}

/**
 * 保存时：比较收藏栏改动前后，把新建/改名/删除收藏夹和作品的放进移出先改到抖音上，再返回要落盘的收藏栏。
 * douyinId 只认本地原来存的，请求里带来的不算。抖音哪一步没成就抛错、本地不存。
 */
export async function pushDouyinFolders(before, after, { checked = true, enabled, getApi }) {
  const old = new Map(before.folders.map((folder) => [folder.id, folder]));
  const folders = after.folders.map(({ id, name }) => (old.get(id)?.douyinId ? { id, name, douyinId: old.get(id).douyinId } : { id, name }));
  const next = new Map(folders.map((folder) => [folder.id, folder]));
  // 没打开「允许在抖音上操作」时新建的只是本地文件夹，照旧能用；动到已对上抖音收藏夹的才要开关
  const sync = enabled();
  const created = sync ? folders.filter((folder) => !old.has(folder.id)) : [];
  const renamed = folders.filter((folder) => folder.douyinId && old.get(folder.id).name !== folder.name);
  const removed = before.folders.filter((folder) => folder.douyinId && !next.has(folder.id));
  const take = new Map();
  const put = new Map();
  const add = (map, id, key) => map.set(id, [...(map.get(id) ?? []), key]);
  for (const key of new Set([...Object.keys(before.items), ...Object.keys(after.items)])) {
    const from = old.get(before.items[key]);
    const to = next.get(after.items[key]);
    if (from?.id === to?.id || !VIDEO_ID.test(key)) continue;
    // 整个夹删掉的不用一条条移出；新建的夹马上会建到抖音上
    if (from?.douyinId && next.has(from.id)) add(take, from.id, key);
    if (to && (to.douyinId || created.includes(to))) add(put, to.id, key);
  }
  if (!created.length && !renamed.length && !removed.length && !take.size && !put.size) return { folders, items: after.items };
  // 不带版本号的旧客户端可能拿着读取合并前的旧文档，会被当成删了抖音收藏夹
  if (!checked) throw failure("文件夹已有新改动，请重新读取后再整理。", "folders_changed");
  if (!sync) throw failure("收藏栏的文件夹会同步成抖音收藏夹，要先在「设置 → 隐私」打开「允许在抖音上操作」。", "writes_disabled");
  const tooLong = [...created, ...renamed].find((folder) => Array.from(folder.name).length > NAME_MAX);
  if (tooLong) throw failure(`抖音收藏夹名最多 ${NAME_MAX} 个字，「${tooLong.name}」太长了。`, "invalid_request");

  let done = 0;
  try {
    const api = await getApi();
    // 改名得带上原来的公开/私密，不带抖音会按默认改
    const visibility = renamed.length ? new Map((await listFolders(api)).map((folder) => [folder.douyinId, folder.public])) : null;
    for (const folder of created) {
      // 软件里新建的一律私密，要公开去抖音里改
      const reply = await send(api, "folder", { op: "create", name: folder.name, public: false });
      const id = String(reply.collects_info?.collects_id_str ?? "");
      if (!/^\d{1,30}$/u.test(id)) throw failure("抖音没有返回新收藏夹的编号。");
      folder.douyinId = id;
      done += 1;
    }
    for (const folder of renamed) {
      await send(api, "folder", { op: "rename", id: folder.douyinId, name: folder.name, public: visibility.get(folder.douyinId) ?? false })
        .catch((error) => {
          // 实测刚建好几秒内改名会回 3002184「操作失败」，过半分钟再改就行
          throw /3002184|操作失败/u.test(error.message) ? failure("抖音暂时不让改这个收藏夹的名字（刚建好的要等一会儿），稍后再试。") : error;
        });
      done += 1;
    }
    for (const [id, keys] of take) {
      const { douyinId, name } = old.get(id);
      for (let index = 0; index < keys.length; index += BATCH) {
        await send(api, "folderVideos", { ids: keys.slice(index, index + BATCH), from: { id: douyinId, name } });
        done += 1;
      }
    }
    for (const [id, keys] of put) {
      for (let index = 0; index < keys.length; index += BATCH) {
        await send(api, "folderVideos", { ids: keys.slice(index, index + BATCH), to: { id: next.get(id).douyinId } });
        done += 1;
      }
    }
    // 实测删收藏夹不会取消收藏，里面的作品还在「收藏」里
    for (const folder of removed) {
      await send(api, "folder", { op: "delete", id: folder.douyinId });
      done += 1;
    }
  } catch (error) {
    const reason = error?.code === "douyin_folders_failed" || error?.code === "login_required" ? error.message
      : `改抖音收藏夹没成功：${error?.message || "未知原因"}`;
    throw failure(done ? `${reason}前面几步已经改到抖音上了，下次读取会对回来。` : reason, error?.code === "login_required" ? "login_required" : "douyin_folders_failed");
  }
  return { folders, items: after.items };
}
