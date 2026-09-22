/**
 * 文件面板的根清单装配 —— `fs:roots` 的实做（契约在 `shared/files.ts`）。
 * **纯模块**（store 注入），可被 `node --test` 直接测——ipc.ts import electron，
 * 逻辑放那里就没法直接测（turn-directories.ts 的同款先例）。
 *
 * 顺序固定 session → workspace → attached：session 是唯一随会话变的根（「这条任务
 * 的草稿在这」），排最前；workspace 是 agent 的常驻地盘；attached 是用户后挂的，
 * 按挂上的顺序。每次现算、不缓存——工作台首次写入、挂 / 摘目录，面板下一次展开即生效。
 */
import { stat } from "node:fs/promises";
import { fileRootLabel, type FileRoot, type FileRootsRequest } from "../../shared/files.ts";
import { isNotFound } from "../fs-errors.ts";
import type { SessionStore } from "../session/store.ts";
import type { WorkspaceStore } from "../workspace/store.ts";

export async function resolveFileRoots(
  workspaces: WorkspaceStore,
  sessions: SessionStore,
  req: FileRootsRequest,
): Promise<FileRoot[]> {
  // session 根：工作台路径由 id 派生，标题来自 meta。会话不存在（刚开还没落 meta）/
  // 标题还没生成 → fileRootLabel 退 "Untitled task"，不留空行。
  // sessionId null = 会话 id 还没铸（新任务没发首条消息）：没有工作台可列，不出 session 根
  const sessionRoot: FileRoot | null =
    req.sessionId === null ? null : await sessionFileRoot(sessions, req.sessionId);

  // workspace 根：workspaceId null = Home 会话；指到已删的工作区也退 Home——
  // 会话落到 TASKS 是既有语义（resolveTurnDirectories 同款处理），根清单不该
  // 因为一个悬空的 workspaceId 失败，面板要的是「agent 在哪」，Home 永远是真的。
  const homePath = workspaces.defaultPath();
  // attached 走 attachedDirsOf（与开轮同一入口）：null → Home 挂的也出现；悬空 id → 空，
  // 退 Home 的会话不带已经无处归属的附加根
  const attachedDirs = await workspaces.attachedDirsOf(req.workspaceId);
  // workspace 根的身份（名字 / 路径）还得查表；null 与悬空 id 都退 Home——Home 永远是真的
  const workspace = req.workspaceId === null
    ? undefined
    : (await workspaces.list()).find((w) => w.id === req.workspaceId);

  const roots: FileRoot[] = [
    ...(sessionRoot === null ? [] : [sessionRoot]),
    {
      kind: "workspace",
      label: workspace === undefined ? "Home" : fileRootLabel("workspace", workspace.path, workspace.name, "Home"),
      path: workspace === undefined ? homePath : workspace.path,
      exists: await pathExists(workspace === undefined ? homePath : workspace.path),
    },
  ];

  for (const dir of attachedDirs) {
    roots.push({
      kind: "attached",
      // attached 的 label 就是路径末段（fileRootLabel 的 attached 分支，title 不参与）
      label: fileRootLabel("attached", dir, "", ""),
      path: dir,
      exists: await pathExists(dir),
    });
  }
  return roots;
}

/** 存不存在用 stat 现查。ENOENT = false；权限等其它错误照抛——读不了 ≠ 没有（workbenchStat 同一条规矩） */
async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (cause) {
    if (isNotFound(cause)) return false;
    throw cause;
  }
}

/** session 根：工作台路径由 id 派生，标题来自 meta；会话不存在 / 标题未生成 → "Untitled task" */
async function sessionFileRoot(sessions: SessionStore, sessionId: string): Promise<FileRoot> {
  const path = sessions.workbenchPath(sessionId);
  const meta = await sessions.readMeta(sessionId);
  return {
    kind: "session",
    label: fileRootLabel("session", path, meta?.title ?? "", "Untitled task"),
    path,
    exists: await pathExists(path),
  };
}
