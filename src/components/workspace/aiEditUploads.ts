// 本机文件上传队列放在模块里，不跟着 AI 剪辑页面卸载：上传中切到别的侧栏再回来，进度卡片还在；
// 页面开着时传完一个就刷新素材栏（没开着的话下次进来本来就会重读）；传失败的提示先存着，页面回来再显示。

export interface UploadTask { key: string; name: string; progress: number }
export interface UploadSnapshot { tasks: UploadTask[]; errors: string[] }

type Upload<C> = (connection: C, file: File, onProgress: (ratio: number) => void) => Promise<unknown>;

/** 页面不在时最多攒这么多条失败提示，免得一次选几百个文件全失败时提示条撑满。 */
const MAX_ERRORS = 5;

export function createUploadQueue<C>(upload: Upload<C>, describeError: (reason: unknown) => string) {
  let snapshot: UploadSnapshot = { tasks: [], errors: [] };
  let sequence = 0;
  const listeners = new Set<() => void>();
  const finishers = new Set<() => unknown>();
  const update = (change: (current: UploadSnapshot) => UploadSnapshot) => {
    snapshot = change(snapshot);
    for (const listener of listeners) listener();
  };

  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    getSnapshot: () => snapshot,
    /** 页面挂着时登记：每传完一个就调一次（刷新素材栏），等它跑完才撤掉进度卡片，免得卡片先消失、素材后出现。 */
    onUploaded(finisher: () => unknown) {
      finishers.add(finisher);
      return () => { finishers.delete(finisher); };
    },
    /** 取走还没显示的失败提示。 */
    takeErrors(): string[] {
      const { errors } = snapshot;
      if (errors.length) update((current) => ({ ...current, errors: [] }));
      return errors;
    },
    /** 一次选的几个文件按顺序传；选完立刻都列进素材栏，排着的显示 0%。 */
    async enqueue(connection: C, files: File[]) {
      const queued = files.map((file) => ({ file, key: `upload-${++sequence}` }));
      if (!queued.length) return;
      update((current) => ({ ...current, tasks: [...current.tasks, ...queued.map(({ file, key }) => ({ key, name: file.name, progress: 0 }))] }));
      for (const { file, key } of queued) {
        try {
          await upload(connection, file, (ratio) => update((current) => ({
            ...current, tasks: current.tasks.map((task) => task.key === key ? { ...task, progress: ratio } : task),
          })));
          await Promise.all([...finishers].map((finish) => Promise.resolve().then(finish).catch(() => undefined)));
        } catch (reason) {
          update((current) => ({ ...current, errors: [...current.errors, `${file.name}：${describeError(reason)}`].slice(-MAX_ERRORS) }));
        } finally {
          update((current) => ({ ...current, tasks: current.tasks.filter((task) => task.key !== key) }));
        }
      }
    },
  };
}
