/**
 * 分支裁点 —— C-2 会话分支的纯判定。
 *
 * 为什么需要对账：两本账没有 id 映射（pi-ai 的 Message 没有 id，我们的消息 id 是
 * adapter 自铸的 UUID），唯一桥梁是「user/assistant 按出现顺序一一对应」——
 * 2026-09-01 对磁盘上 72 条真实会话全量实证成立（含全部 16 条带压缩的）。
 * 罕见漂移（同毫秒排序、pi 不落盘的失败尾巴）会让对不上——**宁可拒绝分支，
 * 不可切错位置**：切错意味着用户以为带着 A 之前的前文，实际带的是 B 的。
 *
 * 纯模块：不 import pi（纯判定逻辑纪律），entry 只声明用到的结构字段。
 */

/**
 * pi session 文件里一条 entry 的结构化形状。
 * 只用到 `type`（"message" 才是对话消息；compaction / model_change 等都不是）与
 * `message.role`（user / assistant / toolResult）。
 */
export interface BranchCutEntry {
  type: string;
  id: string;
  message?: { role?: unknown };
}

/**
 * 算 pi 侧的裁点 entry id。
 *
 * @param entries pi 文件里的全部条目（含 session 头，顺序即文件顺序）
 * @param roles   我们这本账前缀（含锚点）的 user/assistant 角色序列
 * @throws 两本账对不上（长度或顺序）、roles 为空、锚点不是 assistant
 */
export function planBranchCut(
  entries: readonly BranchCutEntry[],
  roles: readonly ("user" | "assistant")[],
): string {
  // pi 侧被计入对账的条目：message 条目里的 user/assistant（toolResult 不计——
  // 它在我们账上是 role:"tool" 的记录，两边各自消化，不入序列）
  const counted: { id: string; role: "user" | "assistant"; fileIndex: number }[] = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    // noUncheckedIndexedAccess：下标访问可能 undefined，跳过而非拿到再判
    if (entry === undefined || entry.type !== "message") continue;
    const role = entry.message?.role;
    if (role === "user" || role === "assistant") counted.push({ id: entry.id, role, fileIndex: i });
  }

  if (roles.at(-1) !== "assistant") {
    throw new Error(roles.length === 0 ? "No messages before the branch point" : "The branch point must be an agent reply");
  }

  // 对账只对前缀：pi 文件里还有锚点之后的后文（counted 更长是常态）。
  // pi 的消息比本地记录还少 = 账对不上；前 N 位任何一位不合也是。
  if (counted.length < roles.length) {
    throw new Error(
      `Ledger mismatch: pi has ${counted.length} messages, local records have ${roles.length} — cannot branch`,
    );
  }
  for (let i = 0; i < roles.length; i++) {
    if (counted[i]?.role !== roles[i]) {
      throw new Error("Message order mismatch between the two ledgers — cannot branch");
    }
  }
  const anchor = counted[roles.length - 1];
  if (anchor === undefined) throw new Error("No messages before the branch point");

  // 锚点条目向后连吃它的 toolResult——上下文要完整（有调用必须有结果，缺结果的
  // tool_use 会被 LLM API 拒收）。遇到别的（user / assistant / 压缩界碑 / 非消息
  // 条目）即停：那些属于「锚点之后」的世界。
  let fileIndex = anchor.fileIndex;
  while (true) {
    const next = entries[fileIndex + 1];
    // noUncheckedIndexedAccess 下索引访问可能 undefined——收进局部变量只判一次
    if (next?.type !== "message" || next.message?.role !== "toolResult") break;
    fileIndex++;
  }
  return entries[fileIndex]?.id ?? anchor.id;
}
