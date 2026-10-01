/**
 * 分支裁点 —— C-2 会话分支的纯判定。
 *
 * 为什么需要对账：两本账没有 id 映射（pi-ai 的 Message 没有 id，我们的消息 id 是
 * adapter 自铸的 UUID），唯一桥梁是「user/assistant 按出现顺序一一对应」。
 *
 * **两本账对「空 error 回答」的处理必须一致**：pi 在 abort（工具执行中 / 两次模型
 * 调用之间被打断）与 auto_retry 的失败尝试上都会产出 `stopReason:"error"` 且
 * content 为空的 assistant，并经 message_end 无条件落进自己的本子；我们刻意不落盘
 * （空条目没有任何上下文价值，见 store.ts 的 isEmptyErrorAssistant）。所以这里对 pi
 * 条目施加同一个排除谓词（isEmptyErrorAssistantEntry），否则被打断过的会话从漂移点
 * 起就再也分支不了。
 *
 * **对账输入必须是当前叶子路径（getBranch()），不是文件序（getEntries()）**：
 * 会话回退会在 pi 本子里留度枝（branch 之后再追加，旧枝的条目还躺在文件中段），
 * 文件序会把度枝也数进来，从第一次回退起对账必然错位。getBranch() 只走
 * root → 当前叶子这一条路，度枝天然不在其中（分支功能同改，2026-11 会话回退）。
 *
 * 其余漂移（如同毫秒排序）仍然拒绝分支——**宁可拒绝分支，不可切错位置**：
 * 切错意味着用户以为带着 A 之前的前文，实际带的是 B 的。
 *
 * 纯模块：不 import pi（纯判定逻辑纪律），entry 只声明用到的结构字段。
 */

/**
 * pi session 文件里一条 entry 的结构化形状。
 * 只用到 `type`（"message" 才是对话消息；compaction / model_change 等都不是）、
 * `message.role`（user / assistant / toolResult），以及判定空 error 回答所需的
 * `message.stopReason` 与 `message.content`。
 */
export interface BranchCutEntry {
  type: string;
  id: string;
  message?: { role?: unknown; stopReason?: unknown; content?: unknown };
}

/**
 * 「空 error 回答」：pi 本子里 `stopReason:"error"` 且 content 为空的 assistant 条目。
 * abort 与 auto_retry 的失败尝试都会产生它，pi 收、我们不收，所以对账时两侧同样排除。
 * 带内容的 error 回答（真失败但说了话）不在此列——那条我们是落盘的，必须计入。
 */
export function isEmptyErrorAssistantEntry(entry: BranchCutEntry): boolean {
  if (entry.type !== "message") return false;
  const message = entry.message;
  if (message?.role !== "assistant" || message.stopReason !== "error") return false;
  return Array.isArray(message.content) && message.content.length === 0;
}

/**
 * 算 pi 侧的裁点 entry id（会话回退与分支共用）。
 *
 * @param entries pi 本子当前叶子路径上的全部条目（getBranch()，root → leaf；含 session 头）
 * @param roles   生效列表里裁点之前的 user/assistant 角色序列；**空序列合法**（回退到
 *                首条消息之前，返回 null，调用方走 resetLeaf）
 * @throws 两本账对不上（长度或顺序）
 * @returns 裁点 entry id（含它连带的 toolResult）；null = 裁到最前（resetLeaf）
 */
export function planCutEntry(
  entries: readonly BranchCutEntry[],
  roles: readonly ("user" | "assistant")[],
): string | null {
  // pi 侧被计入对账的条目：message 条目里的 user/assistant（toolResult 不计——
  // 它在我们账上是 role:"tool" 的记录，两边各自消化，不入序列）
  const counted: { id: string; role: "user" | "assistant"; fileIndex: number }[] = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    // noUncheckedIndexedAccess：下标访问可能 undefined，跳过而非拿到再判
    if (entry === undefined || entry.type !== "message") continue;
    // 空 error 回答两侧同样排除（我们不落盘，这里也不计）
    if (isEmptyErrorAssistantEntry(entry)) continue;
    const role = entry.message?.role;
    if (role === "user" || role === "assistant") counted.push({ id: entry.id, role, fileIndex: i });
  }

  // 空序列 = 裁到最前：整本都不要了
  if (roles.length === 0) return null;

  // 对账只对前缀：pi 文件里还有裁点之后的后文（counted 更长是常态）。
  // pi 的消息比本地记录还少 = 账对不上；前 N 位任何一位不合也是。
  if (counted.length < roles.length) {
    throw new Error(
      `Ledger mismatch: pi has ${counted.length} messages, local records have ${roles.length} — cannot cut`,
    );
  }
  for (let i = 0; i < roles.length; i++) {
    if (counted[i]?.role !== roles[i]) {
      throw new Error("Message order mismatch between the two ledgers — cannot cut");
    }
  }
  const anchor = counted[roles.length - 1];
  if (anchor === undefined) throw new Error("No messages before the cut point");

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

/**
 * 算 pi 侧的裁点 entry id（分支专用：在 planCutEntry 上加「锚点必须是 assistant 回答」
 * 的门槛——界面只在轮末 agent 回答下给分支入口，这里是信任边界的再校验）。
 */
export function planBranchCut(
  entries: readonly BranchCutEntry[],
  roles: readonly ("user" | "assistant")[],
): string {
  if (roles.length === 0) {
    throw new Error("No messages before the branch point");
  }
  if (roles.at(-1) !== "assistant") {
    throw new Error("The branch point must be an agent reply");
  }
  const cut = planCutEntry(entries, roles);
  if (cut === null) throw new Error("No messages before the branch point");
  return cut;
}
