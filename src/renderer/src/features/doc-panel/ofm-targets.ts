/**
 * 文档里的 `[[双链]]` / `![[图]]` / `![](相对路径)` 在渲染端怎么找到真文件：
 * 一个文档一个解析器，同一拍里发起的查询合并成**一次** IPC（`doc:ofm-resolve`），结果按目标缓存。
 * 文本变了（agent 刚改过、可能新建了图）就 `invalidate()`，下一次查询重新问主进程。
 *
 * 纯模块：IPC 以函数注入，`node --test` 直接可测。
 */
import type { OfmResolved, OfmTargetKind } from "../../../../shared/doc.ts";

export type FetchTargets = (items: { target: string; kind: OfmTargetKind }[]) => Promise<OfmResolved[]>;

export interface TargetResolver {
  resolve(target: string, kind: OfmTargetKind): Promise<OfmResolved>;
  /** 丢掉缓存（文档文本变了 / 工作区文件可能变了） */
  invalidate(): void;
}

const keyOf = (target: string, kind: OfmTargetKind): string => `${kind}\u0000${target}`;

export function createTargetResolver(fetchTargets: FetchTargets): TargetResolver {
  let cache = new Map<string, Promise<OfmResolved>>();
  let queue: { target: string; kind: OfmTargetKind; settle: (value: OfmResolved) => void }[] = [];
  let scheduled = false;
  // 世代号：invalidate 之后，旧一批的回执不再写进（新的）缓存
  let generation = 0;

  const flush = (): void => {
    scheduled = false;
    const batch = queue;
    queue = [];
    const mine = generation;
    fetchTargets(batch.map(({ target, kind }) => ({ target, kind }))).then(
      (results) => {
        batch.forEach((item, i) => item.settle(results[i] ?? null));
      },
      () => {
        // 解析失败（文档被移走 / IPC 出错）：当作找不到，阅读视图仍显示文字；且不缓存这次失败
        if (mine === generation) for (const item of batch) cache.delete(keyOf(item.target, item.kind));
        batch.forEach((item) => item.settle(null));
      },
    );
  };

  return {
    resolve(target, kind) {
      const key = keyOf(target, kind);
      const hit = cache.get(key);
      if (hit !== undefined) return hit;
      const promise = new Promise<OfmResolved>((settle) => {
        queue.push({ target, kind, settle });
        if (!scheduled) {
          scheduled = true;
          queueMicrotask(flush);
        }
      });
      cache.set(key, promise);
      return promise;
    },
    invalidate() {
      generation += 1;
      cache = new Map();
    },
  };
}
