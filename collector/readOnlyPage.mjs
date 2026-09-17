// Workbench tabs load metadata and media; only the local player should play.
// Install before navigation so the site's first autoplay cannot count as a view.
export async function prepareReadOnlyPage(page) {
  // Playback preparation must never persist a new platform history event.
  // Keep reads available; this route belongs only to the workbench-owned tab.
  // Playwright page.route disables HTTP caching for the entire page. Douyin's
  // large search bundles then reload for every query and exhaust the deadline.
  // Intercept only history requests through CDP so static resources stay cached.
  const network = await page.context().newCDPSession(page);
  network.on("Fetch.requestPaused", ({ requestId, request }) => {
    const write = /^https:\/\/(?:www|www-hj)\.douyin\.com\/aweme\/v1\/web\/history\/(?!read\/)/u.test(request.url);
    void network.send(write ? "Fetch.failRequest" : "Fetch.continueRequest", {
      requestId, ...(write ? { errorReason: "BlockedByClient" } : {}),
    }).catch(() => {});
  });
  await network.send("Fetch.enable", { patterns: ["www", "www-hj"].map(host => ({
    urlPattern: `https://${host}.douyin.com/aweme/v1/web/history/*`, requestStage: "Request",
  })) });
  await page.addInitScript(() => {
    const pause = (media) => {
      media.muted = true;
      media.removeAttribute("autoplay");
      media.pause();
    };
    Object.defineProperty(HTMLMediaElement.prototype, "play", {
      configurable: true,
      value() { pause(this); return Promise.resolve(); },
    });
    Object.defineProperty(HTMLMediaElement.prototype, "autoplay", {
      configurable: true,
      get() { return false; },
      set() { this.removeAttribute("autoplay"); },
    });
    document.addEventListener("play", (event) => {
      if (event.target instanceof HTMLMediaElement) pause(event.target);
    }, true);
    new MutationObserver(() => {
      document.querySelectorAll("video[autoplay],audio[autoplay]").forEach(pause);
    }).observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ["autoplay"] });
  });
}

export async function pageNeedsVerification(page) {
  const [title, body] = await Promise.all([
    page.title().catch(() => ""),
    page.locator("body").innerText({ timeout: 1500 }).catch(() => ""),
  ]);
  return /验证码|安全验证|完成验证|captcha/iu.test(`${title}\n${body}`)
    || page.frames().some((frame) => /\/(?:verifycenter|captcha)\//iu.test(frame.url()));
}
