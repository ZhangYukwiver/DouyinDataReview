// AI 剪辑看板里视频片段的缩略图：在浏览器里用一个隐藏的 <video> 按素材时间 seek，画到 canvas 再转成小 JPEG。
// 整个页面只排一条队：同一时刻只解码一个素材，同一素材的请求攒在一起按时间顺序取，避免几十个 <video> 同时加载。
// 结果按「素材 id + 素材内时间」缓存在模块里，切走再回来不用重新解码；取不到就返回 null，片段块退回纯色。

export interface FrameSession { grab(seconds: number): Promise<string>; close(): void }
export type OpenFrames = (url: string) => Promise<FrameSession>;

interface Job { key: string; url: string; timeUs: number; signal?: AbortSignal; resolve: (frame: string | null) => void }

export function createFrameQueue(open: OpenFrames, { limit = 600 }: { limit?: number } = {}) {
  const frames = new Map<string, string>();
  // 失败按地址记：采集器重启换了素材钥匙（地址变了）就再试一次
  const failed = new Set<string>();
  let queue: Job[] = [];
  let busy = false;

  const keyOf = (mediaId: string, timeUs: number) => `${mediaId}@${timeUs}`;
  const remember = (key: string, frame: string) => {
    frames.delete(key);
    frames.set(key, frame);
    if (frames.size > limit) frames.delete(frames.keys().next().value as string);
  };
  const fail = (job: Job) => {
    if (!job.signal?.aborted) failed.add(`${job.url}#${job.timeUs}`);
    job.resolve(null);
  };
  const known = (job: Job) => {
    const frame = frames.get(job.key);
    if (frame) { job.resolve(frame); return true; }
    if (failed.has(`${job.url}#${job.timeUs}`)) { job.resolve(null); return true; }
    return false;
  };
  // 取出队里同一地址的请求，按时间排好（往后 seek 比来回跳快）
  const take = (url: string) => {
    const batch = queue.filter((job) => job.url === url).sort((a, b) => a.timeUs - b.timeUs);
    queue = queue.filter((job) => job.url !== url);
    return batch;
  };

  async function run(url: string) {
    let session: FrameSession | null = null;
    try {
      for (let batch = take(url); batch.length; batch = take(url)) {
        for (const [index, job] of batch.entries()) {
          if (job.signal?.aborted || known(job)) continue;
          try {
            session ??= await open(url);
            const frame = await session.grab(job.timeUs / 1_000_000);
            remember(job.key, frame);
            job.resolve(frame);
          } catch {
            // 打不开、解不了码或画布被跨源污染：这一批剩下的也别再试了，都退回纯色
            for (const rest of batch.slice(index)) fail(rest);
            for (const rest of take(url)) fail(rest);
            return;
          }
        }
      }
    } finally {
      session?.close();
    }
  }

  async function pump() {
    if (busy) return;
    busy = true;
    try {
      while (queue.length) await run(queue[0]!.url);
    } finally {
      busy = false;
    }
  }

  return {
    /** 已经取到的那一帧（同步读，挂载时不闪）；没有就是 undefined。 */
    peek(mediaId: string, timeUs: number): string | undefined {
      return frames.get(keyOf(mediaId, timeUs));
    },
    /** 排队取一帧；signal 取消后从队里拿掉并返回 null。 */
    request(mediaId: string, url: string, timeUs: number, signal?: AbortSignal): Promise<string | null> {
      const job: Job = { key: keyOf(mediaId, timeUs), url, timeUs, signal, resolve: () => undefined };
      return new Promise<string | null>((resolve) => {
        job.resolve = resolve;
        if (known(job)) return;
        if (signal?.aborted) { resolve(null); return; }
        queue.push(job);
        signal?.addEventListener("abort", () => { queue = queue.filter((item) => item !== job); resolve(null); }, { once: true });
        // 等这一轮同步发起的请求都进队再开工：一次挂载的所有片段块能按素材归到一起
        queueMicrotask(() => void pump());
      });
    },
    /** 测试用：还在排队的请求数。 */
    pending: () => queue.length,
  };
}

const FRAME_WIDTH = 96;
const FRAME_HEIGHT = 54;

/**
 * 浏览器里的取帧器：<video crossOrigin="anonymous"> 读采集器的素材文件（采集器对本机页面回 Access-Control-Allow-Origin，
 * 画布才不会被污染），按片段块的比例居中裁成 96×54 的小图。手机竖拍带旋转信息的，浏览器解出来的画面已经转正。
 */
export function openVideoFrames(url: string, timeoutMs = 8_000): Promise<FrameSession> {
  return new Promise<FrameSession>((resolve, reject) => {
    const video = document.createElement("video");
    const canvas = document.createElement("canvas");
    canvas.width = FRAME_WIDTH;
    canvas.height = FRAME_HEIGHT;
    const release = () => { video.removeAttribute("src"); video.load(); };
    const timer = setTimeout(() => { release(); reject(new Error("load timeout")); }, timeoutMs);
    video.crossOrigin = "anonymous";
    video.muted = true;
    video.playsInline = true;
    video.preload = "auto";
    video.onerror = () => { clearTimeout(timer); release(); reject(new Error("load failed")); };
    video.onloadeddata = () => {
      clearTimeout(timer);
      video.onloadeddata = null;
      video.onerror = null;
      resolve({
        grab: (seconds) => new Promise<string>((done, fail) => {
          const length = Number.isFinite(video.duration) ? video.duration : seconds;
          const target = Math.min(Math.max(0, seconds), Math.max(0, length - 0.05));
          const draw = () => {
            try {
              const { videoWidth: width, videoHeight: height } = video;
              const context = canvas.getContext("2d");
              if (!width || !height || !context) throw new Error("no frame");
              // 像 object-fit: cover 那样居中裁
              const scale = Math.max(FRAME_WIDTH / width, FRAME_HEIGHT / height);
              const sw = FRAME_WIDTH / scale;
              const sh = FRAME_HEIGHT / scale;
              context.drawImage(video, (width - sw) / 2, (height - sh) / 2, sw, sh, 0, 0, FRAME_WIDTH, FRAME_HEIGHT);
              done(canvas.toDataURL("image/jpeg", 0.72));
            } catch (error) {
              fail(error);
            }
          };
          if (Math.abs(video.currentTime - target) < 0.01 && video.readyState >= 2) { draw(); return; }
          const seekTimer = setTimeout(() => { video.onseeked = null; video.onerror = null; fail(new Error("seek timeout")); }, timeoutMs);
          video.onerror = () => { clearTimeout(seekTimer); video.onseeked = null; fail(new Error("decode failed")); };
          video.onseeked = () => { clearTimeout(seekTimer); video.onseeked = null; video.onerror = null; draw(); };
          video.currentTime = target;
        }),
        close: release,
      });
    };
    video.src = url;
  });
}
