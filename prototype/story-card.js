/*
 * 年度分享图：三种风格各画一张 3:4 的卡（1080×1440），存成 PNG。
 * 直接在 canvas 上排字，不放封面和头像：一是隐私，二是抖音 CDN 的图会污染 canvas，toBlob 直接报错。
 * 背景图只用同源的本地图（年志的天空画），导出的离线文件里是 data URL，也不污染。
 * 页面：StoryCard.wire(按钮, 数据, { theme, privateTopics, bg })。
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
    const CREAM = "#F6F1E4", AMBER = "#EEA44E", WARM = "#FBE3BB", SOFT = "rgba(246,241,228,.72)", FAINT = "rgba(246,241,228,.5)", LINE = "rgba(246,241,228,.26)";
    const SERIF = 'Fraunces,"Noto Serif SC","Songti SC",serif', SANS = 'Inter,"PingFang SC","Noto Sans SC",sans-serif';
    const F = { s2: f(`200 # ${SERIF}`), s3: f(`300 # ${SERIF}`), s5: f(`500 # ${SERIF}`), it: f(`italic 300 # ${SERIF}`), sans: f(`400 # ${SANS}`), mono: f(`400 # "SFMono-Regular",ui-monospace,Menlo,monospace`) };
    const M = 88;
    return {
      fonts: [F.s2(40), F.s3(40), F.s5(40), F.it(40), F.sans(20)],
      draw(ctx, L, bg) {
        fill(ctx, 0, 0, W, H, "#0c1220");
        if (bg) {
          const s = Math.max(W / bg.width, H / bg.height);
          ctx.drawImage(bg, (W - bg.width * s) / 2, (H - bg.height * s) / 2, bg.width * s, bg.height * s);
        }
        const g = ctx.createLinearGradient(0, 0, 0, H);
        g.addColorStop(0, "rgba(7,10,18,.62)"); g.addColorStop(0.45, "rgba(7,10,18,.42)"); g.addColorStop(0.72, "rgba(7,10,18,.6)"); g.addColorStop(1, "rgba(7,10,18,.86)");
        fill(ctx, 0, 0, W, H, g);
        ctx.strokeStyle = "rgba(254,255,252,.4)"; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.roundRect(40, 40, W - 80, H - 80, 36); ctx.stroke();
        const hair = (y) => fill(ctx, M, y, W - 2 * M, 1, LINE);

        put(ctx, "TRACE", M, 122, { font: F.mono, size: 20, color: SOFT, spacing: "8px" });
        put(ctx, `ANNUAL VOLUME · ${L.year}`, W - M, 122, { font: F.mono, size: 20, color: SOFT, align: "right", spacing: "6px" });
        put(ctx, "内容年志", M, 206, { font: F.s3, size: 50, color: CREAM, spacing: "4px" });

        put(ctx, "FROM · TO", M, 284, { font: F.mono, size: 16, color: AMBER, spacing: "6px" });
        put(ctx, L.range, M, 360, { font: F.s3, size: 70, min: 20, width: W - 2 * M, color: CREAM });

        put(ctx, L.countLabel, M, 446, { font: F.sans, size: 26, color: SOFT });
        ctx.font = F.s3(64);
        const unit = ctx.measureText("条").width + 18;
        const nw = put(ctx, L.count, M - 10, 680, { font: F.s2, size: 260, min: 110, width: W - 2 * M - unit, color: CREAM, glow: "rgba(238,164,78,.55)" });
        put(ctx, "条", M - 10 + nw + 18, 680, { font: F.s3, size: 64, color: CREAM });

        const top = 730, cw = (W - 2 * M) / 3;
        hair(top);
        L.stats.forEach((st, i) => {
          const x = M + i * cw, pad = i ? 28 : 0, inner = cw - pad - 20;
          if (i) fill(ctx, x, top + 30, 1, 150, LINE);
          put(ctx, st.k, x + pad, top + 60, { font: F.sans, size: 22, width: inner, color: SOFT });
          put(ctx, st.v, x + pad, top + 132, { font: F.s3, size: 50, min: 30, width: inner, color: st.v === "—" ? FAINT : CREAM });
          if (st.s) put(ctx, st.s, x + pad, top + 176, { font: F.sans, size: 19, min: 14, width: inner, color: FAINT });
        });
        hair(top + 212);
        L.rows.forEach((row, i) => {
          const y = top + 212 + i * 74;
          if (i) hair(y);
          put(ctx, row.k, M, y + 48, { font: F.sans, size: 21, width: 230, color: SOFT });
          put(ctx, row.v, M + 260, y + 52, { font: F.s5, size: 34, min: 24, width: W - 2 * M - 260, color: row.v === "—" ? FAINT : CREAM });
        });
        hair(top + 434);

        // 落款：中间那个词斜体、暖色发光，和年志第九章一样
        put(ctx, "SIGNED AS", M, 1214, { font: F.mono, size: 15, color: AMBER, spacing: "6px" });
        if (L.words) L.words.forEach((w, i) => {
          const x = M + i * cw, inner = cw - 24;
          put(ctx, w, x, 1288, { font: i === 1 ? F.it : F.s3, size: 62, min: 34, width: inner, color: i === 1 ? WARM : CREAM, glow: i === 1 ? "rgba(238,164,78,.7)" : "rgba(238,164,78,.3)" });
          if (L.en[i]) put(ctx, L.en[i], x, 1322, { font: F.mono, size: 13, min: 10, width: inner, color: SOFT, spacing: "3px" });
        });
        else put(ctx, "三个词还空着", M, 1288, { font: F.s3, size: 60, color: FAINT });

        ctx.fillStyle = AMBER; ctx.shadowColor = "rgba(238,164,78,.9)"; ctx.shadowBlur = 14;
        ctx.beginPath(); ctx.arc(M + 6, H - 82, 6, 0, Math.PI * 2); ctx.fill();
        ctx.shadowBlur = 0; ctx.shadowColor = "transparent";
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

  async function draw(D, theme, { bg } = {}) {
    const T = THEMES[theme], L = lines(D);
    // Noto 系列按字分片加载：页面上没出现过的字要先点名拉下来，canvas 才画得出
    if (document.fonts && document.fonts.load) {
      const text = `${allText(L)}EDITION FROM—TO SIGNED AS UNSIGNED Anno OBSERVATIO NUMERUS SUBSCRIPTIO DouyinDataReview DOUYINDATAREVIEW·非官方 TRACE ANNUAL VOLUME 0123456789`;
      await Promise.all(T.fonts.map((font) => document.fonts.load(font, text))).catch(() => { /* offline: system fonts */ });
    }
    const c = Object.assign(document.createElement("canvas"), { width: W, height: H });
    T.draw(c.getContext("2d"), L, bg ? await loadImage(bg) : null);
    return c;
  }

  async function save(D, theme, opts) {
    const c = await draw(D, theme, opts);
    const blob = await new Promise((resolve, reject) => c.toBlob((b) => (b ? resolve(b) : reject(new Error("toBlob returned null"))), "image/png"));
    const url = URL.createObjectURL(blob);
    const link = Object.assign(document.createElement("a"), { href: url, download: `内容年志-分享图-${D.year}.png` });
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }

  // 隐私开着：名字和歌名抹成方块，和「导出」同一套（话题按各页自己的规矩）
  function wire(button, D, { theme, privateTopics = false, bg = null }) {
    const text = button.querySelector(".se-at, .sc-l") || button;
    const label = text.textContent;
    button.hidden = false;
    button.addEventListener("click", async (event) => {
      event.stopPropagation(); // 档案馆点页面就翻页
      if (button.dataset.busy) return;
      button.dataset.busy = "1";
      text.textContent = "生成中…";
      try {
        const priv = document.body.classList.contains("privacy-on") && window.StoryExport;
        await save(priv ? window.StoryExport.scrub(D, { privateTopics }) : D, theme, { bg: typeof bg === "function" ? bg() : bg });
        text.textContent = label;
      } catch (error) {
        console.error("[StoryCard]", error);
        text.textContent = "生成失败";
        setTimeout(() => { text.textContent = label; }, 2400);
      } finally {
        delete button.dataset.busy;
      }
    });
  }

  window.StoryCard = { lines, draw, save, wire };
})();
