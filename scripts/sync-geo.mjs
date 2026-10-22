// Shared public facts -> static HTML, JSON-LD, llms.txt and sitemap.
// No network, account data or runtime application configuration is read here.
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const check = process.argv.includes("--check");
const content = JSON.parse(await readFile(path.join(root, "docs/geo-content.json"), "utf8"));
const { name, siteUrl, repository, author, summary, pages, facts, features, faq } = content;
const absolute = (url) => new URL(url, siteUrl).href;
const escape = (value) => String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
const json = (value) => JSON.stringify(value, null, 2).replace(/</g, "\\u003c");
const releaseUrl = `${repository}/releases/latest`;
const licenseUrl = `${repository}/blob/main/LICENSE`;
const softwareId = `${siteUrl}#software`;
const person = { "@type": "Person", name: author, url: `https://github.com/${author}` };

// Reject ambiguous URLs/IDs and accidental invalid dates before writing anything.
if (!siteUrl.startsWith("https://") || !siteUrl.endsWith("/")) throw new Error("siteUrl must be an absolute HTTPS directory URL");
if (new Set(faq.map(({ id }) => id)).size !== faq.length) throw new Error("FAQ IDs must be unique");
for (const item of faq) {
  if (!/^[a-z][a-z0-9-]*$/.test(item.id) || !item.question?.trim() || !item.answer?.trim()) throw new Error("Invalid FAQ entry");
}
for (const page of pages) {
  if (!/^[a-z-]+\.html$/.test(page.path) || !/^\d{4}-\d{2}-\d{2}$/.test(page.modified) || !Number.isFinite(Date.parse(page.modified))) throw new Error("Invalid public page");
  if (!absolute(page.url).startsWith(siteUrl)) throw new Error("Page URL must stay within the project site");
}

function metadata(page) {
  const url = absolute(page.url);
  const isHome = page.path === "index.html";
  const webPage = {
    "@type": isHome ? "WebPage" : "TechArticle",
    "@id": `${url}#page`,
    url,
    name: page.title,
    ...(isHome ? {} : { headline: page.title, author: person }),
    description: page.description,
    inLanguage: "zh-CN",
    dateModified: page.modified,
    isPartOf: { "@id": `${siteUrl}#website` },
    about: { "@id": softwareId }
  };
  const graph = isHome ? [
    { "@type": "WebSite", "@id": `${siteUrl}#website`, name, url: siteUrl, inLanguage: "zh-CN", publisher: person },
    webPage,
    {
      "@type": "SoftwareApplication", "@id": softwareId, name, description: summary,
      url: siteUrl, downloadUrl: releaseUrl, sameAs: repository, author: person,
      applicationCategory: "UtilitiesApplication", operatingSystem: "Windows 10 / 11 x64; macOS Apple Silicon",
      inLanguage: "zh-CN", isAccessibleForFree: true, license: licenseUrl,
      image: absolute("icon.png"), screenshot: absolute("screenshots/dashboard-trace.jpg"),
      featureList: features, offers: { "@type": "Offer", price: "0", priceCurrency: "CNY", url: releaseUrl }
    },
    {
      "@type": "SoftwareSourceCode", "@id": `${siteUrl}#source`, name,
      codeRepository: repository, license: licenseUrl,
      programmingLanguage: ["TypeScript", "JavaScript"], targetProduct: { "@id": softwareId }
    },
    {
      "@type": "FAQPage", "@id": `${siteUrl}#faq`, url: `${siteUrl}#faq`, inLanguage: "zh-CN",
      isPartOf: { "@id": `${url}#page` },
      mainEntity: faq.map(({ id, question, answer }) => ({
        "@type": "Question", "@id": `${siteUrl}#${id}`, name: question,
        acceptedAnswer: { "@type": "Answer", text: answer }
      }))
    }
  ] : [webPage, {
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: `${name} 下载`, item: siteUrl },
      { "@type": "ListItem", position: 2, name: "使用指南", item: url }
    ]
  }];
  return [
    `<title>${escape(page.title)}</title>`,
    `<meta name="description" content="${escape(page.description)}">`,
    `<meta name="robots" content="index, follow, max-image-preview:large">`,
    `<link rel="canonical" href="${escape(url)}">`,
    `<link rel="alternate" type="text/plain" href="${escape(absolute("llms.txt"))}" title="项目事实与文档索引">`,
    `<meta property="og:type" content="${isHome ? "website" : "article"}">`,
    `<meta property="og:locale" content="zh_CN">`,
    `<meta property="og:site_name" content="${escape(name)}">`,
    ...["title", "description", "url", "image"].map((key) => `<meta property="og:${key}" content="${escape(({ title: page.title, description: page.description, url, image: absolute("screenshots/dashboard-trace.jpg") })[key])}">`),
    `<meta property="og:image:alt" content="DouyinDataReview 持续报告界面，使用合成示例数据">`,
    `<meta name="twitter:card" content="summary_large_image">`,
    `<meta name="twitter:title" content="${escape(page.title)}">`,
    `<meta name="twitter:description" content="${escape(page.description)}">`,
    `<meta name="twitter:image" content="${escape(absolute("screenshots/dashboard-trace.jpg"))}">`,
    `<script type="application/ld+json">\n${json({ "@context": "https://schema.org", "@graph": graph })}\n</script>`
  ].join("\n");
}

