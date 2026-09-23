import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../../api";
import type { FileEntry, FileRoot } from "@shared/files";
import type { Workspace } from "@shared/workspace";
import { mergeRefresh, refreshTargets } from "./tree-view";

/**
 * 文件面板的树状态（FilesPanel 的逻辑半边）。渲染只消费这里的快照，不碰 IPC。
 *
 * 根由主进程现算（`fs:roots`），顺序固定 session → workspace → attached；目录按需
 * 懒加载（`fs:list`），**缓存按目录绝对路径键，再次展开不重拉**——面板是快照视图，
 * 与主进程 list.ts 同一条纪律：列表与 lstat 之间条目被删就跳过，不为一条已经
 * 不在的东西废掉整层。要看新内容走 `refresh`：重拉根与所有展开目录，展开态保留；
 * agent 每跑完一轮自动走一次。
 *
 * 纯视图函数（排序 / 过滤 / AGENTS.md 判定 / footer 文案 / 刷新的计划与合并）在同目录
 * tree-view.ts——那里不连带 api（模块加载就摸 window），`node --test` 直接可测。
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
  /** 刷新在途（面板头的刷新按钮转圈、防连点） */
  refreshing: boolean;
  /** 目录行点击：收起 / 展开（展开时懒加载；缓存命中不重拉） */
  toggle: (root: string, dir: string) => void;
  /** 在系统文件管理器里显示一条路径 */
  reveal: (root: string, dir: string) => void;
  /**
   * 重拉根清单与所有展开目录，展开态保留、收起目录的旧缓存丢掉（下次展开现拉）。
   * 旧快照一直显示到新结果一次性换上——不清空、不出 Loading 行，滚动位置不跳。
   * 面板头的按钮手动调；agent 一轮结束（任何会话回 idle）时 hook 自己也调一次。
   */
  refresh: () => void;
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
  const [refreshing, setRefreshing] = useState(false);

  /** 在途目录请求（键 = dir），防连点重复拉 */
  const pendingRef = useRef<Set<string>>(new Set());
  /** dirs 的同步镜像（statesRef 同款先例）：loadDir 判断缓存要从 ref 读——依赖
   *  dirs state 的话，每次目录落定都会重建 loadDir → loadRoots → effect 连锁
   * 重拉一遍 roots（幂等但白拉，每展开一个目录来一次）。 */
  const dirsRef = useRef<ReadonlyMap<string, readonly FileEntry[]>>(new Map());
  /** expanded 的同步镜像：refresh 并回结果时要读「那一刻」的展开态（刷新在途时
   *  用户可能又点开 / 收起了目录），闭包里的 state 是发起时的旧值 */
  const expandedRef = useRef<ReadonlySet<string>>(new Set());
  /** 刷新在途标记（state 给渲染，ref 给同步判断：连点两下时 state 还没落定） */
  const refreshingRef = useRef(false);
  /** 刷新在途时又来了触发：落定后补跑一轮（见 refresh） */
  const rerunRef = useRef(false);
  /** 树的代次：会话 / 工作区 / 工作区列表一变就 +1。在途的 refresh 落定时代次
   *  变了就整轮作废——否则旧会话的根与目录会盖掉新树 */
  const generationRef = useRef(0);
  /** 上一个 sessionId：切会话 = 换一棵树，旧会话的展开状态与缓存不带过去 */
  const prevSessionRef = useRef<string | null>(sessionId);

  const loadDir = useCallback(
    async (root: string, dir: string): Promise<void> => {
      if (dirsRef.current.has(dir) || pendingRef.current.has(dir)) return;
      pendingRef.current.add(dir);
      try {
        const res = await api.files.list({ sessionId, workspaceId, root, dir });
        const next = new Map(dirsRef.current);
        // 键用请求的 dir 而不是回执的 res.dir：回执是 realpath 过的，根路径带 symlink
        // 时两者不同，而渲染与 refresh 都按请求路径查——键错了就永远 Loading
        next.set(dir, res.entries);
        dirsRef.current = next;
        setDirs(next);
      } catch (cause) {
        setActionError(failMessage(cause));
      } finally {
        pendingRef.current.delete(dir);
      }
    },
    [sessionId, workspaceId],
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
      // sessionId null（新任务没发首条消息）时主进程不出 session 根，面板不用再过滤
      const visible = await api.files.roots({ sessionId, workspaceId });
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
  }, [sessionId, workspaceId, loadDir]);

  useEffect(() => {
    generationRef.current += 1;
    // 切会话：清缓存与展开状态（新会话新树；也免得 Map 随会话数无限长）
    if (prevSessionRef.current !== sessionId) {
      prevSessionRef.current = sessionId;
      pendingRef.current.clear();
      dirsRef.current = new Map();
      expandedRef.current = new Set();
      setDirs(new Map());
      setExpanded(new Set());
    }
    void loadRoots();
  }, [sessionId, workspaceId, workspaces, loadRoots]);

  const toggle = useCallback(
    (root: string, dir: string): void => {
      const next = new Set(expandedRef.current);
      if (next.has(dir)) next.delete(dir);
      else next.add(dir);
      expandedRef.current = next;
      setExpanded(next);
      void loadDir(root, dir);
    },
    [loadDir],
  );

  const reveal = useCallback(
    (root: string, dir: string): void => {
      api.files.reveal({ sessionId, workspaceId, root, dir }).catch((cause: unknown) => {
        setActionError(failMessage(cause));
      });
    },
    [sessionId, workspaceId],
  );

  /**
   * 根清单也重拉：session 根在 agent 第一次写入前 exists 为 false，只重拉目录的话
   * 工作台建好了面板也还是「工作台为空」。各目录并发拉、全部落定后一次并回
   * （mergeRefresh），中途不动 state——换上之前一直显示旧快照。
   *
   * 在途时再被调（agent 一轮结束、另一条会话也跑完）：不吞掉，落定后补跑一轮——
   * 在途那轮可能在最后几次写盘之前就读过目录了。连点进不来这条路：按钮在途时禁用。
   */
  const refresh = useCallback((): void => {
    if (refreshingRef.current) {
      rerunRef.current = true;
      return;
    }
    refreshingRef.current = true;
    setRefreshing(true);
    const generation = generationRef.current;
    /** 一轮刷新；代次变了（会话 / 工作区换了）整轮作废 */
    const once = async (): Promise<void> => {
      try {
        const visible = await api.files.roots({ sessionId, workspaceId });
        if (generationRef.current !== generation) return;
        const results = new Map<string, readonly FileEntry[] | null>();
        let rootFailure: string | null = null;
        await Promise.all(
          refreshTargets(visible, expandedRef.current).map(async ({ root, dir }) => {
            try {
              const res = await api.files.list({ sessionId, workspaceId, root, dir });
              results.set(dir, res.entries);
            } catch (cause) {
              results.set(dir, null);
              // 非根目录拉失败按「已被删 / 挪走」处理（mergeRefresh 剪掉，不报错）；
              // 根刚被 fs:roots 报在盘上却列不出来，是真问题，如实报
              if (dir === root && rootFailure === null) rootFailure = failMessage(cause);
            }
          }),
        );
        if (generationRef.current !== generation) return;
        const liveRoots = visible.filter((root) => root.exists).map((root) => root.path);
        const next = mergeRefresh(
          { dirs: dirsRef.current, expanded: expandedRef.current },
          liveRoots,
          results,
        );
        dirsRef.current = next.dirs;
        expandedRef.current = next.expanded;
        setRoots(visible);
        setRootsError(null);
        setDirs(next.dirs);
        setExpanded(next.expanded);
        // 刷新就是一次重试：成功了旧的 list / reveal 报错不再成立，一并清掉
        setActionError(rootFailure);
      } catch (cause) {
        // fs:roots 失败：保留手里的根与快照（读失败 ≠ 空）
        if (generationRef.current === generation) setRootsError(failMessage(cause));
      }
    };
    void (async () => {
      try {
        do {
          rerunRef.current = false;
          await once();
          // 代次变了就不补跑：这个闭包的 sessionId / workspaceId 已经是旧树的
        } while (rerunRef.current && generationRef.current === generation);
      } finally {
        rerunRef.current = false;
        refreshingRef.current = false;
        setRefreshing(false);
      }
    })();
  }, [sessionId, workspaceId]);

  /**
   * agent 一轮跑完自动刷新：agent 写盘是面板过期的头号来源。**任何会话**的 phase
   * 回 idle 都算，不只正看着的这条——子会话、后台会话写的是同一个工作区 / 附加目录
   * （侧栏「哪条会话跑完都刷」同一个口径），多刷一次只是几次 fs:list。runtime 的
   * idle 晚于本轮所有工具调用收尾，这时读盘已经能看到最后一次写入。
   * 直接订事件而不是看 ChatSession.phase：面板只挂着时才订，关着不白拉；也不必
   * 分辨「切会话导致 phase 从 turn 变 idle」这种假的一轮结束。
   */
  useEffect(
    () =>
      api.agent.onEvent((event) => {
        if (event.type === "phase" && event.phase === "idle") refresh();
      }),
    [refresh],
  );

  return {
    roots,
    rootsLoading,
    rootsError,
    dirs,
    expanded,
    actionError,
    refreshing,
    toggle,
    reveal,
    refresh,
  };
}
