import type { Db, FileStore } from "../src/ports.ts";

/** Wraps a Db and two FileStores so every call through them adds one to a shared count. */
export function counted(db: Db, drafts: FileStore, pub: FileStore) {
  let n = 0;
  const wrap = <T extends object>(target: T, methods: (keyof T)[]): T => {
    const out = {} as T;
    for (const m of methods) {
      const fn = target[m] as unknown as (...a: unknown[]) => unknown;
      (out as Record<keyof T, unknown>)[m] = (...args: unknown[]) => {
        n++;
        return fn.apply(target, args);
      };
    }
    return out;
  };
  return {
    db: wrap<Db>(db, ["all", "first", "run", "batch"]),
    drafts: wrap<FileStore>(drafts, ["put", "get", "delete"]),
    pub: wrap<FileStore>(pub, ["put", "get", "delete"]),
    calls: () => n,
  };
}
