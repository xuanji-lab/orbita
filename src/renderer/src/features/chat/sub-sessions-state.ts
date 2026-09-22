/**
 * 右栏 Sub-sessions 面板的两层状态 —— 与 React 无关的纯逻辑（原样搬自
 * `git show e4322a4:src/renderer/src/features/chat/sub-sessions-state.ts`，旧 wip
 * 分支的先例；drawer-state.ts 同款先例）。
 *
 * 面板只有两层：列表（根会话的子会话清单）与会话（在面板里打开其中一条）。
 * 层不是「哪个会话被打开」的同义词：打开的会话 id 存在查看槽（`useSessionView`）里，
 * 这里只记「现在该渲染哪一层」，两者的真源不互相复制——App 把这份状态与查看槽
 * 分开持有（同 `channelShown` / `channelOpenRequest` 的先例，见 App.tsx）。
 */

export type SubSessionsView = { kind: "list" } | { kind: "session"; sessionId: string };

export const SUB_SESSIONS_LIST: SubSessionsView = { kind: "list" };

/** 点一行，或点派出卡：进会话层。 */
export function openSubSession(sessionId: string): SubSessionsView {
  return { kind: "session", sessionId };
}

/**
 * 主槽换了会话（或回了首页）时该渲染哪一层。**一律回列表**：面板里开着的那条
 * 是上一条母会话的子会话，主槽已经换人，它留在那里就是挂错了母亲。
 * 主槽 id 没变则保持原样——面板不该因为一次无关的重渲染丢掉用户的位置。
 */
export function syncToMainSession(
  view: SubSessionsView,
  previousMainId: string | null,
  nextMainId: string | null,
): SubSessionsView {
  if (previousMainId === nextMainId) return view;
  return SUB_SESSIONS_LIST;
}

/**
 * Esc 按下时的下一状态：会话层退回列表，列表层交给调用方关面板（返回 null）。
 * 两层共用一个键，语义是「退一步」而不是「直接退出」。
 */
export function escapeFrom(view: SubSessionsView): SubSessionsView | null {
  return view.kind === "session" ? SUB_SESSIONS_LIST : null;
}
