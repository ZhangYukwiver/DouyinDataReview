import Hls from "hls.js";

type LivePlaybackCallbacks = {
  onError: () => void;
  onAutoplayMuted: () => void;
};

/** HLS 分片先转封装给 MediaSource，避开桌面内核原生 HLS 的分片解析错误。 */
export function playLiveStream(video: HTMLVideoElement, url: string, callbacks: LivePlaybackCallbacks): () => void {
  let hls: Hls | null = null;
  let stopped = false;
  let recovered = false;

  const stop = () => {
    if (stopped) return;
    stopped = true;
    video.removeEventListener("canplay", play);
    video.removeEventListener("error", fail);
    hls?.destroy();
    hls = null;
    video.pause();
    video.removeAttribute("src");
    video.load();
  };
  const fail = () => {
    if (stopped) return;
    stop();
    callbacks.onError();
  };
  const play = () => {
    if (stopped || !video.paused) return;
    void video.play().catch((error: unknown) => {
      // 解码失败由播放器处理；只有自动播放被拦才改成静音。
      if (stopped || !(error instanceof Error) || error.name !== "NotAllowedError") return;
      video.muted = true;
      callbacks.onAutoplayMuted();
      void video.play().catch(() => {});
    });
  };

  video.addEventListener("canplay", play);
  if (Hls.isSupported()) {
    // 当前页面只允许同源脚本；转封装不额外创建 blob worker。
    hls = new Hls({ enableWorker: false, backBufferLength: 30, maxBufferLength: 20 });
    hls.on(Hls.Events.ERROR, (_event, data) => {
      if (stopped || !data.fatal) return;
      if (data.type === Hls.ErrorTypes.MEDIA_ERROR && !recovered) {
        recovered = true;
        hls?.recoverMediaError();
      } else fail();
    });
    hls.loadSource(url);
    hls.attachMedia(video);
  } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
    // Safari 等只有原生 HLS 支持的环境。
    video.addEventListener("error", fail);
    video.src = url;
    video.load();
  } else fail();

  return stop;
}
