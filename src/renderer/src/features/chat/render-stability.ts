/**
 * 流式期间的引用稳定（纯函数）。
 *
 * 流式输出时 transcript 每帧换一个新数组，但变的只有正在增长的末条：pi 的归约器
 * （applyTranscriptProgress）只给被更新的那条换新对象，其余条目跨帧是同一个引用。
 * 凡是从 transcript 派生、又被 memo 组件或 Context 消费的值，都要在「内容没变」时
 * 交回上一帧的同一个对象——否则 memo 每帧被打穿，整条对话跟着末条一起重渲染。
 */

/**
 * 只有末条换了引用（长度相同、前面每条都是同一对象）时交回上一份，否则交回新的。
 * 用在「只关心已落定条目」的派生上：例如引用找出处——引用不可能指向流式中的那条
 * （quoteFromSelection 拒绝流式消息），末条逐字增长不改变任何结果。
 */
export function keepUnlessSettledChanged<T>(prev: readonly T[], next: readonly T[]): readonly T[] {
  if (prev === next) return prev;
  if (prev.length !== next.length || next.length === 0) return next;
  for (let i = 0; i < next.length - 1; i += 1) {
    if (prev[i] !== next[i]) return next;
  }
  return prev;
}

/** 两个 Map 的键与值（按引用）完全相同 */
export function sameMap<K, V>(a: ReadonlyMap<K, V>, b: ReadonlyMap<K, V>): boolean {
  if (a === b) return true;
  if (a.size !== b.size) return false;
  for (const [key, value] of a) {
    if (!b.has(key) || b.get(key) !== value) return false;
  }
  return true;
}

/** 两个 Set 的成员完全相同 */
export function sameSet<T>(a: ReadonlySet<T>, b: ReadonlySet<T>): boolean {
  if (a === b) return true;
  if (a.size !== b.size) return false;
  for (const value of a) if (!b.has(value)) return false;
  return true;
}

/**
 * 结构共享：next 里与 prev 结构相同的部分换回 prev 的对象（同 react-query 的
 * replaceEqualDeep）。只走数组与普通对象；其余值（字符串、数字、Map、类实例……）按 ===
 * 比。**带 role 字段的对象（transcript 条目 / 会话记录）也按 === 比、不往里走**：单元里的
 * item / record 必须始终是当前 transcript 里的那个对象（下游有按引用对账的地方），
 * 换回上一帧的「内容相同的旧对象」会让两边对不上。整体相同就交回 prev 本身。
 *
 * 用在渲染单元列表上：flattenRenderUnits / groupTurns 每帧新建全部单元，但已落定的
 * 那些单元里装的是同一批 transcript 条目与同样的字符串——共享回上一帧的对象后，
 * 行组件的 memo 浅比较就能命中，只有末尾在长的那几行重渲染。
 */
export function shareStructure<T>(prev: T, next: T): T {
  return share(prev, next, 0) as T;
}

// 单元嵌套不深（轮 → 章节 → 步骤 → 单元 → 条目）；条目本身按引用比，不往里走
const MAX_DEPTH = 8;

function share(prev: unknown, next: unknown, depth: number): unknown {
  if (prev === next) return prev;
  if (depth > MAX_DEPTH) return next;
  if (Array.isArray(prev) && Array.isArray(next)) {
    let same = prev.length === next.length;
    let fresh = true;
    const out = next.map((value, index) => {
      const shared = index < prev.length ? share(prev[index], value, depth + 1) : value;
      if (shared !== prev[index]) same = false;
      if (shared !== value) fresh = false;
      return shared;
    });
    // 一处都没共享上就交回 next 本身（不多造一份拷贝）
    return same ? prev : fresh ? next : out;
  }
  if (isPlainObject(prev) && isPlainObject(next) && !("role" in next)) {
    const prevKeys = Object.keys(prev);
    const nextKeys = Object.keys(next);
    let same = prevKeys.length === nextKeys.length;
    let fresh = true;
    const out: Record<string, unknown> = {};
    for (const key of nextKeys) {
      const had = Object.prototype.hasOwnProperty.call(prev, key);
      const shared = had ? share(prev[key], next[key], depth + 1) : next[key];
      if (!had || shared !== prev[key]) same = false;
      if (shared !== next[key]) fresh = false;
      out[key] = shared;
    }
    return same ? prev : fresh ? next : out;
  }
  return next;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
