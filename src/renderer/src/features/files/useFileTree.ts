import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../../api";
import type { FileEntry, FileRoot } from "@shared/files";
import type { Workspace } from "@shared/workspace";

/**
 * 文件面板的树状态（FilesPanel 的逻辑半边）。渲染只消费这里的快照，不碰 IPC。
 *
 * 根由主进程现算（`fs:roots`），顺序固定 session → workspace → attached；目录按需
 * 懒加载（`fs:list`），**缓存按目录绝对路径键，再次展开不重拉**——面板是快照视图，
 * 与主进程 list.ts 同一条纪律：列表与 lstat 之间条目被删就跳过，不为一条已经
 * 不在的东西废掉整层。要看新内容，重开面板（重挂载重拉）即可。
 *
 * 纯视图函数（排序 / 过滤 / AGENTS.md 判定 / footer 文案）在同目录 tree-view.ts
 * ——那里不连带 api（模块加载就摸 window），`node --test` 直接可测。
 */

export interface FileTreeState {
  /** 要显示的根（sessionId 为 null 时 session 根已被过滤掉） */
  roots: readonly FileRoot[];
  /** 第一读（手里还没有任何根）期间为 true */
  rootsLoading: boolean;
  /** roots 读失败的原因；失败时保留上一份根（D-3 同款：读失败 ≠ 空） */
  rootsError: string | null;
  /** 每个已加载目录的条目（懒加载快照，键 = 目录绝对路径） */
  dirs: ReadonlyMap<string, readonly FileEntry[]>;
  /** 已展开的子目录（绝对路径）。根层永远直接展示，不在这张表里 */
  expanded: ReadonlySet<string>;
  /** list / reveal 的最近一次失败原因（贴在面板内容顶部） */
  actionError: string | null;
  /** 目录行点击：收起 / 展开（展开时懒加载；缓存命中不重拉） */
  toggle: (root: string, dir: string) => void;
  /** 在系统文件管理器里显示一条路径 */
  reveal: (root: string, dir: string) => void;
}

const failMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

export function useFileTree(
  sessionId: string | null,
  workspaceId: string | null,
  workspaces: readonly Workspace[],
): FileTreeState {
  const [roots, setRoots] = useState<readonly FileRoot[]>([]);
  const [rootsLoading, setRootsLoading] = useState(true);
  const [rootsError, setRootsError] = useState<string | null>(null);
  const [dirs, setDirs] = useState<ReadonlyMap<string, readonly FileEntry[]>>(new Map());
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [actionError, setActionError] = useState<string | null>(null);

  /**
   * 契约（shared/files.ts）的 sessionId 是必填 string；还没有会话（新任务没发首条
   * 消息）时传空串占位——主进程会照算出 workspace / attached 根，session 根那一条
   * 由下面过滤掉不用。
   */
  const effectiveSessionId = sessionId ?? "";

  /** 在途目录请求（键 = dir），防连点重复拉 */
  const pendingRef = useRef<Set<string>>(new Set());
  /** dirs 的同步镜像（statesRef 同款先例）：loadDir 判断缓存要从 ref 读——依赖
   *  dirs state 的话，每次目录落定都会重建 loadDir → loadRoots → effect 连锁
   * 重拉一遍 roots（幂等但白拉，每展开一个目录来一次）。 */
  const dirsRef = useRef<ReadonlyMap<string, readonly FileEntry[]>>(new Map());
  /** 上一个 sessionId：切会话 = 换一棵树，旧会话的展开状态与缓存不带过去 */
  const prevSessionRef = useRef<string | null>(sessionId);

  const loadDir = useCallback(
    async (root: string, dir: string): Promise<void> => {
      if (dirsRef.current.has(dir) || pendingRef.current.has(dir)) return;
      pendingRef.current.add(dir);
      try {
        const res = await api.files.list({ sessionId: effectiveSessionId, workspaceId, root, dir });
        const next = new Map(dirsRef.current);
        next.set(res.dir, res.entries);
        dirsRef.current = next;
        setDirs(next);
      } catch (cause) {
        setActionError(failMessage(cause));
      } finally {
        pendingRef.current.delete(dir);
      }
    },
    [effectiveSessionId, workspaceId],
  );

  /**
   * 重拉 roots：面板挂载（打开）、sessionId / workspaceId / workspaces 变化时各来
   * 一次。attach / detach 之后调 reloadWorkspaces，workspaces 引用一变这里跟着重拉
   * ——目录增删即时可见，不另开刷新口子。
   */
  const loadRoots = useCallback(async (): Promise<void> => {
    setRootsLoading(true);
    setRootsError(null);
    try {
      const list = await api.files.roots({ sessionId: effectiveSessionId, workspaceId });
      const visible = sessionId === null ? list.filter((r) => r.kind !== "session") : list;
      setRoots(visible);
      // 每个在盘上的根默认展开第一层：直接拉根目录，缓存 / 在途去重
      for (const root of visible) {
        if (root.exists) void loadDir(root.path, root.path);
      }
    } catch (cause) {
      setRootsError(failMessage(cause));
    } finally {
      setRootsLoading(false);
    }
  }, [effectiveSessionId, sessionId, workspaceId, loadDir]);

  useEffect(() => {
    // 切会话：清缓存与展开状态（新会话新树；也免得 Map 随会话数无限长）
    if (prevSessionRef.current !== sessionId) {
      prevSessionRef.current = sessionId;
      pendingRef.current.clear();
      dirsRef.current = new Map();
      setDirs(new Map());
      setExpanded(new Set());
    }
    void loadRoots();
  }, [sessionId, workspaceId, workspaces, loadRoots]);

  const toggle = useCallback(
    (root: string, dir: string): void => {
      setExpanded((prev) => {
        const next = new Set(prev);
        if (next.has(dir)) next.delete(dir);
        else next.add(dir);
        return next;
      });
      void loadDir(root, dir);
    },
    [loadDir],
  );

  const reveal = useCallback(
    (root: string, dir: string): void => {
      api.files.reveal({ sessionId: effectiveSessionId, workspaceId, root, dir }).catch((cause: unknown) => {
        setActionError(failMessage(cause));
      });
    },
    [effectiveSessionId, workspaceId],
  );

  return { roots, rootsLoading, rootsError, dirs, expanded, actionError, toggle, reveal };
}
