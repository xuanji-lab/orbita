/**
 * Skills 面的状态。
 *
 * **只在打开这个面时才读盘**：skills 不参与聊天路径，没有理由在启动时占一次 IO。
 * 读失败不谎报成「一个都没有」——沿用 load-state 的三态（同 D-3）。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { LOADING, READY, failed, type LoadState } from "../chat/load-state";
import { api } from "../../api";
import { sameWorkspaceIds } from "./workspace-ids.ts";
import type { SkillMeta, SkillPatch, SkillScope } from "@shared/skill";
import type { McpServer, McpServerInfo } from "@shared/mcp";
import type { Workspace } from "@shared/workspace";


export interface SkillsState {
  skills: SkillMeta[];
  load: LoadState;
  /** 工作区列表——link 的目标集合从这来。**透传自调用方**，不是这个 hook 自己读的 */
  workspaces: Workspace[];
  /** MCP server 与它们此刻的连接状态。**和 skills 同一个面**：两者都是「agent 会什么」。 */
  servers: McpServerInfo[];
  /** 读坏的工作区自带 `.mcp.json` 的警告（一个坏文件不拖死整表，如实贴出来） */
  serverWarnings: string[];
  serversLoad: LoadState;
  openMcpConfig: () => void;
  reloadMcp: () => Promise<void>;
  addServer: (name: string, server: McpServer) => Promise<void>;
  removeServer: (name: string) => Promise<void>;
  setServerDisabled: (name: string, disabled: boolean) => Promise<void>;
  /** 选中哪一条（slug）；null = 还没选 */
  selected: string | null;
  select: (slug: string | null) => void;
  reload: () => void;
  link: (slug: string, scope: SkillScope) => void;
  unlink: (slug: string, scope: SkillScope) => void;
  /** 清一条 skill 的全部断链引用（missing 的收尾） */
  clean: (slug: string) => void;
  importFolder: (scope: SkillScope | null) => Promise<string | null>;
  save: (slug: string, patch: SkillPatch) => Promise<void>;
  reveal: (slug: string | null) => void;
}

/**
 * `workspaces`：侧栏渲染用的那一份（`session.workspaces`，即会话引擎的
 * `engine.workspaces`）。**不在这个 hook 里另起一份 state**——两份列表各自
 * 刷新会不同步：侧栏删工作区时这里的旧副本还在，Skills 列表 / 韦恩图 / 矩阵
 * 都会显示已经被删掉的工作区（2026-09-23 真机复现的 bug）。
 */
