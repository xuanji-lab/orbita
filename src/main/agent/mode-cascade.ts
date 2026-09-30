/**
 * 用户切档的级联落地（子会话档位跟随父会话，2026-09-30 用户裁决）。
 *
 * 语义：**用户**在一条会话上切档（renderer → `agent:set-mode`）时，它名下的
 * **直接子会话一起切到同一档**。联动单向——父带子；用户单独给子会话切档只改
 * 子自己、不回写父，但下次父切档时会再次被覆盖。已终止 / 已完成的子会话同样
 * 跟着切：档位是会话的固有属性，完成后重开也该是这一档，跳过反而让「同一档」
 * 变成「多数时候同一档」。
 *
 * 只挂在用户切档这一条路上。**不存在任何让模型改子会话档位的工具或路径**——
 * 父会话若能借 delegate 让子会话换到 skip，就等于父会话越过了用户的权限边界
 * （被否决方案：delegate 带 mode 参数 / 给子会话开 set_mode 通道）。
 *
 * 子会话正在跑也立刻生效：runtime 的 setMode 只改账本，而工具审批闸门每次调用
 * 现场读账本——当前轮的后续工具马上按新档判定（system prompt 里的档位描述要等
 * 下一个 before_agent_start 才重讲，这正是解「子会话卡在 plan 档」的路径）。
 *
 * **纯核 + 依赖注入**（同 write-requests / channel/requests 的纪律），可被
 * `node --test` 直接测；agent/ipc.ts 只做路由。
 */
import { childSessions, type SessionMeta } from "../../shared/session.ts";
import type { PermissionMode } from "../../shared/permission.ts";

/** applyModeCascade 对外部世界的全部所需——store / host 各取最小视图。 */
export interface ModeCascadeDeps {
  /** 会话列表真源（SessionStore.list）：按 parentId 找直接子会话 */
  listSessions(): Promise<readonly SessionMeta[]>;
  /** runtime 侧改档（AgentHost.setMode：发 setMode 命令改 agent 进程账本） */
  setRuntimeMode(sessionId: string, mode: PermissionMode): Promise<void>;
  /** meta 侧改档（SessionStore.setMode：落盘，重开与父→子空闲投递的装配都读它） */
  setStoredMode(sessionId: string, mode: PermissionMode): Promise<void>;
}

/**
 * 把「用户切档」落到自己 + 全部直接子会话。本分支子会话只有一层（delegate 拒绝
 * 子再派），`childSessions` 也只取一层，不递归。子会话清单**先列后改**：改动与
 * 遍历互不影响。任何一个 setRuntimeMode / setStoredMode 抛错整个 handler 报错
 * （preload 翻成 IPC reject）——半途而废的切档比失败更糟：父子档位不一致正是
 * 这个功能要消灭的状态。
 */
export async function applyModeCascade(
  deps: ModeCascadeDeps,
  sessionId: string,
  mode: PermissionMode,
): Promise<void> {
  const children = childSessions(await deps.listSessions(), sessionId);
  await deps.setRuntimeMode(sessionId, mode);
  await deps.setStoredMode(sessionId, mode);
  for (const child of children) {
    await deps.setRuntimeMode(child.id, mode);
    await deps.setStoredMode(child.id, mode);
  }
}
