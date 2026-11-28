/**
 * 会话授权目录 = 工作区根（meta.cwd）+ 工作区挂的附加目录。
 *
 * **唯一真源**：终端 cwd 授权（terminal/agent-requests.ts）与 LaTeX 编译
 * （latex/agent-requests.ts）都读这一份——两处各写一遍的话，迟早出现
 * 「提示词说可以在这里，工具说不行」的漂移（评审 A5）。
 *
 * 与开轮目录清单同源（main/agent/turn-directories.ts 的 attached 走同一个
 * workspaces.attachedDirsOf）：模型在 prompt 里读到「你可以去这些目录」，
 * 授权就必须认同一份名单。工作台**不在**名单里：那是会话私有草稿区。
 */
/**
 * 读授权目录只用到这两个字段。用结构类型而不是整个 SessionStore：
 * 真的 store 结构上满足它，测试也不必造一份完整的 SessionMeta（这里没有 `any`）。
 */
export interface SessionRootsSource {
  readMeta(sessionId: string): Promise<{ cwd?: string; workspaceId?: string | null } | null>;
}

export interface WorkspaceRootsSource {
  attachedDirsOf(workspaceId: string | null): Promise<string[]>;
}

export async function sessionAuthorizedRoots(
  sessions: SessionRootsSource,
  workspaces: WorkspaceRootsSource,
  sessionId: string,
): Promise<string[]> {
  const meta = await sessions.readMeta(sessionId);
  const attached = await workspaces.attachedDirsOf(meta?.workspaceId ?? null);
  return [...(meta?.cwd !== undefined ? [meta.cwd] : []), ...attached];
}
