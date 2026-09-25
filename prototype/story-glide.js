// 长卷报告（海报 / 内容年志）共用的滚动手感：
// 1. 粘滞：滚轮和触控板不直接滚页面，只推一个目标位置，页面按指数阻尼追过去，像在蜜里滑。
// 2. 停靠：每个场景的开头、钉住场景的结尾都是停靠点。滚到停靠点会被吸住，这一下的惯性被吞掉，
//    要重新推一把、推过一小段皮筋才离开；两场之间的过渡带里朝一个方向推过两成多就直接去那一头，
//    推得不够松手，就按推的方向吸过去或退回来。
// 3. 自动播放：停在钉住的场景里，页面按节奏自己往下走完这一场，走到结尾停住，等你翻到下一场。
//    节奏默认按场景长度算，场景上写 data-play="秒" 可以单独定；刚落到一场的开头先静一会儿，
//    data-hold="秒" 单独定。往回翻是在倒带：不自动播，等再往下推才接着播。
// 页面自己的引擎照旧只听 scroll 事件，所以各章的滚动动画不用改。减弱动效时整个不装。
(function () {
  "use strict";
  const TAU = 0.14;          // 阻尼时间常数（秒）：越大越"黏"
  const PULL = 70;           // 离开停靠点要先推过的距离（px）
  const GESTURE_GAP = 170;   // 两次滚轮间隔超过它算新的一下
  const RESUME = 1300;       // 手动滚动停下多久后恢复自动播放（ms）
  const SETTLE = 1000;       // 真正停稳在场景开头以后先静这么久再开始播（ms）
  const COMMIT = 0.22;       // 过渡带里朝一个方向推过两成多，直接认定去那一头
  const SNAP_MIN = 150;      // 过渡带里松手：朝推的方向走过这么多（px）就去那一头，不到就退回

  function install(opts) {
    const getScenes = opts.scenes;
    const root = document.documentElement;
    let cur = scrollY, target = scrollY, lastSet = -1, raf = 0, lastT = 0;
    let lastWheel = 0, lastDy = 0, swallowDir = 0, pull = 0, pullDir = 0, gestureFrom = 0;
    let lastInput = -1e9, arrivedAt = 0, playing = null, rewound = false, snapAt = 0;
    let detents = [], scenesInfo = [], stale = true;

    const vh = () => innerHeight;
    const maxY = () => Math.max(0, root.scrollHeight - innerHeight);
    const clamp = (y) => Math.min(maxY(), Math.max(0, y));

    function measure() {
      const y0 = scrollY, h = vh();
      scenesInfo = [];
      const set = new Set([0]);
      for (const el of getScenes()) {
        const r = el.getBoundingClientRect();
        if (!r.height) continue;
        const top = Math.round(r.top + y0);
        const end = Math.round(top + r.height - h);
        set.add(top);
        if (end > top + 4) { set.add(end); scenesInfo.push({ el, top, end }); }
      }
      set.add(Math.round(maxY()));
      detents = Array.from(set).filter((y) => y >= 0 && y <= maxY() + 1).sort((a, b) => a - b);
      stale = false;
    }
    const near = (y) => detents.find((d) => Math.abs(d - y) < 1.5);
    // 从 a 往 b 走，途中遇到的第一个停靠点（不含起点）
    function crossing(a, b) {
      if (b > a) { for (const d of detents) if (d > a + 1 && d <= b) return d; }
      else { for (let k = detents.length - 1; k >= 0; k--) { const d = detents[k]; if (d < a - 1 && d >= b) return d; } }
      return null;
    }
    const pinnedAt = (y) => scenesInfo.find((s) => y >= s.top - 1 && y < s.end - 1);
    function holdOf(s) {
      const own = s.el.dataset.hold;
      return own != null && own !== "" && Number(own) >= 0 ? Number(own) * 1000 : SETTLE;
    }
    // 两场之间的过渡带：target 所在的两个相邻停靠点，且这段不超过 1.2 屏（很长的普通内容不算）
    function bandAt(y) {
      if (pinnedAt(y)) return null;
      let a = 0, b = maxY();
      for (const d of detents) { if (d <= y + 0.5) a = d; if (d >= y - 0.5) { b = d; break; } }
      return b > a && b - a <= vh() * 1.2 ? { a, b } : null;
    }
    function duration(s) {
      const own = Number(s.el.dataset.play);
      if (own > 0) return own;
      return Math.min(11, Math.max(2.6, 1.4 + ((s.end - s.top) / vh()) * 2.3));
    }

    function kick() { if (!raf) { lastT = performance.now(); raf = requestAnimationFrame(frame); } }
    function frame(now) {
      raf = 0;
      const dt = Math.min(0.05, Math.max(0, (now - lastT) / 1000));
      lastT = now;
      if (stale) measure();
      // 别人挪了页面（滚动条、页内查找、滚动锚定）：跟上它，也不再自动往下播
      if (Math.abs(scrollY - lastSet) > 2) { cur = target = lastSet = scrollY; playing = null; lastInput = now; }
      autoplay(now, dt);
      const k = 1 - Math.exp(-dt / TAU);
      cur += (target - cur) * k;
      if (Math.abs(target - cur) < 0.4) cur = target;
      if (Math.abs(target - cur) < 2) { if (!arrivedAt) arrivedAt = now; } else arrivedAt = 0;
      // behavior:"instant"：页面若写了 scroll-behavior:smooth，也不能让浏览器再平滑一遍
      if (Math.abs(cur - lastSet) >= 0.01) { lastSet = cur; scrollTo({ top: cur, behavior: "instant" }); }
      if (cur !== target || playing || idleSnapPending(now) || wantsPlay(now)) raf = requestAnimationFrame(frame);
    }

    function wantsPlay(now) {
      if (playing || document.hidden || rewound) return false;
      const s = pinnedAt(target);
      return Boolean(s) && Math.abs(target - cur) < 2;
    }
    function autoplay(now, dt) {
      if (document.hidden) return;
      if (playing) {
        if (now - lastInput < RESUME) { playing = null; return; }
        target = Math.min(playing.end, target + playing.speed * dt);
        if (target >= playing.end) { target = playing.end; playing = null; }
        return;
      }
      if (rewound || now - lastInput < RESUME || !arrivedAt) return;
      const s = pinnedAt(target);
      if (!s) return;
      // 刚到场景开头：停稳后再静 hold 这么久；场景中途被打断的，RESUME 已经等过了
      if (Math.abs(target - s.top) < 2 && now - arrivedAt < holdOf(s)) return;
      playing = { end: s.end, speed: (s.end - s.top) / duration(s) };
    }

    // 停在过渡带里松手：朝最后一下推的方向走出 SNAP_MIN 就去那一头，不到就退回出发的那一头
    function idleSnapPending(now) {
      if (!snapAt || now < snapAt) return Boolean(snapAt);
      snapAt = 0;
      if (playing) return false;
      const band = bandAt(target);
      if (!band) return false;
      const { a, b } = band;
      if (Math.abs(target - a) < 1 || Math.abs(target - b) < 1) return false;
      const dir = Math.sign(lastDy);
      if (dir > 0) target = target - a > SNAP_MIN ? b : a;
      else if (dir < 0) { target = b - target > SNAP_MIN ? a : b; if (target === b) rewound = false; } // 没推过去弹回原处，不算倒带
      else target = target - a < b - target ? a : b;
      return true;
    }

    function push(dy, now) {
      if (stale) measure();
      const dir = Math.sign(dy);
      const fresh = now - lastWheel > GESTURE_GAP || Math.abs(dy) > Math.abs(lastDy) * 1.5 + 6 || dir !== Math.sign(lastDy);
      lastWheel = now; lastDy = dy; lastInput = now; playing = null;
      if (fresh) { swallowDir = 0; gestureFrom = target; }
      if (dir > 0) rewound = false;
      if (swallowDir && dir === swallowDir) return; // 被停靠点吸住后，同一下的惯性不再推动
      const at = near(target);
      if (at !== undefined && Math.abs(cur - at) < 3) {
        // 皮筋：离开停靠点要先推过 PULL，期间只挪一点点
        if (pullDir !== dir) { pull = 0; pullDir = dir; }
        pull += Math.abs(dy);
        if (pull < PULL) { target = clamp(at + dir * pull * 0.18); snapAt = now + 260; kick(); return; }
        pull = 0; pullDir = 0;
        target = at + dir * (PULL * 0.18);
      }
      const next = clamp(target + dy);
      const d = crossing(target, next);
      if (d !== null) { target = d; swallowDir = dir; pull = 0; pullDir = 0; }
      else {
        target = next;
        const inside = pinnedAt(target);
        const band = inside ? null : bandAt(target);
        // 钉住的场景里同一下往回推过两成多屏：直接回到这一场的开头，不用一段段倒着刷
        if (dir < 0 && inside && gestureFrom - target >= vh() * COMMIT) { target = inside.top; swallowDir = dir; }
        else if (band) {
          const f = (target - band.a) / (band.b - band.a);
          if (dir > 0 && f >= COMMIT) { target = band.b; swallowDir = dir; }
          else if (dir < 0 && f <= 1 - COMMIT) { target = band.a; swallowDir = dir; }
        }
      }
      if (dir < 0 && target < gestureFrom - 1) rewound = true; // 真的往回挪了（皮筋之内的轻碰不算）
      snapAt = now + 260;
      kick();
    }

    function scrollableInside(el, dy) {
      for (let n = el; n && n !== document.body && n !== root; n = n.parentElement) {
        if (n.nodeType !== 1) continue;
        const cs = getComputedStyle(n);
        if (!/(auto|scroll)/.test(cs.overflowY) || n.scrollHeight <= n.clientHeight + 1) continue;
        if (dy > 0 ? n.scrollTop + n.clientHeight < n.scrollHeight - 1 : n.scrollTop > 0) return true;
      }
      return false;
    }

    addEventListener("wheel", (event) => {
      if (event.ctrlKey || event.defaultPrevented) return;
      let dy = event.deltaY;
      if (!dy || Math.abs(event.deltaX) > Math.abs(dy)) return;
      if (event.deltaMode === 1) dy *= 16; else if (event.deltaMode === 2) dy *= vh();
      if (scrollableInside(event.target, dy)) return;
      event.preventDefault();
      push(dy, performance.now());
    }, { passive: false });

    addEventListener("keydown", (event) => {
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
      const t = event.target;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      // 焦点在按钮或链接上时，空格留给它自己（按下按钮），不拿来翻页
      if (event.key === " " && t && t.closest && t.closest("button, a[href], [role=button], summary")) return;
      let dir = 0;
      if (["ArrowDown", "PageDown"].includes(event.key) || (event.key === " " && !event.shiftKey)) dir = 1;
      else if (["ArrowUp", "PageUp"].includes(event.key) || (event.key === " " && event.shiftKey)) dir = -1;
      else if (event.key === "Home") { event.preventDefault(); to(0); return; }
      else if (event.key === "End") { event.preventDefault(); to(maxY()); return; }
      if (!dir) return;
      event.preventDefault();
      if (stale) measure();
      const base = playing ? playing.end : target;
      const d = dir > 0 ? detents.find((y) => y > base + 1) : [...detents].reverse().find((y) => y < base - 1);
      to(d === undefined ? (dir > 0 ? maxY() : 0) : d);
    });

    // 滚动条拖动、页内查找之类不经过这里的滚动：跟上它，别跟它抢
    addEventListener("scroll", () => {
      if (Math.abs(scrollY - lastSet) > 2 && !raf) { cur = target = lastSet = scrollY; playing = null; lastInput = performance.now(); kick(); }
    }, { passive: true });
    addEventListener("resize", () => { stale = true; cur = target = clamp(scrollY); });
    addEventListener("load", () => { stale = true; });
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => { stale = true; });

    function to(y) {
      if (stale) measure();
      playing = null; swallowDir = 0; pull = 0; lastDy = 0; rewound = false;
      target = clamp(y);
      // 远距离跳转：先瞬移到目标前一屏，只滑最后一屏，免得一路把中间每一章都刷一遍
      if (Math.abs(target - cur) > vh() * 2) { cur = lastSet = target - Math.sign(target - cur) * vh(); scrollTo({ top: cur, behavior: "instant" }); }
      lastInput = -1e9; arrivedAt = 0;
      kick();
    }
    // 章节首次渲染、字体到位都会改变场景高度：定期重量一次
    setInterval(() => { stale = true; }, 2000);
    kick();
    return { to, measure: () => { stale = true; }, get playing() { return Boolean(playing); } };
  }

  window.StoryGlide = { install };
})();
