/*
 * 年度分享图：三种风格各画一张 3:4 的卡（1080×1440），存成 PNG。
 * 直接在 canvas 上排字，不放封面和头像：一是隐私，二是抖音 CDN 的图会污染 canvas，toBlob 直接报错。
 * 背景图只用同源的本地图（年志的天空画），导出的离线文件里是 data URL，也不污染。
 * 页面：StoryCard.wire(按钮, 数据, { theme, privateTopics })，点了先开预览，三种风格可切换再存。
 */
(function () {
  "use strict";

  const W = 1080, H = 1440;
  const nf = new Intl.NumberFormat("zh-CN");
  const n = (v) => nf.format(Math.round(Number(v) || 0));
  const p2 = (v) => String(v).padStart(2, "0");
  const md = (d) => `${d.getMonth() + 1} 月 ${d.getDate()} 日`;
  const part = (h) => (h < 5 ? "凌晨" : h < 9 ? "早上" : h < 12 ? "上午" : h < 14 ? "中午" : h < 18 ? "下午" : "晚上");
  const clock = (h, m) => `${part(h)} ${h > 12 ? h - 12 : h}${m == null ? " 点" : `:${p2(m)}`}`;
  const dur = (min) => { const h = Math.floor(min / 60), m = min % 60; return h ? (m ? `${h} 时 ${m} 分` : `${h} 时`) : `${m} 分`; };
  function day(iso, withYear) {
    const [y, m, d] = String(iso).slice(0, 10).split("-").map(Number);
    return `${withYear ? `${y} 年 ` : ""}${m} 月 ${d} 日`;
  }

  // 三种风格共用的文字：卡上写什么只在这里定
  function lines(D) {
    const P = D.profile || {}, C = D.counts || {};
    const words = String(P.title || "").split("·").map((w) => w.trim()).filter(Boolean);
    const en = String(P.english || "").split("·").map((w) => w.trim()).filter(Boolean);
    const late = D.latest ? new Date(D.latest) : null, run = D.longestRun || null, start = run ? new Date(run.start) : null;
    const r = D.range, cross = r && String(r[0]).slice(0, 4) !== String(r[1]).slice(0, 4);
    return {
      year: D.year,
      range: r ? `${day(r[0], cross)}—${day(r[1], cross)}` : "时间不详",
      count: n(C.watch || D.unique), countLabel: C.watch ? "一共看了" : "一共看过",
      stats: [
        { k: "最常刷的钟点", v: D.peakHour == null ? "—" : clock(D.peakHour), s: "" },
        { k: "最晚的一次", v: late ? clock(late.getHours(), late.getMinutes()) : "—", s: late ? md(late) : "" },
        { k: "最长连着看了", v: run ? dur(run.minutes) : "—", s: run ? `${md(start)} ${p2(start.getHours())}:${p2(start.getMinutes())} 起，一口气 ${n(run.count)} 条` : "没有前后十分钟内接着看的" },
      ],
      rows: [
        { k: "最常看的创作者", v: D.topCreator ? D.topCreator.name : "—" },
        { k: "最常看的话题", v: D.topTopic ? `#${String(D.topTopic.name).replace(/^#/u, "")}` : "—" },
        { k: "听得最多的 BGM", v: D.music ? (D.music.author ? `${D.music.title} · ${D.music.author}` : D.music.title) : "—" },
      ],
      words: words.length === 3 ? words : null, en,
      hours: Array.isArray(D.hours) && D.hours.length === 24 ? D.hours.map((v) => Math.max(0, Number(v) || 0)) : null, peakHour: D.peakHour,
      days: (D.days || []).filter((d) => Array.isArray(d) && Number(d[1]) > 0).map((d) => [String(d[0]).slice(0, 10), Number(d[1])]).sort((a, b) => a[0].localeCompare(b[0])),
    };
  }
  const allText = (L) => [L.range, L.countLabel, L.count, "条内容年志档案馆", ...L.stats.flatMap((s) => [s.k, s.v, s.s]), ...L.rows.flatMap((r) => [r.k, r.v]), ...(L.words || ["三个词还空着"]), ...L.en].join("");

  // 先按宽度缩字号，缩到底还放不下就截断加 …
  function put(ctx, text, x, y, { font, size, min = size, width, color, align = "left", spacing = "0px", glow = null }) {
    ctx.letterSpacing = spacing;
    ctx.font = font(size);
    const w = ctx.measureText(text).width;
    if (width && w > width) size = Math.max(min, Math.floor((size * width) / w));
    ctx.font = font(size);
    // 字宽不完全随字号线性变化，差一点的再一号一号往下缩
    while (width && size > min && ctx.measureText(text).width > width) ctx.font = font(--size);
    let t = text;
    if (width) while (t.length > 1 && ctx.measureText(t).width > width) t = `${Array.from(t).slice(0, -2).join("")}…`;
    ctx.fillStyle = color;
    ctx.textAlign = align;
    if (glow) { ctx.shadowColor = glow; ctx.shadowBlur = size * 0.35; }
    ctx.fillText(t, x, y);
    ctx.shadowColor = "transparent"; ctx.shadowBlur = 0;
    return ctx.measureText(t).width;
  }
  const fill = (ctx, x, y, w, h, color) => { ctx.fillStyle = color; ctx.fillRect(x, y, w, h); };
  const f = (spec) => (size) => spec.replace("#", `${size}px`);

  // ---------------- 海报：新闻纸 + 墨黑 + 信号橙，粗线分栏 ----------------
  const poster = (() => {
    const INK = "#0A0A0A", PAPER = "#F1EEE6", SIG = "#FF4A1C", MUTE = "rgba(10,10,10,.62)";
    const CJK = '"Noto Sans SC","PingFang SC",sans-serif';
    const F = { cjk9: f(`900 # ${CJK}`), cjk7: f(`700 # ${CJK}`), cjk5: f(`500 # ${CJK}`), num: f(`400 # Anton,${CJK}`), mono: f(`700 # "JetBrains Mono","PingFang SC",monospace`) };
    const M = 64;
    return {
      fonts: [F.cjk9(40), F.cjk7(40), F.cjk5(40), F.num(40), F.mono(20)],
      draw(ctx, L) {
        fill(ctx, 0, 0, W, H, PAPER);
        fill(ctx, 0, 0, W, 112, INK);
        put(ctx, "内容年志", M, 74, { font: F.cjk9, size: 44, color: PAPER, spacing: "2px" });
        put(ctx, `EDITION ${L.year}`, W - M, 70, { font: F.mono, size: 22, color: SIG, align: "right", spacing: "4px" });

        put(ctx, "FROM — TO", M, 178, { font: F.mono, size: 20, color: INK, spacing: "5px" });
        put(ctx, L.range, M, 282, { font: F.cjk9, size: 92, min: 20, width: W - 2 * M, color: INK });
        fill(ctx, M, 316, W - 2 * M, 3, INK);

        put(ctx, L.countLabel, M, 378, { font: F.cjk7, size: 32, color: INK });
        ctx.font = F.cjk9(72);
        const unit = ctx.measureText("条").width + 16;
        const nw = put(ctx, L.count, M - 6, 640, { font: F.num, size: 290, min: 120, width: W - 2 * M - unit, color: SIG });
        put(ctx, "条", M - 6 + nw + 16, 640, { font: F.cjk9, size: 72, color: INK });
        fill(ctx, M, 690, W - 2 * M, 3, INK);

        const cw = (W - 2 * M) / 3, top = 690;
        L.stats.forEach((st, i) => {
          const x = M + i * cw, pad = i ? 26 : 0, inner = cw - pad - 22;
          if (i) fill(ctx, x, top, 3, 230, INK);
          put(ctx, st.k, x + pad, top + 56, { font: F.cjk7, size: 26, width: inner, color: INK });
          put(ctx, st.v, x + pad, top + 146, { font: F.cjk9, size: 62, min: 34, width: inner, color: st.v === "—" ? MUTE : INK });
          if (st.s) put(ctx, st.s, x + pad, top + 196, { font: F.cjk5, size: 22, min: 16, width: inner, color: MUTE });
        });
        fill(ctx, M, top + 230, W - 2 * M, 3, INK);

        L.rows.forEach((row, i) => {
          const y = top + 233 + i * 84;
          if (i) fill(ctx, M, y, W - 2 * M, 2, INK);
          put(ctx, row.k, M, y + 54, { font: F.cjk7, size: 24, width: 250, color: INK });
          put(ctx, row.v, M + 270, y + 58, { font: F.cjk9, size: 44, min: 30, width: W - 2 * M - 270, color: row.v === "—" ? MUTE : INK });
        });

        const by = 1176, bh = 168;
        fill(ctx, 0, by, W, bh, SIG);
        put(ctx, "SIGNED AS", M, by + 38, { font: F.mono, size: 18, color: INK, spacing: "5px" });
        if (L.words) L.words.forEach((w, i) => {
          const x = M + i * cw, pad = i ? 26 : 0, inner = cw - pad - 22;
          if (i) fill(ctx, x, by + 58, 3, bh - 82, INK);
          put(ctx, w, x + pad, by + 122, { font: F.cjk9, size: 64, min: 36, width: inner, color: INK });
          if (L.en[i]) put(ctx, L.en[i], x + pad, by + 152, { font: F.mono, size: 15, min: 11, width: inner, color: INK, spacing: "2px" });
        });
        else put(ctx, "三个词还空着", M, by + 122, { font: F.cjk9, size: 64, color: INK });

        fill(ctx, 0, H - 96, W, 96, INK);
        put(ctx, "DouyinDataReview · 非官方", W - M, H - 40, { font: F.mono, size: 22, color: PAPER, align: "right", spacing: "2px" });
      },
    };
  })();

  // ---------------- 档案馆：冷近黑星图 + 羊皮纸字 + 金 / 青，1px 青铜细线 ----------------
  const archive = (() => {
    const NIGHT = "#111315", PAPER = "#EFDFCC", PAPER2 = "#CFC1B0", MUTE = "#8C8172", GOLD = "#C59861", GOLD_HI = "#E3C8A6", GOLD_LO = "#8A6238", TEAL = "#8FB3B6", LINE = "#3A3228";
    const SERIF = '"Noto Serif SC","Songti SC","STSong",serif';
    // 数字用 Noto Serif SC 细体：Cormorant 默认是旧式数字，canvas 没法开 lining-nums
    const F = { s9: f(`900 # ${SERIF}`), s7: f(`700 # ${SERIF}`), s5: f(`500 # ${SERIF}`), num: f(`200 # ${SERIF}`), cap: f(`600 # "Cormorant Garamond",${SERIF}`), it: f(`italic 500 # "Cormorant Garamond",${SERIF}`) };
    const M = 96;
    function star(ctx, x, y, r, color) {
      ctx.fillStyle = color;
      ctx.beginPath();
      for (let i = 0; i < 8; i++) { const a = (i * Math.PI) / 4 - Math.PI / 2, d = i % 2 ? r * 0.22 : r; ctx.lineTo(x + Math.cos(a) * d, y + Math.sin(a) * d); }
      ctx.closePath();
      ctx.fill();
    }
    const hair = (ctx, x, y, w, h = 1, color = LINE) => fill(ctx, x, y, w, h, color);
    return {
      fonts: [F.s9(40), F.s7(40), F.s5(40), F.num(40), F.cap(20), F.it(20)],
      draw(ctx, L) {
        fill(ctx, 0, 0, W, H, NIGHT);
        const g = ctx.createRadialGradient(W * 0.55, H * 0.42, 80, W * 0.55, H * 0.42, H * 0.8);
        g.addColorStop(0, "rgba(27,31,32,.9)"); g.addColorStop(1, "rgba(10,11,11,1)");
        fill(ctx, 0, 0, W, H, g);
        // 星尘：固定种子，每次存出来的都一样
        let seed = 7;
        const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
        for (let i = 0; i < 170; i++) { ctx.globalAlpha = 0.12 + rnd() * 0.4; ctx.fillStyle = rnd() < 0.2 ? GOLD_HI : PAPER2; ctx.beginPath(); ctx.arc(rnd() * W, rnd() * H, 0.5 + rnd() * 1.3, 0, Math.PI * 2); ctx.fill(); }
        ctx.globalAlpha = 1;
        // 页框 + 金色 L 角
        ctx.strokeStyle = LINE; ctx.lineWidth = 1; ctx.strokeRect(48.5, 48.5, W - 97, H - 97);
        ctx.strokeStyle = GOLD_LO;
        for (const [x, y, dx, dy] of [[42, 42, 1, 1], [W - 42, 42, -1, 1], [42, H - 42, 1, -1], [W - 42, H - 42, -1, -1]]) {
          ctx.beginPath(); ctx.moveTo(x + 0.5 * dx, y + 34 * dy); ctx.lineTo(x + 0.5 * dx, y + 0.5 * dy); ctx.lineTo(x + 34 * dx, y + 0.5 * dy); ctx.stroke();
        }

        put(ctx, "档案馆", M, 140, { font: F.s7, size: 36, color: PAPER, spacing: "6px" });
        put(ctx, `Anno ${L.year}`, W - M, 138, { font: F.it, size: 34, color: GOLD, align: "right" });
        hair(ctx, M, 168, W - 2 * M);

        put(ctx, "OBSERVATIO · 观测区间", M, 232, { font: F.cap, size: 20, color: GOLD, spacing: "6px" });
        put(ctx, L.range, M, 318, { font: F.s9, size: 76, min: 20, width: W - 2 * M, color: PAPER });

        put(ctx, `NUMERUS · ${L.countLabel}`, M, 412, { font: F.cap, size: 20, color: GOLD, spacing: "6px" });
        ctx.font = F.s7(64);
        const unit = ctx.measureText("条").width + 20;
        const nw = put(ctx, L.count, M - 8, 640, { font: F.num, size: 250, min: 110, width: W - 2 * M - unit - 150, color: GOLD_HI, glow: "rgba(227,200,166,.28)" });
        put(ctx, "条", M - 8 + nw + 20, 640, { font: F.s7, size: 64, color: PAPER });
        star(ctx, W - M - 60, 540, 46, GOLD);
        star(ctx, W - M - 6, 462, 14, GOLD_HI);

        const top = 690, cw = (W - 2 * M) / 3;
        hair(ctx, M, top, W - 2 * M);
        L.stats.forEach((st, i) => {
          const x = M + i * cw, pad = i ? 28 : 0, inner = cw - pad - 20;
          if (i) hair(ctx, x, top + 28, 1, 170);
          put(ctx, st.k, x + pad, top + 62, { font: F.s5, size: 23, width: inner, color: TEAL, spacing: "2px" });
          put(ctx, st.v, x + pad, top + 142, { font: F.s7, size: 52, min: 30, width: inner, color: st.v === "—" ? MUTE : PAPER });
          if (st.s) put(ctx, st.s, x + pad, top + 188, { font: F.s5, size: 20, min: 15, width: inner, color: MUTE });
        });
        hair(ctx, M, top + 226, W - 2 * M);

        L.rows.forEach((row, i) => {
          const y = top + 226 + i * 78;
          if (i) hair(ctx, M, y, W - 2 * M);
          star(ctx, M + 7, y + 41, 7, GOLD);
          put(ctx, row.k, M + 30, y + 50, { font: F.s5, size: 22, width: 240, color: TEAL, spacing: "2px" });
          put(ctx, row.v, M + 290, y + 54, { font: F.s7, size: 38, min: 26, width: W - 2 * M - 290, color: row.v === "—" ? MUTE : PAPER });
        });
        hair(ctx, M, top + 460, W - 2 * M);

        // 落款：三个词居中，金色四角星隔开
        put(ctx, "SUBSCRIPTIO · 落款", W / 2, 1214, { font: F.cap, size: 20, color: GOLD, align: "center", spacing: "6px" });
        if (L.words) {
          ctx.font = F.s9(66); ctx.letterSpacing = "4px";
          const gap = 70, ws = L.words.map((w) => ctx.measureText(w).width);
          const k = Math.min(1, (W - 2 * M - gap * 2) / ws.reduce((a, b) => a + b, 0));
          let x = (W - (ws.reduce((a, b) => a + b, 0) * k + gap * 2)) / 2;
          L.words.forEach((w, i) => {
            put(ctx, w, x + (ws[i] * k) / 2, 1296, { font: F.s9, size: Math.floor(66 * k), color: GOLD_HI, align: "center", spacing: "4px" });
            if (L.en[i]) put(ctx, L.en[i], x + (ws[i] * k) / 2, 1332, { font: F.it, size: 20, min: 14, width: ws[i] * k + gap - 10, color: GOLD, align: "center" });
            x += ws[i] * k;
            if (i < 2) star(ctx, x + gap / 2, 1274, 12, GOLD);
            x += gap;
          });
        } else put(ctx, "三个词还空着", W / 2, 1296, { font: F.s9, size: 60, color: MUTE, align: "center" });

        put(ctx, "DOUYINDATAREVIEW · 非官方", W - M, H - 66, { font: F.cap, size: 17, color: MUTE, align: "right", spacing: "4px" });
      },
    };
  })();

  // ---------------- 内容年志：天空油画 + 夜色玻璃，细衬线、琥珀光 ----------------
  const trace = (() => {
    const CREAM = "#F6F1E4", AMBER = "#EEA44E", WARM = "#FBE3BB", SOFT = "rgba(246,241,228,.72)", FAINT = "rgba(246,241,228,.5)", LINE = "rgba(246,241,228,.22)";
    const SERIF = 'Fraunces,"Noto Serif SC","Songti SC",serif', SANS = 'Inter,"PingFang SC","Noto Sans SC",sans-serif';
    const F = { s2: f(`200 # ${SERIF}`), s3: f(`300 # ${SERIF}`), s5: f(`500 # ${SERIF}`), it: f(`italic 300 # ${SERIF}`), sans: f(`400 # ${SANS}`), mono: f(`400 # "SFMono-Regular",ui-monospace,Menlo,monospace`) };
    const M = 88;
    const cover = (ctx, bg) => { const s = Math.max(W / bg.width, H / bg.height); ctx.drawImage(bg, (W - bg.width * s) / 2, (H - bg.height * s) / 2, bg.width * s, bg.height * s); };
    const glowDot = (ctx, x, y, r, color, blur) => { ctx.fillStyle = color; ctx.shadowColor = color; ctx.shadowBlur = blur; ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill(); ctx.shadowBlur = 0; ctx.shadowColor = "transparent"; };

    // 24 小时光盘：每个钟点一根光针，越常刷越长，最常刷的那根是琥珀色
    function dial(ctx, cx, cy, R, hours, peak) {
      const max = Math.max(1, ...hours), r0 = R * 0.42;
      const halo = ctx.createRadialGradient(cx, cy, 0, cx, cy, R * 1.15);
      halo.addColorStop(0, "rgba(238,164,78,.16)"); halo.addColorStop(1, "rgba(238,164,78,0)");
      ctx.fillStyle = halo; ctx.beginPath(); ctx.arc(cx, cy, R * 1.15, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = "rgba(7,10,18,.5)"; ctx.beginPath(); ctx.arc(cx, cy, r0, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = LINE; ctx.lineWidth = 1;
      for (const r of [r0, R]) { ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke(); }
      ctx.lineCap = "round";
      hours.forEach((v, h) => {
        const a = (h / 24) * Math.PI * 2 - Math.PI / 2, len = 6 + (R - r0 - 10) * Math.sqrt(v / max), pk = h === peak;
        ctx.strokeStyle = pk ? AMBER : `rgba(246,241,228,${0.3 + 0.55 * (v / max)})`;
        ctx.lineWidth = pk ? 7 : 4;
        if (pk) { ctx.shadowColor = "rgba(238,164,78,.95)"; ctx.shadowBlur = 22; }
        ctx.beginPath(); ctx.moveTo(cx + Math.cos(a) * (r0 + 6), cy + Math.sin(a) * (r0 + 6)); ctx.lineTo(cx + Math.cos(a) * (r0 + 6 + len), cy + Math.sin(a) * (r0 + 6 + len)); ctx.stroke();
        ctx.shadowBlur = 0; ctx.shadowColor = "transparent";
      });
      ctx.lineCap = "butt";
      for (const [h, t] of [[0, "0"], [6, "6"], [12, "12"], [18, "18"]]) {
        const a = (h / 24) * Math.PI * 2 - Math.PI / 2;
        put(ctx, t, cx + Math.cos(a) * (R + 18), cy + Math.sin(a) * (R + 18) + 5, { font: F.mono, size: 15, color: FAINT, align: "center" });
      }
      if (peak != null) {
        put(ctx, p2(peak), cx, cy + 12, { font: F.s3, size: 40, color: WARM, align: "center", glow: "rgba(238,164,78,.7)" });
        put(ctx, "PEAK", cx, cy + 34, { font: F.mono, size: 12, color: AMBER, align: "center", spacing: "3px" });
      }
    }

    // 每天看了多少，按周平滑成一条发光的线，底下一层渐隐
    function ribbon(ctx, x, y, w, h, days) {
      const DAY = 864e5, t = (iso) => Date.parse(`${iso}T00:00:00Z`);
      const t0 = t(days[0][0]), N = Math.round((t(days[days.length - 1][0]) - t0) / DAY) + 1;
      if (N < 14) return false;
      const v = new Array(N).fill(0);
      for (const [iso, c] of days) v[Math.round((t(iso) - t0) / DAY)] = c;
      const sm = v.map((_, i) => { let s = 0, k = 0; for (let j = Math.max(0, i - 3); j <= Math.min(N - 1, i + 3); j++) { s += v[j]; k++; } return s / k; });
      const max = Math.max(1, ...sm), pts = sm.map((s, i) => [x + (i / (N - 1)) * w, y + h - (s / max) * h]);
      const path = () => { ctx.beginPath(); pts.forEach(([px, py], i) => (i ? ctx.lineTo(px, py) : ctx.moveTo(px, py))); };
      path(); ctx.lineTo(x + w, y + h); ctx.lineTo(x, y + h); ctx.closePath();
      const g = ctx.createLinearGradient(0, y, 0, y + h);
      g.addColorStop(0, "rgba(238,164,78,.34)"); g.addColorStop(1, "rgba(238,164,78,0)");
      ctx.fillStyle = g; ctx.fill();
      path(); ctx.strokeStyle = WARM; ctx.lineWidth = 2; ctx.lineJoin = "round";
      ctx.shadowColor = "rgba(238,164,78,.9)"; ctx.shadowBlur = 12; ctx.stroke(); ctx.shadowBlur = 0; ctx.shadowColor = "transparent";
      const top = pts.reduce((a, b) => (b[1] < a[1] ? b : a));
      glowDot(ctx, top[0], top[1], 5, WARM, 18);
      return true;
    }

    return {
      fonts: [F.s2(40), F.s3(40), F.s5(40), F.it(40), F.sans(20), F.mono(20)],
      draw(ctx, L, bg) {
        fill(ctx, 0, 0, W, H, "#0c1220");
        if (bg) cover(ctx, bg);
        // 上半让天空透出来，往下沉进夜色
        const g = ctx.createLinearGradient(0, 0, 0, H);
        g.addColorStop(0, "rgba(7,10,18,.5)"); g.addColorStop(0.3, "rgba(7,10,18,.22)"); g.addColorStop(0.55, "rgba(7,10,18,.5)"); g.addColorStop(1, "rgba(7,10,18,.9)");
        fill(ctx, 0, 0, W, H, g);
        // 光尘：固定种子，每次存出来的一样
        let seed = 11;
        const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
        for (let i = 0; i < 90; i++) { const y = rnd() * H * 0.62; ctx.globalAlpha = 0.25 + rnd() * 0.6; glowDot(ctx, rnd() * W, y, 0.6 + rnd() * 1.6, rnd() < 0.3 ? WARM : CREAM, 6); }
        ctx.globalAlpha = 1;
        ctx.strokeStyle = "rgba(254,255,252,.4)"; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.roundRect(40, 40, W - 80, H - 80, 36); ctx.stroke();

        put(ctx, "TRACE", M, 122, { font: F.mono, size: 20, color: SOFT, spacing: "8px" });
        put(ctx, `ANNUAL VOLUME · ${L.year}`, W - M, 122, { font: F.mono, size: 20, color: SOFT, align: "right", spacing: "6px" });
        put(ctx, "内容年志", M, 206, { font: F.s3, size: 50, color: CREAM, spacing: "4px" });

        put(ctx, "FROM · TO", M, 280, { font: F.mono, size: 16, color: AMBER, spacing: "6px" });
        put(ctx, L.range, M, 350, { font: F.s3, size: 62, min: 20, width: W - 2 * M, color: CREAM });

        const R = 106, dcx = W - M - R - 16, dcy = 522;
        if (L.hours) dial(ctx, dcx, dcy, R, L.hours, L.peakHour);
        const room = L.hours ? dcx - R - 40 - M : W - 2 * M;
        put(ctx, L.countLabel, M, 446, { font: F.sans, size: 26, color: SOFT });
        ctx.font = F.s3(60);
        const unit = ctx.measureText("条").width + 16;
        const nw = put(ctx, L.count, M - 8, 640, { font: F.s2, size: 230, min: 100, width: room - unit, color: CREAM, glow: "rgba(238,164,78,.55)" });
        put(ctx, "条", M - 8 + nw + 16, 640, { font: F.s3, size: 60, color: CREAM });

        // 光带：每天的量
        if (L.days.length && ribbon(ctx, M, 676, W - 2 * M, 56, L.days)) {
          put(ctx, L.days[0][0].slice(5).replace("-", "."), M, 756, { font: F.mono, size: 13, color: FAINT, spacing: "2px" });
          put(ctx, "EVERY DAY, IN LIGHT", W / 2, 756, { font: F.mono, size: 13, color: FAINT, align: "center", spacing: "4px" });
          put(ctx, L.days[L.days.length - 1][0].slice(5).replace("-", "."), W - M, 756, { font: F.mono, size: 13, color: FAINT, align: "right", spacing: "2px" });
        }

        // 夜色玻璃：把画模糊了重画在面板里
        const px = 64, py = 778, pw = W - 128, ph = 404, pr = 28;
        ctx.save();
        ctx.beginPath(); ctx.roundRect(px, py, pw, ph, pr); ctx.clip();
        if (bg) { ctx.filter = "blur(26px) saturate(1.3)"; cover(ctx, bg); ctx.filter = "none"; }
        fill(ctx, px, py, pw, ph, "rgba(10,14,26,.62)");
        const sheen = ctx.createLinearGradient(0, py, 0, py + ph);
        sheen.addColorStop(0, "rgba(255,255,255,.07)"); sheen.addColorStop(0.25, "rgba(255,255,255,0)");
        fill(ctx, px, py, pw, ph, sheen);
        ctx.restore();
        ctx.strokeStyle = "rgba(246,241,228,.2)"; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.roundRect(px + 0.5, py + 0.5, pw - 1, ph - 1, pr); ctx.stroke();

        const ix = px + 34, iw = pw - 68, cw = iw / 3, top = py + 8;
        L.stats.forEach((st, i) => {
          const x = ix + i * cw, pad = i ? 28 : 0, inner = cw - pad - 18;
          if (i) fill(ctx, x, top + 30, 1, 140, LINE);
          put(ctx, st.k, x + pad, top + 58, { font: F.sans, size: 21, width: inner, color: SOFT });
          put(ctx, st.v, x + pad, top + 126, { font: F.s3, size: 48, min: 28, width: inner, color: st.v === "—" ? FAINT : CREAM });
          if (st.s) put(ctx, st.s, x + pad, top + 166, { font: F.sans, size: 18, min: 13, width: inner, color: FAINT });
        });
        L.rows.forEach((row, i) => {
          const y = top + 196 + i * 66;
          fill(ctx, ix, y, iw, 1, LINE);
          glowDot(ctx, ix + 4, y + 36, 3, i ? CREAM : AMBER, 8);
          put(ctx, row.k, ix + 22, y + 43, { font: F.sans, size: 20, width: 220, color: SOFT });
          put(ctx, row.v, ix + 250, y + 46, { font: F.s5, size: 32, min: 22, width: iw - 250, color: row.v === "—" ? FAINT : CREAM });
        });

        // 落款：中间那个词斜体、暖色发光，和年志第九章一样
        const sw = (W - 2 * M) / 3;
        put(ctx, "SIGNED AS", M, 1226, { font: F.mono, size: 15, color: AMBER, spacing: "6px" });
        if (L.words) L.words.forEach((w, i) => {
          const x = M + i * sw, inner = sw - 24;
          put(ctx, w, x, 1294, { font: i === 1 ? F.it : F.s3, size: 60, min: 34, width: inner, color: i === 1 ? WARM : CREAM, glow: i === 1 ? "rgba(238,164,78,.75)" : "rgba(238,164,78,.3)" });
          if (L.en[i]) put(ctx, L.en[i], x, 1326, { font: F.mono, size: 13, min: 10, width: inner, color: SOFT, spacing: "3px" });
        });
        else put(ctx, "三个词还空着", M, 1294, { font: F.s3, size: 60, color: FAINT });

        glowDot(ctx, M + 6, H - 82, 6, AMBER, 14);
        put(ctx, L.words ? "SIGNED" : "UNSIGNED", M + 24, H - 76, { font: F.mono, size: 16, color: SOFT, spacing: "5px" });
        put(ctx, "DouyinDataReview · 非官方", W - M, H - 76, { font: F.mono, size: 17, color: SOFT, align: "right", spacing: "3px" });
      },
    };
  })();

  const THEMES = { poster, archive, trace };
  const loadImage = (src) => new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null); // 画不出背景就用纯色底
    img.src = src;
  });

  // 预览里能切到别的风格，那种风格的字体当前页面没加载，先把它的 Google Fonts 挂上
  const FONT_CSS = {
    poster: "family=Anton&family=JetBrains+Mono:wght@700&family=Noto+Sans+SC:wght@500;700;900",
    archive: "family=Cormorant+Garamond:ital,wght@0,600;1,500&family=Noto+Serif+SC:wght@200;500;700;900",
    trace: "family=Fraunces:ital,opsz,wght@0,9..144,100..700;1,9..144,100..700&family=Inter:wght@400;500&family=Noto+Serif+SC:wght@200;300;500",
  };
  const fontSheets = {};
  function fontSheet(theme) {
    if (!fontSheets[theme]) fontSheets[theme] = new Promise((resolve) => {
      const link = Object.assign(document.createElement("link"), { rel: "stylesheet", href: `https://fonts.googleapis.com/css2?${FONT_CSS[theme]}&display=swap` });
      link.onload = link.onerror = () => resolve();
      setTimeout(resolve, 4000); // 离线或很慢：不等了，退回系统字体
      document.head.append(link);
    });
    return fontSheets[theme];
  }

  // 年志卡的天空：按最常刷的钟点挑一幅，和年志第二章同一套对应；导出的离线文件里取内联的那份
  function skyOf(D) {
    const h = D.peakHour;
    const name = h == null ? "entry-mix" : h <= 4 ? "entry-night" : h <= 8 ? "sky-s0-dawn" : h <= 15 ? "sky-s1-morning" : h <= 18 ? "sky-s2-dusk" : h <= 21 ? "sky-s4-ember" : "sky-s3-night";
    const ex = window.__STORY_EXPORT__;
    return (ex && ex.assets && ex.assets[name]) || `story-images/${name}.jpg`;
  }

  async function draw(D, theme) {
    const T = THEMES[theme], L = lines(D);
    await fontSheet(theme);
    // Noto 系列按字分片加载：页面上没出现过的字要先点名拉下来，canvas 才画得出
    if (document.fonts && document.fonts.load) {
      const text = `${allText(L)}EDITION FROM—TO SIGNED AS UNSIGNED Anno OBSERVATIO NUMERUS SUBSCRIPTIO DouyinDataReview DOUYINDATAREVIEW·非官方 TRACE ANNUAL VOLUME PEAK EVERY DAY, IN LIGHT 0123456789.`;
      await Promise.all(T.fonts.map((font) => document.fonts.load(font, text))).catch(() => { /* offline: system fonts */ });
    }
    const c = Object.assign(document.createElement("canvas"), { width: W, height: H });
    T.draw(c.getContext("2d"), L, theme === "trace" ? await loadImage(skyOf(D)) : null);
    return c;
  }

  const NAMES = { poster: "海报", archive: "档案馆", trace: "内容年志" };
  async function save(D, theme, canvas) {
    const c = canvas || (await draw(D, theme));
    const blob = await new Promise((resolve, reject) => c.toBlob((b) => (b ? resolve(b) : reject(new Error("toBlob returned null"))), "image/png"));
    const url = URL.createObjectURL(blob);
    const link = Object.assign(document.createElement("a"), { href: url, download: `内容年志-分享图-${NAMES[theme]}-${D.year}.png` });
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }

  // ---------------- 预览：先看样子，三种风格随便切，满意了再存 ----------------
  // 弹层用中性的系统字和深灰底，放进哪一种页面都一样；规则都挂在 .sc-ov 下，压过各页的 reset
  const CSS = `
.sc-ov{position:fixed;inset:0;z-index:2147483000;display:grid;place-items:center;padding:24px;background:rgba(8,8,10,.93);font:400 14px/1.6 -apple-system,BlinkMacSystemFont,"PingFang SC","Noto Sans SC",sans-serif;color:#ECEAE4;letter-spacing:0;text-transform:none}
.sc-ov *{box-sizing:border-box}
.sc-ov .sc-box{display:flex;gap:28px;align-items:stretch;max-width:100%;max-height:100%}
.sc-ov .sc-stage{position:relative;flex:none;height:min(calc(100vh - 48px),1000px);aspect-ratio:3/4;max-width:calc(100vw - 48px - 28px - 236px);background:#1c1c1f;outline:1px solid rgba(255,255,255,.12)}
.sc-ov .sc-stage canvas{display:block;width:100%;height:100%;max-width:none}
.sc-ov .sc-wait{position:absolute;inset:0;display:grid;place-items:center;color:rgba(236,234,228,.6);font-size:13px;background:rgba(28,28,31,.55)}
.sc-ov .sc-wait[hidden]{display:none}
.sc-ov .sc-side{width:236px;display:flex;flex-direction:column;gap:14px;padding-top:4px}
.sc-ov .sc-h{font-size:18px;font-weight:600;line-height:1.3;margin:0}
.sc-ov .sc-k{font-size:12px;color:rgba(236,234,228,.6);margin:0}
.sc-ov .sc-tabs{display:grid;gap:6px}
.sc-ov .sc-tab{display:flex;align-items:center;justify-content:space-between;width:100%;height:40px;padding:0 14px;border:1px solid rgba(255,255,255,.18);background:transparent;color:#ECEAE4;font-family:inherit;font-weight:500;font-size:14px;line-height:1;cursor:pointer;text-align:left}
.sc-ov .sc-tab:hover{border-color:rgba(255,255,255,.4)}
.sc-ov .sc-tab[aria-checked="true"]{background:#ECEAE4;border-color:#ECEAE4;color:#111}
.sc-ov .sc-tab i{font-style:normal;font-size:11px;opacity:.6}
.sc-ov .sc-note{font-size:12px;line-height:1.7;color:rgba(236,234,228,.66);margin:0}
.sc-ov .sc-acts{margin-top:auto;display:grid;gap:8px}
.sc-ov .sc-save,.sc-ov .sc-close{height:42px;border:1px solid #ECEAE4;font-family:inherit;font-weight:600;font-size:14px;line-height:1;cursor:pointer}
.sc-ov .sc-save{background:#ECEAE4;color:#111}
.sc-ov .sc-save:disabled{opacity:.5;cursor:default}
.sc-ov .sc-close{background:transparent;color:#ECEAE4;border-color:rgba(255,255,255,.3)}
.sc-ov button:focus-visible{outline:2px solid #8FB3FF;outline-offset:2px}`;

  function open(D, { theme, privateTopics = false }) {
    if (document.querySelector(".sc-ov")) return;
    if (!document.getElementById("sc-css")) document.head.append(Object.assign(document.createElement("style"), { id: "sc-css", textContent: CSS }));
    // 隐私开着：名字和歌名抹成方块，和「导出」同一套（话题按各页自己的规矩）
    const data = document.body.classList.contains("privacy-on") && window.StoryExport ? window.StoryExport.scrub(D, { privateTopics }) : D;
    const el = (tag, cls, text) => Object.assign(document.createElement(tag), cls ? { className: cls } : {}, text != null ? { textContent: text } : {});
    const ov = el("div", "sc-ov");
    ov.setAttribute("role", "dialog");
    ov.setAttribute("aria-modal", "true");
    ov.setAttribute("aria-label", "分享图预览");
    const stage = el("div", "sc-stage"), wait = el("p", "sc-wait", "排版中…");
    stage.append(wait);
    const tabs = el("div", "sc-tabs");
    tabs.setAttribute("role", "radiogroup");
    tabs.setAttribute("aria-label", "风格");
    const save1 = el("button", "sc-save", "存成 PNG"), close1 = el("button", "sc-close", "关闭");
    save1.type = close1.type = "button";
    const side = el("div", "sc-side");
    const acts = el("div", "sc-acts");
    acts.append(save1, close1);
    side.append(el("h2", "sc-h", "分享图预览"), el("p", "sc-k", "挑一种风格，看着合适再存。"), tabs,
      el("p", "sc-note", data === D ? "存下来是 1080 × 1440 的 PNG。" : "隐私模式开着：创作者和歌名已经换成方块。存下来是 1080 × 1440 的 PNG。"), acts);
    const box = el("div", "sc-box");
    box.append(stage, side);
    ov.append(box);

    const order = ["poster", "archive", "trace"];
    const buttons = order.map((t) => {
      const b = el("button", "sc-tab");
      b.type = "button";
      b.setAttribute("role", "radio");
      b.append(el("span", null, NAMES[t]), el("i", null, t === theme ? "本页" : ""));
      b.addEventListener("click", () => show(t));
      tabs.append(b);
      return b;
    });
    const cache = {};
    let current = null, want = null;
    async function show(t) {
      want = t;
      buttons.forEach((b, i) => { b.setAttribute("aria-checked", String(order[i] === t)); b.tabIndex = order[i] === t ? 0 : -1; });
      if (!cache[t]) {
        wait.hidden = false;
        save1.disabled = true;
        cache[t] = draw(data, t).catch((error) => { delete cache[t]; throw error; });
      }
      let c;
      try { c = await cache[t]; }
      catch (error) { console.error("[StoryCard]", error); if (want === t) wait.textContent = "这一种没画出来，换一种试试"; return; }
      if (want !== t) return; // 画的时候已经切走了
      if (current) current.remove();
      current = c;
      stage.prepend(c);
      wait.hidden = true;
      save1.disabled = false;
    }
    save1.addEventListener("click", async () => {
      if (save1.disabled || !current) return;
      save1.disabled = true;
      try { await save(D, want, current); save1.textContent = "已存好"; }
      catch (error) { console.error("[StoryCard]", error); save1.textContent = "存失败了"; }
      setTimeout(() => { save1.textContent = "存成 PNG"; save1.disabled = false; }, 1600);
    });

    // 弹层开着时，页面自己的翻页、滚动、Esc 回工作台都不该响
    const back = document.activeElement;
    const onKey = (event) => {
      event.stopImmediatePropagation();
      if (event.key === "Escape") { event.preventDefault(); shut(); }
      else if ((event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "ArrowLeft" || event.key === "ArrowRight") && tabs.contains(document.activeElement)) {
        event.preventDefault();
        const k = (order.indexOf(want) + (event.key === "ArrowDown" || event.key === "ArrowRight" ? 1 : 2)) % 3;
        show(order[k]);
        buttons[k].focus();
      } else if (/^(PageUp|PageDown|Home|End| |Enter)$/u.test(event.key) && !(event.key === " " || event.key === "Enter" ? ov.contains(document.activeElement) && document.activeElement.tagName === "BUTTON" : false)) {
        event.preventDefault(); // 翻页键别让底下的页面滚；焦点在弹层按钮上时空格、回车照常按下去
      } else if (event.key === "Tab") {
        const f = [...buttons.filter((b) => b.tabIndex === 0), save1, close1];
        const i = f.indexOf(document.activeElement);
        event.preventDefault();
        f[(i + (event.shiftKey ? f.length - 1 : 1)) % f.length].focus();
      }
    };
    const onWheel = (event) => { event.stopImmediatePropagation(); event.preventDefault(); };
    // 长卷会自己往下播，弹层开着时按住它
    const glide = (window.__POSTER || window.__TRACE || {}).glide;
    if (glide && glide.hold) glide.hold(true);
    function shut() {
      if (glide && glide.hold) glide.hold(false);
      removeEventListener("keydown", onKey, true);
      removeEventListener("wheel", onWheel, { capture: true });
      ov.remove();
      if (back && back.focus) back.focus();
    }
    addEventListener("keydown", onKey, true);
    addEventListener("wheel", onWheel, { capture: true, passive: false });
    ov.addEventListener("click", (event) => { event.stopPropagation(); if (event.target === ov) shut(); });
    close1.addEventListener("click", shut);
    document.body.append(ov);
    show(theme);
    save1.focus();
  }

  // 按钮：点一下打开预览，默认停在这一页的风格
  function wire(button, D, { theme, privateTopics = false }) {
    button.hidden = false;
    button.addEventListener("click", (event) => {
      event.stopPropagation(); // 档案馆点页面就翻页
      open(D, { theme, privateTopics });
    });
  }

  window.StoryCard = { lines, draw, save, open, wire };
})();
