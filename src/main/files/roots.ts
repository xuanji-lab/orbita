/**
 * 文件面板的根清单装配 —— `fs:roots` 的实做（契约在 `shared/files.ts`）。
 * **纯模块**（store 注入），可被 `node --test` 直接测——ipc.ts import electron，
 * 逻辑放那里就没法直接测（turn-directories.ts 的同款先例）。
 *
 * 顺序固定 session → workspace → attached（→ 不进树的 attachments，见下）：session 是唯一随会话变的根（「这条任务
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

  // 专注 / 浏览态的只读预览根（extraWorkspaceId）：左栏正在看的工作区。按 id 从
  // store 解路径（renderer 从不传路径）；与会话自己的工作区相同就不重复出根，
  // 指到不存在的 id（刚被移除）就安静地没有这根。身份是第二颗 workspace 根，
  // 文件面板的树多一组、白名单多一块——边界仍是「存储里真实存在的工作区目录」。
  if (
    req.extraWorkspaceId != null &&
    req.extraWorkspaceId !== req.workspaceId
  ) {
    const extra = (await workspaces.list()).find((w) => w.id === req.extraWorkspaceId);
    if (extra !== undefined) {
      roots.push({
        kind: "workspace",
        label: fileRootLabel("workspace", extra.path, extra.name, ""),
        path: extra.path,
        exists: await pathExists(extra.path),
      });
    }
  }

  for (const dir of attachedDirs) {
    roots.push({
      kind: "attached",
      // attached 的 label 就是路径末段（fileRootLabel 的 attached 分支，title 不参与）
      label: fileRootLabel("attached", dir, "", ""),
      path: dir,
      exists: await pathExists(dir),
    });
  }
  // attachments 根：拖入的外部文件发送时复制到 sessions/<id>.attachments/（store 的
  // saveExternalFiles），不在上面任何一根之内。只为白名单，renderer 不把它画进树——
  // 没有它，附件列表点不开副本，PDF 引用也跳不过去
  if (req.sessionId !== null) {
    const path = sessions.attachmentsPath(req.sessionId);
    roots.push({ kind: "attachments", label: fileRootLabel("attachments", path, "", ""), path, exists: await pathExists(path) });
  }
  // cited 根：本会话 cite_pdf 核验过的 PDF，一个文件一个根、根路径就是文件本身（isInside 对
  // 「文件 vs 文件」只在两者 realpath 后是同一个文件时成立，同目录的别的 PDF、指向别处的软链接都进不去）。
  // 同样不进树，只为白名单——PDF 在会话看得到的目录之外也能原地打开引用。
  // 来源是本会话自己的 JSONL（主进程现读，增量缓存），按 sessionId 现算，别的会话借不到
  if (req.sessionId !== null) {
    const cited = await sessions.citedPdfPaths(req.sessionId);
    roots.push(
      ...(await Promise.all(
        cited.map(
          async (path): Promise<FileRoot> => ({
            kind: "cited",
            label: fileRootLabel("cited", path, "", ""),
            path,
            exists: await citedFileExists(path),
          }),
        ),
      )),
    );
  }
  return roots;
}

/**
 * cited 根的存在性：ENOENT = 已被删 / 挪走（面板据此给「原文件找不到了」而不是「看不到」）。
 * 其它错误（权限、坏链接环）不抛——一份读不了的 PDF 不该拖垮整张根清单，当它存在、
 * 真去读时再报真实的错
 */
async function citedFileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (cause) {
    return !isNotFound(cause);
  }
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
