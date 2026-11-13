/**
 * pi 本子的原地编辑 —— 会话回退与单轮撤销在 agent 进程里的一刀。
 *
 * 为什么是独立模块：runtime.ts 被 parentPort 守卫钉死在 utility 进程里，
 * `node --test` 加载即退出（turn-cycle.ts 同款先例）；这一刀的行为
 * （branch / resetLeaf / appendCustom* 与 pi 的 flushed 落盘语义）恰恰最需要
 * 直接测——尤其是「本子里还没有 assistant 时 _persist 不落盘」的首条消息边界。
 *
 * 两个操作共用一条骨架：开一个一次性 SessionManager（绝碰活 manager——
 * createBranchedSession 会把实例原地换绑到新文件上），在**当前叶子路径**
 * （getBranch，文件序在回退后会含废枝，不能用）上对账，然后：
 *
 *   revert：planCutEntry 算裁点 → branch(cut)（或 roles 为空时 resetLeaf）→
 *           appendCustomEntry("orbita-revert")。custom 条目不进上下文，唯一的
 *           作用是把新叶子**持久化**——branch 只改内存，没有这条追加，下一次
 *           SessionManager.open 仍会把叶子读到文件末尾（废枝），回退就丢了。
 *   undo：  在当前叶子追加 appendCustomMessageEntry("orbita-undo", notice)——
 *           custom_message **进上下文**（buildSessionContext 会把它当 user 消息），
 *           模型由此知道用户撤销了那轮文件改动。
 */
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { planCutEntry } from "./branch-cut.ts";

/** pi 侧回退：裁到 roles 前缀之后，追加 orbita-revert 界碑把新叶子落盘。 */
export function revertPiBook(
  manager: SessionManager,
  roles: readonly ("user" | "assistant")[],
  details: { targetMessageId: string },
): void {
  if (manager.getLeafId() === null && roles.length > 0) {
    // 空本子对不出非空前缀：本子还没写过任何东西（典型：首轮失败、pi 文件从未
    // 落盘），直接 resetLeaf——整本为空，回退语义天然成立
    throw new Error("pi book is empty — nothing to revert");
  }
  const cut = planCutEntry(manager.getBranch(), roles);
  if (cut === null) manager.resetLeaf();
  else manager.branch(cut);
  manager.appendCustomEntry("orbita-revert", details);
}

/** pi 侧单轮撤销：在当前叶子追加一条告知模型的 custom_message（进上下文）。 */
export function undoPiBook(manager: SessionManager, notice: string): void {
  manager.appendCustomMessageEntry("orbita-undo", notice, false);
}

/**
 * pi 侧迁移通知：会话换了工作目录，在当前叶子追加一条进上下文的 custom_message——
 * 历史里的相对路径是相对旧目录说的，模型得知道。与 undo 同一个机制，customType 分开
 * 便于排障时从本子里认出是哪一种。
 */
export function movePiBook(manager: SessionManager, notice: string): void {
  manager.appendCustomMessageEntry("orbita-move", notice, false);
}

/**
 * 回退后 pi 本子给下一轮的上下文里，被撤的消息必须已经不在——测试与主进程
 * 自检共用的断言（buildSessionContext 是 pi 自己的解析，比数 entry 可信）。
 */
export function piBookContextRoles(manager: SessionManager): ("user" | "assistant")[] {
  return manager
    .buildSessionContext()
    .messages.map((message) => (message.role === "assistant" ? "assistant" : "user"));
}
