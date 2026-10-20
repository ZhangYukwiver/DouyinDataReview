import { describe, expect, it } from "vitest";

import { createUploadQueue } from "./aiEditUploads";

const file = (name: string) => ({ name, size: 1 }) as File;

/** 手动控制每个文件什么时候传完 / 传失败、报多少进度。 */
function controlledUpload() {
  const pending: Array<{ name: string; progress: (ratio: number) => void; resolve: () => void; reject: (reason: unknown) => void }> = [];
  const upload = (_connection: string, target: File, onProgress: (ratio: number) => void) =>
    new Promise<void>((resolve, reject) => { pending.push({ name: target.name, progress: onProgress, resolve, reject }); });
  const job = (index: number) => {
    const item = pending[index];
    if (!item) throw new Error(`第 ${index + 1} 个文件还没开始传`);
    return item;
  };
  return { pending, upload, job };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const describeError = (reason: unknown) => (reason instanceof Error ? reason.message : "没传上去");

describe("AI 剪辑本机文件上传队列", () => {
  it("页面卸载（退订）再回来，进度还在；回来后登记的刷新在传完时被调用", async () => {
    const { pending, upload, job } = controlledUpload();
    const queue = createUploadQueue(upload, describeError);
    let renders = 0;
    const unsubscribe = queue.subscribe(() => { renders += 1; });
    const done = queue.enqueue("conn", [file("a.mp4"), file("b.mov")]);
    expect(queue.getSnapshot().tasks.map((task) => [task.name, task.progress])).toEqual([["a.mp4", 0], ["b.mov", 0]]);
    await tick();
    expect(pending.map((item) => item.name)).toEqual(["a.mp4"]); // 按顺序传，第二个还没开始
    job(0).progress(0.29);
    expect(renders).toBeGreaterThan(0);

    // 切到别的侧栏：页面退订，上传照常进行
    unsubscribe();
    job(0).progress(0.6);
    expect(queue.getSnapshot().tasks[0]).toMatchObject({ name: "a.mp4", progress: 0.6 });

    // 切回来：重新订阅能直接读到进度，并登记刷新素材栏
    const refreshed: string[] = [];
    const stopRefresh = queue.onUploaded(() => { refreshed.push(queue.getSnapshot().tasks[0]?.name ?? "none"); });
    job(0).resolve();
    await tick();
    // 刷新时卡片还在（等刷新完才撤），然后第二个开始传
    expect(refreshed).toEqual(["a.mp4"]);
    expect(queue.getSnapshot().tasks.map((task) => task.name)).toEqual(["b.mov"]);
    expect(pending.map((item) => item.name)).toEqual(["a.mp4", "b.mov"]);

    stopRefresh();
    job(1).resolve();
    await done;
    expect(refreshed).toEqual(["a.mp4"]); // 退订后不再调
    expect(queue.getSnapshot()).toEqual({ tasks: [], errors: [] });
  });

  it("页面不在时传失败的提示先存着，回来取走一次就清空；刷新出错不算上传失败", async () => {
    const { upload, job } = controlledUpload();
    const queue = createUploadQueue(upload, describeError);
    queue.onUploaded(() => { throw new Error("素材库没读到"); });
    const done = queue.enqueue("conn", [file("ok.mp4"), file("bad.mp4")]);
    await tick();
    job(0).resolve();
    await tick();
    job(1).reject(new Error("文件超过 4GB，放不进素材库。"));
    await done;
    expect(queue.getSnapshot().tasks).toEqual([]);
    expect(queue.takeErrors()).toEqual(["bad.mp4：文件超过 4GB，放不进素材库。"]);
    expect(queue.takeErrors()).toEqual([]);
  });

  it("失败提示最多攒 5 条", async () => {
    const queue = createUploadQueue(async () => { throw new Error("断了"); }, describeError);
    await queue.enqueue("conn", Array.from({ length: 8 }, (_, index) => file(`${index}.mp4`)));
    expect(queue.getSnapshot().errors).toEqual(["3.mp4：断了", "4.mp4：断了", "5.mp4：断了", "6.mp4：断了", "7.mp4：断了"]);
  });

  it("两次选文件各自排队，进度只改自己那张卡片", async () => {
    const { upload, job } = controlledUpload();
    const queue = createUploadQueue(upload, describeError);
    const first = queue.enqueue("conn", [file("same.mp4")]);
    const second = queue.enqueue("conn", [file("same.mp4")]);
    await tick();
    job(1).progress(0.5);
    expect(queue.getSnapshot().tasks.map((task) => task.progress)).toEqual([0, 0.5]);
    job(0).resolve();
    job(1).resolve();
    await Promise.all([first, second]);
    expect(queue.getSnapshot().tasks).toEqual([]);
  });
});
