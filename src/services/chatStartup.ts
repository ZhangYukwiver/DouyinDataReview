export function createChatStartupRequest() {
  let pending = false;
  let deferred = false;

  return {
    request() {
      pending = true;
      deferred = false;
    },
    defer() {
      pending = true;
      deferred = true;
    },
    cancel() {
      pending = false;
      deferred = false;
    },
    take(): boolean {
      if (!pending || deferred) return false;
      pending = false;
      deferred = false;
      return true;
    },
    isPending() {
      return pending;
    },
    isReady() {
      return pending && !deferred;
    },
    retry() {
      if (pending) deferred = false;
    },
  };
}

/**
 * Tracks which in-flight chat request was started automatically. The request
 * id matters because a later record operation can replace the status poll
 * while the original chat start promise is still settling.
 */
export function createChatAutomaticRequestTracker() {
  let activeRequestIds = new Set<number>();

  return {
    mark(requestId: number) {
      activeRequestIds = new Set([requestId]);
    },
    rebind(requestId: number) {
      if (activeRequestIds.size > 0) activeRequestIds.add(requestId);
    },
    matches(requestId: number) {
      return activeRequestIds.has(requestId);
    },
    isActive() {
      return activeRequestIds.size > 0;
    },
    clear(requestId?: number) {
      if (requestId === undefined) activeRequestIds.clear();
      else activeRequestIds.delete(requestId);
    },
    takeFailure(requestId: number) {
      if (!activeRequestIds.has(requestId)) return false;
      activeRequestIds.clear();
      return true;
    },
  };
}