export function useSkills(active: boolean, workspaces: Workspace[]): SkillsState {
  const [skills, setSkills] = useState<SkillMeta[]>([]);
  const [load, setLoad] = useState<LoadState>(LOADING);
  const [selected, setSelected] = useState<string | null>(null);
  const [servers, setServers] = useState<McpServerInfo[]>([]);
  const [serverWarnings, setServerWarnings] = useState<string[]>([]);
  const [serversLoad, setServersLoad] = useState<LoadState>(LOADING);

  /** **读失败不清空手里那份**：刷新失败时上一份还列着，错误贴在它上面。 */
  const refresh = useCallback(() => {
    void api.skill
      .list()
      .then((list) => {
        setSkills(list);
        setLoad(READY);
      })
      .catch((cause: unknown) => setLoad(failed(cause)));
  }, []);

  const refreshServers = useCallback(() => {
    void api.mcp
      .list()
      .then((result) => {
        setServers(result.servers);
        setServerWarnings(result.warnings);
        setServersLoad(READY);
      })
      .catch((cause: unknown) => setServersLoad(failed(cause)));
  }, []);

  // 每次打开都重读：用户很可能刚在文件管理器里加了一个
  useEffect(() => {
    if (!active) return;
    refresh();
    refreshServers();
  }, [active, refresh, refreshServers]);

  // MCP 的连接状态是 agent 进程的运行时事实，随开会话、重载、闲置回收持续变化——
  // #163 按工作区实例化后它从「稀有事件」变成「连续变化」，面板开着就得跟着快照走，
  // 否则永远停在打开那一刻的状态（实测：会话里工具能用，面板却显示「还没连上」）
  useEffect(() => {
    if (!active) return undefined;
    return api.agent.onEvent((event) => {
      if (event.type === "mcp") refreshServers();
    });
  }, [active, refreshServers]);

  /**
   * 工作区集合变了就重读 skill 列表：侧栏删一个工作区时，主进程会连带清掉
   * 它下面的 skill 链接（`registerWorkspaceIpc` 注入的清理），面板还开着的话
   * skill 列表本身也过期了——不能只等用户下次开关面板才刷新。只比较 **id 集合**
   * （`sameWorkspaceIds`）：改名、换路径、顺序变化都不影响 link 的目标集合，
   * 不必触发重读。用 ref 记上一次看到的列表，初值就是当次 `workspaces`，
   * 挂载时不会误判成「变了」。
   */
  const seenWorkspacesRef = useRef<Workspace[]>(workspaces);
  useEffect(() => {
    const changed = !sameWorkspaceIds(seenWorkspacesRef.current, workspaces);
    seenWorkspacesRef.current = workspaces;
    if (active && changed) refresh();
  }, [active, workspaces, refresh]);

  const reload = useCallback(() => {
    setLoad(LOADING);
    refresh();
  }, [refresh]);

  /**
   * 链接 / 移链 / 清断链。**先落盘再回读**，不做乐观更新：互斥规则在主进程执行
   * （链进 global 会静默删 workspace 链接），乐观更新会把被删的那条留在屏幕上。
   */
  const link = useCallback(
    (slug: string, scope: SkillScope) => {
      void api.skill
        .link(slug, scope)
        .then(refresh)
        .catch((cause: unknown) => setLoad(failed(cause)));
    },
    [refresh],
  );

  const unlink = useCallback(
    (slug: string, scope: SkillScope) => {
      void api.skill
        .unlink(slug, scope)
        .then(refresh)
        .catch((cause: unknown) => setLoad(failed(cause)));
    },
    [refresh],
  );

  const clean = useCallback(
    (slug: string) => {
      void api.skill
        .clean(slug)
        .then(refresh)
        .catch((cause: unknown) => setLoad(failed(cause)));
    },
    [refresh],
  );

  /** 导入已有目录（4-1）：主进程开目录选择框；返回 slug（取消为 null） */
  const importFolder = useCallback(
    (scope: SkillScope | null) =>
      api.skill
        .import(scope)
        .then((slug) => {
          if (slug !== null) refresh();
          return slug;
        })
        .catch((cause: unknown) => {
          setLoad(failed(cause));
          return null;
        }),
    [refresh],
  );

  const save = useCallback(
    async (slug: string, patch: SkillPatch) => {
      await api.skill.write(slug, patch);
      refresh();
    },
    [refresh],
  );

  const reveal = useCallback((slug: string | null) => {
    void api.skill.reveal(slug).catch((cause: unknown) => setLoad(failed(cause)));
  }, []);

  const openMcpConfig = useCallback(() => {
    void api.mcp.openConfig().catch((cause: unknown) => setServersLoad(failed(cause)));
  }, []);

  /**
   * 热重载（1-1）。invoke 在 agent 进程重连完、新快照已缓存时才返回，
   * 回来后重拉列表拿到新状态。失败如实上屏（reload 是显式动作，用户在等结果）。
   */
  const reloadMcp = useCallback((): Promise<void> => {
    setServersLoad(LOADING);
    return api.mcp
      .reload()
      .then(refreshServers)
      .catch((cause: unknown) => {
        setServersLoad(failed(cause));
      });
  }, [refreshServers]);

  /** 加一台 server（4-2）：主进程写盘 + 自动重连，回来后刷新列表 */
  const addServer = useCallback(
    (name: string, server: McpServer) => api.mcp.add(name, server).then(refreshServers),
    [refreshServers],
  );

  /** 删一台 / 启停（4-2）：同上，写盘 + 重连后回读 */
  const removeServer = useCallback(
    (name: string) => api.mcp.remove(name).then(refreshServers),
    [refreshServers],
  );

  const setServerDisabled = useCallback(
    (name: string, disabled: boolean) => api.mcp.setDisabled(name, disabled).then(refreshServers),
    [refreshServers],
  );

  return {
    skills,
    load,
    workspaces,
    servers,
    serverWarnings,
    serversLoad,
    openMcpConfig,
    reloadMcp,
    addServer,
    removeServer,
    setServerDisabled,
    selected,
    select: setSelected,
    reload,
    link,
    unlink,
    clean,
    importFolder,
    save,
    reveal,
  };
}
