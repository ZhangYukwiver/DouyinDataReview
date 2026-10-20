import { describe, expect, it } from "vitest";

import { createFrameQueue, type FrameSession } from "./aiEditFrames";

const S = 1_000_000;

/** 假取帧器：记下打开、取帧、关闭的顺序，可以让某个地址打不开或某一刻取不出来。 */
function fakeOpener({ broken = [] as string[], badSeconds = [] as number[] } = {}) {
  const log: string[] = [];
  let open = 0;
  let maxOpen = 0;
  const opener = async (url: string): Promise<FrameSession> => {
    await Promise.resolve();
    if (broken.includes(url)) { log.push(`fail ${url}`); throw new Error("load failed"); }
    open += 1;
    maxOpen = Math.max(maxOpen, open);
    log.push(`open ${url}`);
    return {
      grab: async (seconds) => {
        await Promise.resolve();
        log.push(`grab ${url} ${seconds}`);
        if (badSeconds.includes(seconds)) throw new Error("seek timeout");
        return `data:${url}@${seconds}`;
      },
      close: () => { open -= 1; log.push(`close ${url}`); },
    };
  };
  return { opener, log, maxOpen: () => maxOpen };
}

describe("缩略图取帧队列", () => {
  it("同一时刻只解码一个素材，同一素材的请求攒在一起按时间顺序取", async () => {
    const fake = fakeOpener();
    const queue = createFrameQueue(fake.opener);
    const results = await Promise.all([
      queue.request("a", "u/a", 2 * S),
      queue.request("b", "u/b", 0),
      queue.request("a", "u/a", 0),
      queue.request("a", "u/a", 1 * S),
    ]);
    expect(results).toEqual(["data:u/a@2", "data:u/b@0", "data:u/a@0", "data:u/a@1"]);
    expect(fake.maxOpen()).toBe(1);
    expect(fake.log).toEqual(["open u/a", "grab u/a 0", "grab u/a 1", "grab u/a 2", "close u/a", "open u/b", "grab u/b 0", "close u/b"]);
  });

  it("按素材 id + 素材内时间缓存，再要同一帧不再解码", async () => {
    const fake = fakeOpener();
    const queue = createFrameQueue(fake.opener);
    expect(queue.peek("a", 0)).toBeUndefined();
    await queue.request("a", "u/a?key=1", 0);
    // 采集器重启后钥匙变了、地址不同，同一素材同一时刻照样命中
    expect(await queue.request("a", "u/a?key=2", 0)).toBe("data:u/a?key=1@0");
    expect(queue.peek("a", 0)).toBe("data:u/a?key=1@0");
    expect(fake.log.filter((line) => line.startsWith("open"))).toHaveLength(1);
  });

  it("取消的请求从队里拿掉，不再解码", async () => {
    const fake = fakeOpener();
    const queue = createFrameQueue(fake.opener);
    const controller = new AbortController();
    const first = queue.request("a", "u/a", 0);
    const dropped = [queue.request("b", "u/b", 0, controller.signal), queue.request("b", "u/b", S, controller.signal)];
    controller.abort();
    expect(queue.pending()).toBe(1);
    expect(await Promise.all(dropped)).toEqual([null, null]);
    expect(await first).toBe("data:u/a@0");
    expect(fake.log.some((line) => line.includes("u/b"))).toBe(false);
    // 已经取消的信号再来请求直接返回
    expect(await queue.request("c", "u/c", 0, controller.signal)).toBeNull();
  });

  it("打不开的素材退回纯色，不影响别的素材；换了地址再试一次", async () => {
    const fake = fakeOpener({ broken: ["u/a?key=1"] });
    const queue = createFrameQueue(fake.opener);
    const results = await Promise.all([queue.request("a", "u/a?key=1", 0), queue.request("a", "u/a?key=1", S), queue.request("b", "u/b", 0)]);
    expect(results).toEqual([null, null, "data:u/b@0"]);
    expect(await queue.request("a", "u/a?key=1", 0)).toBeNull();
    expect(fake.log.filter((line) => line === "fail u/a?key=1")).toHaveLength(1);
    expect(await queue.request("a", "u/a?key=2", 0)).toBe("data:u/a?key=2@0");
  });

  it("某一帧取不出来时这一批剩下的也不再试", async () => {
    const fake = fakeOpener({ badSeconds: [1] });
    const queue = createFrameQueue(fake.opener);
    const results = await Promise.all([0, 1, 2].map((second) => queue.request("a", "u/a", second * S)));
    expect(results).toEqual(["data:u/a@0", null, null]);
    expect(fake.log).toEqual(["open u/a", "grab u/a 0", "grab u/a 1", "close u/a"]);
  });

  it("缓存有上限，旧的先丢", async () => {
    const queue = createFrameQueue(fakeOpener().opener, { limit: 2 });
    for (const second of [0, 1, 2]) await queue.request("a", "u/a", second * S);
    expect(queue.peek("a", 0)).toBeUndefined();
    expect(queue.peek("a", 2 * S)).toBe("data:u/a@2");
  });
});
