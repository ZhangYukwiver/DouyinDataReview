import { describe, expect, it } from "vitest";

import { createChatAutomaticRequestTracker, createChatStartupRequest } from "./chatStartup";

describe("chat startup request", () => {
  it("starts at most once for each connection and can be armed again after reconnect", () => {
    const startup = createChatStartupRequest();

    expect(startup.take()).toBe(false);
    startup.request();
    expect(startup.take()).toBe(true);
    expect(startup.take()).toBe(false);

    startup.request();
    expect(startup.take()).toBe(true);
  });

  it("can be re-armed for a switched account after an earlier attempt", () => {
    const startup = createChatStartupRequest();
    startup.request();
    expect(startup.take()).toBe(true);

    startup.request();
    expect(startup.take()).toBe(true);
  });

  it("cancels a pending automatic start when the user pauses reception", () => {
    const startup = createChatStartupRequest();
    startup.request();
    startup.cancel();

    expect(startup.isPending()).toBe(false);
    expect(startup.take()).toBe(false);
  });

  it("keeps a failed startup pending without retrying until a later operation completes", () => {
    const startup = createChatStartupRequest();
    startup.request();
    startup.defer();

    expect(startup.isPending()).toBe(true);
    expect(startup.isReady()).toBe(false);
    expect(startup.take()).toBe(false);

    startup.retry();
    expect(startup.isReady()).toBe(true);
    expect(startup.take()).toBe(true);
  });

  it("attributes an asynchronous failure only to the automatic request that is still active", () => {
    const tracker = createChatAutomaticRequestTracker();

    tracker.mark(12);
    expect(tracker.matches(11)).toBe(false);
    expect(tracker.takeFailure(11)).toBe(false);
    expect(tracker.matches(12)).toBe(true);
    expect(tracker.takeFailure(12)).toBe(true);
    expect(tracker.matches(12)).toBe(false);

    tracker.mark(13);
    tracker.rebind(14);
    tracker.clear(12);
    expect(tracker.matches(13)).toBe(true);
    expect(tracker.matches(14)).toBe(true);
    tracker.clear();
    expect(tracker.matches(13)).toBe(false);
    expect(tracker.matches(14)).toBe(false);
  });

  it("binds a replacement status poll before an asynchronous chat failure arrives", () => {
    const tracker = createChatAutomaticRequestTracker();

    tracker.mark(31);
    tracker.rebind(32);

    expect(tracker.takeFailure(32)).toBe(true);
    expect(tracker.isActive()).toBe(false);
  });

  it("keeps an acknowledged automatic start pending when polling later reports chat error", () => {
    const startup = createChatStartupRequest();
    const tracker = createChatAutomaticRequestTracker();

    startup.request();
    expect(startup.take()).toBe(true);
    tracker.mark(21);

    const status = { state: "collecting", chat: { state: "error" } };
    if (tracker.matches(21) && status.chat.state === "error") {
      startup.defer();
      tracker.takeFailure(21);
    }

    expect(startup.isPending()).toBe(true);
    expect(startup.isReady()).toBe(false);
    startup.retry();
    expect(startup.take()).toBe(true);
  });
});
