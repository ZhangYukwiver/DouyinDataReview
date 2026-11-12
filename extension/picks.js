// 网页推荐的词条候选池。只消费已预取的完整作品数据，不等待搜索、不改推荐游标。
// 站点不同的只有：作品号、能不能播、搜索回包、推荐列表在回包哪儿、记录写什么；默认是抖音，B 站在 bili.js 里传自己的
(function (root) {
  "use strict";
  const HISTORY_IDS = 300;
  const douyinList = (json) => {
    const owner = Array.isArray(json?.aweme_list) ? json : json?.data;
    return Array.isArray(owner?.aweme_list) ? owner : null;
  };
  const DOUYIN = {
    // 每个词翻到第几条、推过哪些，存在站点的 localStorage；不存的话每次打开页面都从搜索第一页重来，推的都是同一批
    historyKey: "__dyf_pick_history",
    id: item => item?.aweme_id,
    playable: item => /^\d{5,30}$/u.test(String(item?.aweme_id ?? "")) && !root.DYF.isAdvertisement(item)
      && !item.live_room && (item.images?.length || item.video?.play_addr?.url_list?.length),
    // 第一页照常搜（拿新的 search_id，实测不带它直接翻页被要求过验证）
    parse(payload) {
      if (payload?.status_code !== 0 || !Array.isArray(payload.data)
        || [payload.search_nil_info?.search_nil_type, payload.search_nil_info?.search_nil_item].includes("verify_check")) throw new Error("search_unavailable");
      const cursor = Number(payload.cursor);
      return { items: payload.data.flatMap(entry => entry?.aweme_info ? [entry.aweme_info] : entry?.aweme_list ?? []),
        more: [true, 1, "1"].includes(payload.has_more) && Number.isSafeInteger(cursor), next: cursor,
        searchId: typeof payload.log_pb?.impr_id === "string" ? payload.log_pb.impr_id : undefined };
    },
    describe: item => ({ author: String(item.author?.nickname ?? "").slice(0, 40), desc: String(item.desc || item.caption || item.item_title || "").slice(0, 120) }),
    // 页面这一批推荐；空页、错误回包返回 null，不能被候选变成另一页
    page(json) {
      const owner = douyinList(json);
      if (!owner || !owner.aweme_list.length || (json.status_code !== undefined && json.status_code !== 0)) return null;
      return { items: owner.aweme_list, set: items => { owner.aweme_list = items; } };
    },
    shown: json => [...(douyinList(json)?.aweme_list ?? []), json?.aweme_detail ?? json?.data?.aweme_detail],
  };
  root.DYF.createPicks = function ({ search, blocked, now = Date.now, site = DOUYIN }) {
    let words = [], enabled = false, every = 3, generation = 0, turn = 0, gap = 0, working = false;
    let inserted = 0, failures = 0, searches = 0;
    const states = new Map(), seen = new Set(), shownPicks = new Set();
    const playable = site.playable;
    const idOf = item => String(site.id(item) ?? "");
    const readHistory = () => { try { return JSON.parse(root.localStorage.getItem(site.historyKey)) ?? {}; } catch { return {}; } };
    const remember = id => {
      if (!id) return;
      seen.add(String(id));
      // 限制长时间刷视频的内存；仅保留最近 5000 个作品号。
      if (seen.size > 5000) seen.delete(seen.values().next().value);
    };
    function configure(text, on, pickEvery = 3) {
      // 每几条推荐插一条，0 是每条能播的推荐都换成词条视频；只改频率不用重搜
      every = Number.isInteger(pickEvery) && pickEvery >= 0 && pickEvery <= 10 ? pickEvery : 3;
      const next = [...new Set(String(text ?? "").split(/\r?\n/u).map(word => word.trim().slice(0, 30)).filter(Boolean))].slice(0, 20);
      if (enabled === on && JSON.stringify(next) === JSON.stringify(words)) return;
      enabled = on; words = next; generation += 1; turn = gap = 0; states.clear();
    }
    const stateFor = word => {
      if (!states.has(word)) {
        const saved = readHistory()[word];
        states.set(word, { offset: 0, resumeAt: Number.isSafeInteger(saved?.offset) && saved.offset > 0 ? saved.offset : 0,
          shown: new Set(Array.isArray(saved?.ids) ? saved.ids.map(String) : []), searchId: null, more: true, retryAt: 0, queue: [] });
      }
      return states.get(word);
    };
    function saveHistory() {
      const saved = readHistory();
      // 这次没轮到的词原样留着；搜到底的词不留，下次从头来，只有这时才会重复
      const history = Object.fromEntries(words.flatMap(word => {
        const state = states.get(word);
        if (!state) return saved[word] ? [[word, saved[word]]] : [];
        return state.more ? [[word, { offset: Math.max(state.offset, state.resumeAt), ids: [...state.shown].slice(-HISTORY_IDS) }]] : [];
      }));
      try { root.localStorage.setItem(site.historyKey, JSON.stringify(history)); } catch { /* 存不下只是下次可能重复 */ }
    }
    async function prefetch() {
      if (!enabled || !words.length || working) return;
      working = true;
      const current = generation;
      // 每次最多预取两个词，逐个请求；还有候选时不重复搜。
      const ahead = Array.from({ length: words.length }, (_, index) => words[(turn + index) % words.length]).filter(word => {
        const state = stateFor(word);
        return !state.queue.length && state.more && state.retryAt <= now();
      }).slice(0, 2);
      try {
        for (const word of ahead) {
          if (current !== generation) break;
          const state = stateFor(word);
          if (state.queue.length || !state.more || state.retryAt > now()) continue;
          try {
            // 第一页常常全是推过的，这时再搜一页（已经跳回上次的位置）
            for (let page = 0; page < 2 && !state.queue.length && state.more && current === generation; page += 1) {
              searches += 1;
              const payload = await search(word, state.offset, state.searchId);
              if (current !== generation) break;
              const result = site.parse(payload);
              const ids = new Set();
              const queue = result.items.filter(item => {
                const id = idOf(item);
                if (!playable(item) || seen.has(id) || state.shown.has(id) || ids.has(id) || blocked(item)) return false;
                ids.add(id); return true;
              }).slice(0, 10);
              // B 站搜索结果缺播放要用的字段，入队前补上
              state.queue = site.prepare ? await site.prepare(queue) : queue;
              if (current !== generation) break;
              state.more = result.more && result.next > state.offset;
              // 下一页跳回上次的位置
              if (state.more) state.offset = Math.max(result.next, state.resumeAt);
              state.searchId = result.searchId ?? state.searchId;
            }
            // 空页或全部重复/屏蔽也歇一会，避免每刷一屏就请求。
            if (current === generation && !state.queue.length) state.retryAt = now() + 300_000;
          } catch {
            if (current === generation) { failures += 1; state.retryAt = now() + 300_000; }
          }
        }
      } finally { working = false; }
    }
    function take(events) {
      for (let count = 0; count < words.length; count += 1) {
        const word = words[turn % words.length]; turn = (turn + 1) % words.length;
        const state = stateFor(word);
        while (state.queue.length) {
          const item = state.queue.shift(), id = idOf(item);
          if (!seen.has(id) && !blocked(item)) {
            remember(id); shownPicks.add(id); state.shown.add(id);
            if (shownPicks.size > 5000) shownPicks.delete(shownPicks.values().next().value);
            events.push({ id, t: now(), action: "inserted", matched: [word], ...site.describe(item) });
            return item;
          }
        }
      }
      return null;
    }
    function rememberPage(json) {
      for (const item of site.shown(json)) remember(site.id(item));
    }
    function mix(json, report) {
      const page = site.page(json);
      rememberPage(json);
      // 空页、错误回包不能被候选变成另一页。
      if (!enabled || !words.length || !page) return false;
      const result = [];
      const events = [];
      let changed = false;
      // 只看词条时这页能播的推荐会被换掉，用户没刷到就不算见过，搜到同一条时还能插进来
      if (!every) for (const item of page.items) if (playable(item) && !shownPicks.has(idOf(item))) seen.delete(idOf(item));
      for (const item of page.items) {
        // 自己已经插过的作品后来又被原推荐送来时，也只出现一次。
        if (shownPicks.has(idOf(item))) { changed = true; continue; }
        // 只看词条：没候选时留原推荐，别让页面空掉
        const swap = !every && playable(item) ? take(events) : null;
        if (swap) { result.push(swap); inserted += 1; changed = true; continue; }
        remember(site.id(item));
        result.push(item);
        if (!every) continue;
        if (playable(item)) gap += 1;
        if (gap < every) continue;
        gap = 0;
        const pick = take(events);
        if (pick) { result.push(pick); inserted += 1; changed = true; }
      }
      if (changed) page.set(result);
      if (events.length) { saveHistory(); report?.(events); }
      return changed;
    }
    return { configure, prefetch, mix, rememberPage, status: () => ({ pickWords: words.length, picksEnabled: enabled,
      picksQueued: [...states.values()].reduce((sum, state) => sum + state.queue.length, 0), picksInserted: inserted, pickSearches: searches, pickFailures: failures }) };
  };
})(globalThis);
