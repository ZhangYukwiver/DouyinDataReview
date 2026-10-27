// 词条匹配：纯逻辑，没有 DOM。页面里挂在 globalThis.DYF，单测用 vm 原样跑这个文件。
// 语法沿用原来的油猴脚本：一行一条；# 开头是注释；desc:/author:/tag:/music: 限定字段；/正则/flags；末尾 @权重。
(function (root) {
  "use strict";

  const ZERO_WIDTH = /[\u00ad\u200b-\u200f\u2028-\u202f\u2060-\u206f\ufeff]/gu;
  const FIELD = /^(desc|author|tag|music|any):\s*/u;
  const WEIGHT = /@\s*(\d+(?:\.\d+)?)\s*$/u;
  // 命中总分到 1 就拿掉；权重小于 1 的词要凑够几个才算
  const THRESHOLD = 1;

  function normalize(text) {
    return String(text ?? "").normalize("NFKC").replace(ZERO_WIDTH, "").replace(/\s+/gu, " ").toLowerCase().trim();
  }

  function parseRegex(raw) {
    const end = raw.lastIndexOf("/");
    if (raw[0] !== "/" || end <= 0) return null;
    const flags = raw.slice(end + 1);
    if (!/^[gimsuy]*$/u.test(flags)) return null;
    // 去掉 g/y：带了它们 test() 会记住 lastIndex，下一条视频从半截开始匹配
    try { return new RegExp(raw.slice(1, end), flags.replace(/[gy]/gu, "")); } catch { return null; }
  }

  function compileRules(text) {
    const rules = [];
    for (const line of String(text ?? "").split(/\r?\n/u)) {
      let raw = line.trim();
      if (!raw || raw[0] === "#") continue;
      const source = raw;
      let field = "any";
      const prefix = FIELD.exec(raw);
      if (prefix) { field = prefix[1]; raw = raw.slice(prefix[0].length); }
      let weight = 1;
      const suffix = WEIGHT.exec(raw);
      if (suffix) { weight = Number(suffix[1]) || 1; raw = raw.slice(0, suffix.index).trim(); }
      const re = parseRegex(raw);
      const value = re ? null : normalize(raw);
      if (re || value) rules.push({ field, weight, re, value, source });
    }
    return rules;
  }

  // 作者带上 uid：改了昵称也能用 author:数字 拦住；话题和抖音给的作品分类都算 tag
  function fieldsOf(aweme) {
    const tags = [...(aweme?.text_extra ?? []).map((item) => item?.hashtag_name), ...(aweme?.video_tag ?? []).map((item) => item?.tag_name)];
    const fields = {
      desc: normalize(aweme?.desc),
      author: normalize(`${aweme?.author?.nickname ?? ""} ${aweme?.author?.uid ?? ""}`),
      tag: normalize(tags.filter(Boolean).join(" ")),
      music: normalize(aweme?.music?.title),
    };
    fields.any = [fields.desc, fields.author, fields.tag, fields.music].join(" ");
    return fields;
  }

  function match(rules, fields) {
    let score = 0;
    const matched = [];
    for (const rule of rules) {
      const hay = fields[rule.field] || "";
      if (hay && (rule.re ? rule.re.test(hay) : hay.includes(rule.value))) { score += rule.weight; matched.push(rule.source); }
    }
    return { score, matched };
  }

  // 推荐接口的返回里只动 aweme_list：命中的拿掉（hide=false 时只报不拿），返回命中的那几条
  function filterFeed(json, rules, hide) {
    const hits = [];
    if (!rules.length || !Array.isArray(json?.aweme_list)) return hits;
    json.aweme_list = json.aweme_list.filter((aweme) => {
      const result = match(rules, fieldsOf(aweme));
      if (result.score < THRESHOLD) return true;
      hits.push({ id: String(aweme?.aweme_id ?? ""), desc: String(aweme?.desc ?? "").slice(0, 120),
        author: String(aweme?.author?.nickname ?? "").slice(0, 40), matched: result.matched.slice(0, 5), score: result.score });
      return !hide;
    });
    return hits;
  }

  root.DYF = { normalize, compileRules, fieldsOf, match, filterFeed };
})(globalThis);
