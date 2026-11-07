// 网页推荐的词条候选池。只消费已预取的完整作品数据，不等待搜索、不改推荐游标。
(function (root) {
  "use strict";
  root.DYF.createPicks = function ({ search, blocked, now = Date.now }) {
    let words = [], enabled = false, every = 3, generation = 0, turn = 0, gap = 0, working = false;
    let inserted = 0, failures = 0, searches = 0;
    const states = new Map(), seen = new Set(), shownPicks = new Set();
    const playable = item => /^\d{5,30}$/u.test(String(item?.aweme_id ?? "")) && !root.DYF.isAdvertisement(item)
      && !item.live_room && (item.images?.length || item.video?.play_addr?.url_list?.length);
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
      if (!states.has(word)) states.set(word, { offset: 0, searchId: null, more: true, retryAt: 0, queue: [] });
      return states.get(word);
    };
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
            searches += 1;
            const payload = await search(word, state.offset, state.searchId);
            if (current !== generation) break;
            if (payload?.status_code !== 0 || !Array.isArray(payload.data)
              || [payload.search_nil_info?.search_nil_type, payload.search_nil_info?.search_nil_item].includes("verify_check")) throw new Error("search_unavailable");
            const ids = new Set();
            state.queue = payload.data.flatMap(entry => entry?.aweme_info ? [entry.aweme_info] : entry?.aweme_list ?? [])
              .filter(item => {
                if (!playable(item) || seen.has(String(item.aweme_id)) || ids.has(String(item.aweme_id)) || blocked(item)) return false;
                ids.add(String(item.aweme_id)); return true;
              }).slice(0, 10);
            const cursor = Number(payload.cursor);
            state.more = [true, 1, "1"].includes(payload.has_more) && Number.isSafeInteger(cursor) && cursor > state.offset;
            if (state.more) state.offset = cursor;
            state.searchId = typeof payload.log_pb?.impr_id === "string" ? payload.log_pb.impr_id : state.searchId;
            // 空页或全部重复/屏蔽也歇一会，避免每刷一屏就请求。
            if (!state.queue.length) state.retryAt = now() + 300_000;
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
          const item = state.queue.shift(), id = String(item.aweme_id);
          if (!seen.has(id) && !blocked(item)) {
            remember(id); shownPicks.add(id);
            if (shownPicks.size > 5000) shownPicks.delete(shownPicks.values().next().value);
            events.push({ id, t: now(), action: "inserted", matched: [word], author: String(item.author?.nickname ?? "").slice(0, 40),
              desc: String(item.desc || item.caption || item.item_title || "").slice(0, 120) });
            return item;
          }
        }
      }
      return null;
    }
    function rememberPage(json) {
      const owner = Array.isArray(json?.aweme_list) ? json : json?.data;
      if (Array.isArray(owner?.aweme_list)) for (const item of owner.aweme_list) remember(item?.aweme_id);
      remember((json?.aweme_detail ?? json?.data?.aweme_detail)?.aweme_id);
    }
    function mix(json, report) {
      const owner = Array.isArray(json?.aweme_list) ? json : json?.data;
      rememberPage(json);
      // 空页、错误回包不能被候选变成另一页。
      if (!enabled || !words.length || !Array.isArray(owner?.aweme_list) || !owner.aweme_list.length
        || (json.status_code !== undefined && json.status_code !== 0)) return false;
      const result = [];
      const events = [];
      let changed = false;
      // 只看词条时这页能播的推荐会被换掉，用户没刷到就不算见过，搜到同一条时还能插进来
      if (!every) for (const item of owner.aweme_list) if (playable(item) && !shownPicks.has(String(item.aweme_id))) seen.delete(String(item.aweme_id));
      for (const item of owner.aweme_list) {
        // 自己已经插过的作品后来又被原推荐送来时，也只出现一次。
        if (shownPicks.has(String(item?.aweme_id))) { changed = true; continue; }
        // 只看词条：没候选时留原推荐，别让页面空掉
        const swap = !every && playable(item) ? take(events) : null;
        if (swap) { result.push(swap); inserted += 1; changed = true; continue; }
        remember(item?.aweme_id);
        result.push(item);
        if (!every) continue;
        if (playable(item)) gap += 1;
        if (gap < every) continue;
        gap = 0;
        const pick = take(events);
        if (pick) { result.push(pick); inserted += 1; changed = true; }
      }
      if (changed) owner.aweme_list = result;
      if (events.length) report?.(events);
      return changed;
    }
    return { configure, prefetch, mix, rememberPage, status: () => ({ pickWords: words.length, picksEnabled: enabled,
      picksQueued: [...states.values()].reduce((sum, state) => sum + state.queue.length, 0), picksInserted: inserted, pickSearches: searches, pickFailures: failures }) };
  };
})(globalThis);
