/**
 * Skills 面的状态。
 *
 * **只在打开这个面时才读盘**：skills 不参与聊天路径，没有理由在启动时占一次 IO。
 * 读失败不谎报成「一个都没有」——沿用 load-state 的三态（同 D-3）。
 */
import { useCallback, useEffect, useState } from "react";
import { LOADING, READY, failed, type LoadState } from "../chat/load-state";
import { api } from "../../api";
import type { SkillMeta, SkillPatch } from "@shared/skill";
import type { McpServerInfo } from "@shared/mcp";


export interface SkillsState {
  skills: SkillMeta[];
  load: LoadState;
  /** MCP server 与它们此刻的连接状态。**和 skills 同一个面**：两者都是「agent 会什么」。 */
  servers: McpServerInfo[];
  serversLoad: LoadState;
  openMcpConfig: () => void;
  /** 选中哪一条（slug）；null = 还没选 */
  selected: string | null;
  select: (slug: string | null) => void;
  reload: () => void;
  toggle: (slug: string, enabled: boolean) => void;
  save: (slug: string, patch: SkillPatch) => Promise<void>;
  reveal: (slug: string | null) => void;
}

export function useSkills(active: boolean): SkillsState {
  const [skills, setSkills] = useState<SkillMeta[]>([]);
  const [load, setLoad] = useState<LoadState>(LOADING);
  const [selected, setSelected] = useState<string | null>(null);
  const [servers, setServers] = useState<McpServerInfo[]>([]);
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
      .then((list) => {
        setServers(list);
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

  const reload = useCallback(() => {
    setLoad(LOADING);
    refresh();
  }, [refresh]);

  /**
   * 启停。**先落盘再回读**，不做乐观更新：这一下是 rename，可能因为两边同名而失败，
   * 乐观更新会让开关先动一下再弹回去。
   */
  const toggle = useCallback(
    (slug: string, enabled: boolean) => {
      void api.skill
        .toggle(slug, enabled)
        .then(refresh)
        .catch((cause: unknown) => setLoad(failed(cause)));
    },
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

  return {
    skills,
    load,
    servers,
    serversLoad,
    openMcpConfig,
    selected,
    select: setSelected,
    reload,
    toggle,
    save,
    reveal,
  };
}