function replaceBlock(html, key, value) {
  const start = `<!-- geo:${key}:start -->`;
  const end = `<!-- geo:${key}:end -->`;
  const before = html.indexOf(start);
  const after = html.indexOf(end);
  if (before === -1 || after < before || html.indexOf(start, before + start.length) !== -1 || html.indexOf(end, after + end.length) !== -1) throw new Error(`Missing or duplicate geo:${key} markers`);
  return `${html.slice(0, before + start.length)}\n${value}\n${html.slice(after)}`;
}

const outputs = new Map();
for (const page of pages) {
  const file = `docs/${page.path}`;
  let html = await readFile(path.join(root, file), "utf8");
  html = replaceBlock(html, "meta", metadata(page));
  if (page.path === "index.html") {
    html = replaceBlock(html, "facts", `<p>${escape(summary)}</p>\n<dl class="facts">\n${facts.map(({ label, value }) => `  <div><dt>${escape(label)}</dt><dd>${escape(value)}</dd></div>`).join("\n")}\n</dl>`);
    html = replaceBlock(html, "faq", faq.map(({ id, question, answer }) => `<h3 id="${id}">${escape(question)}</h3>\n<p>${escape(answer)}</p>`).join("\n"));
  }
  outputs.set(file, html);
}

const llms = `# ${name}\n\n> ${summary}\n\n项目文档核对日期：${pages[0].modified}。具体版本与安装包以 Releases 为准。\n\n## 项目与文档\n\n- [下载与项目介绍](${siteUrl}): 平台、功能、安装与常见问题。\n- [数据导出与年度报告指南](${absolute("guide.html")}): 导出步骤、官方档案导入、覆盖范围、AI 数据流与源码依据。\n- [GitHub 仓库与 README](${repository}): 实现方式、功能边界和源码运行。\n- [最新发布](${releaseUrl}): 已发布版本和安装包。\n- [问题反馈](${repository}/issues): Bug 与功能建议。\n- [MIT 许可](${licenseUrl}): 源码使用许可。\n\n## 项目事实\n\n${facts.map(({ label, value }) => `- ${label}：${value}`).join("\n")}\n\n## 功能\n\n${features.map((feature) => `- ${feature}`).join("\n")}\n\n## 常见问题与边界\n\n${faq.map(({ question, answer }) => `### ${question}\n\n${answer}`).join("\n\n")}\n`;
outputs.set("llms.txt", llms);
outputs.set("docs/llms.txt", llms);
outputs.set("docs/sitemap.xml", `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${pages.map((page) => `  <url><loc>${escape(absolute(page.url))}</loc><lastmod>${page.modified}</lastmod></url>`).join("\n")}\n</urlset>\n`);

const stale = [];
for (const [file, output] of outputs) {
  const previous = await readFile(path.join(root, file), "utf8").catch((error) => {
    if (error.code !== "ENOENT") throw error;
    return "";
  });
  if (previous.replace(/\r\n/g, "\n") === output.replace(/\r\n/g, "\n")) continue;
  if (check) stale.push(file);
  else await writeFile(path.join(root, file), output, "utf8");
}
if (stale.length) {
  console.error(`GEO 文件未同步：${stale.join(", ")}。请运行 npm run sync:geo`);
  process.exitCode = 1;
} else {
  console.log(`${check ? "checked" : "synced"} ${outputs.size} GEO files`);
}
