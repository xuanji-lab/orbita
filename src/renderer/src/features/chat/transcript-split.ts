/**
 * 历史段 / 实时尾段的切分与引用复用——纯模块，不依赖 React / DOM，可被 `node --test`
 * 直接加载。
 *
 * **为什么按「最后一个 user 记录」切。** 转录的派生链（摊平 → 相邻同类合并 → 按轮折叠）
 * 只在一轮之内发生：user / 压缩界碑 / 通道标记是段边界，折叠与相邻合并都不会跨过它们
 * （`groupToolUnits` 只合相邻 toolCall，`groupTurns*` 遇到 user 就切段）。所以最后一条
 * user 记录之后是**唯一还在增长的一段**：流式期间只有它的派生会变。历史段（之前的一切）
 * 的派生结果可以按引用复用，整列重算的范围从「全部记录」缩到「尾段」。
 *
 * **为什么不能只看长度。** 回退 / 撤销 / 压缩界碑会在中间改写记录。复用前逐元素比对
 * 引用（记录对象在 hook 侧已按 entry 稳定化），任何中间插入或替换都会让前缀失效，自然
 * 退回重算——这是正确性优先的降级路径，不是错误。
 */

/** 切分结果：`history` = records[0, boundary)，`tail` = records[boundary, end) */
export interface TranscriptSplit<T> {
  /** 历史段长度（= 最后一条 user 记录的下标 + 1；没有 user 记录时为 0） */
  boundary: number;
  history: readonly T[];
  tail: readonly T[];
}

/**
 * 按最后一条 user 记录切分。没有 user 记录时整段都是尾段（历史为空）——派生口径与
 * 不切时一致：尾段从第一条记录开始，`groupTurns*` 仍按 user / 界碑切段。
 */
export function splitAtLastUser<T extends { role: string }>(records: readonly T[]): TranscriptSplit<T> {
  let boundary = 0;
  for (let i = records.length - 1; i >= 0; i -= 1) {
    if (records[i]?.role === "user") {
      boundary = i + 1;
      break;
    }
  }
  return { boundary, history: records.slice(0, boundary), tail: records.slice(boundary) };
}

/**
 * 取 `records` 的前 `length` 个元素；与 `previous`（上一次产出的同长度前缀）逐元素
 * 引用相同时直接返回 `previous`，保住下游 memo 的输入身份。
 *
 * 比较是 O(length)，相对一次派生（摊平 / 分组 / 折叠）可以忽略。`previous` 必须是
 * 之前由本函数产出的**前缀数组本身**（不是更长的记录数组）。
 */
export function stablePrefix<T>(
  previous: readonly T[] | null,
  records: readonly T[],
  length: number,
): readonly T[] {
  if (previous !== null && previous.length === length && length <= records.length) {
    let same = true;
    for (let i = 0; i < length; i += 1) {
      if (previous[i] !== records[i]) {
        same = false;
        break;
      }
    }
    if (same) return previous;
  }
  return records.slice(0, length);
}

/** 一步派生的缓存槽：输入引用不变就直接复用输出（模拟 useMemo 的 Object.is 语义） */
export interface DerivedSlot<I, O> {
  input: I;
  output: O;
}

/**
 * 输入引用不变则复用上次的输出。用于「缓存要跨渲染帧存活」的派生（React 里挂在 ref 上），
 * 也让纯模块测试能直接验证「流式期间历史段的对象身份不变」。
 */
export function deriveOnce<I, O>(
  slot: DerivedSlot<I, O> | null,
  input: I,
  compute: (input: I) => O,
): DerivedSlot<I, O> {
  if (slot !== null && Object.is(slot.input, input)) return slot;
  return { input, output: compute(input) };
}
