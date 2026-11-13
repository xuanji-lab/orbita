import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import type { Workspace } from "@shared/workspace";
import { useT } from "../locale.ts";
import { Chip } from "./Chip";
import { filterKey, resolveFilter, sameFilter, type WsAllow, type WsFilter, type WsOption } from "./workspace-filter.ts";
import { useHScroll } from "./h-scroll.ts";
import "./h-scroll.css";
import "./workspace-filter.css";

/**
 * 已归档 / 以后再做 / 能力面板共用的「工作区选择条」：一排胶囊（全部 / 各工作区 / 任务 / 全局）带条数，
 * 选中态是 Chip 自带的 mode-active 色（明主题蓝、暗主题黄）。工作区胶囊前是侧栏组头同一枚 folder 图标，
 * 全局是 globe；不画颜色点——侧栏本身没有按工作区取色，凭空发明一套标识色会让第 4 个工作区开始重复。
 *
 * **放不下时横向滚动**，不收成「更多」：选择条只有三五档，收进菜单要多点一下，滚动一拨就到；
 * 选中的那档会滚进视野，滚不到的一侧用淡出提示还有。纵向滚轮在这一条上转成横向（鼠标没有横滚）。
 * 这套滚动行为在 h-scroll.ts，辅助对话胶囊的标签区同用。
 */
export function WorkspaceFilterBar(props: {
  options: readonly WsOption[];
  workspaces: readonly Workspace[];
  selected: WsFilter;
  onSelect: (filter: WsFilter) => void;
}) {
  const t = useT().sidebar;
  // 横滚 / 淡出 / 选中的那档滚进视野 / 竖滚轮转横向：与辅助对话胶囊的标签区共用（h-scroll.ts）
  const selectedKey = filterKey(props.selected);
  const scroll = useHScroll('[data-active="true"]', [props.options, selectedKey]);

  const labelOf = (filter: WsFilter): string =>
    filter.kind === "all"
      ? t.wsFilterAll
      : filter.kind === "tasks"
        ? t.wsFilterTasks
        : filter.kind === "global"
          ? t.wsFilterGlobal
          : (props.workspaces.find((workspace) => workspace.id === filter.id)?.name ?? filter.id);

  return (
    <div
      ref={scroll.ref}
      className="ws-filter-bar h-scroll"
      role="group"
      aria-label={t.wsFilterAria}
      data-fade-start={scroll.fade.start || undefined}
      data-fade-end={scroll.fade.end || undefined}
      onScroll={scroll.onScroll}
    >
      {props.options.map((option) => {
        const label = labelOf(option.filter);
        return (
          <Chip
            key={filterKey(option.filter)}
            icon={option.filter.kind === "workspace" ? "folder" : option.filter.kind === "global" ? "globe" : undefined}
            active={sameFilter(option.filter, props.selected)}
            title={label}
            onClick={() => props.onSelect(option.filter)}
          >
            <span className="ws-chip-in">
              <span className="ws-chip-name">{label}</span>
              <span className="ws-chip-count">{option.count}</span>
            </span>
          </Chip>
        );
      })}
    </div>
  );
}

/**
 * 钉在滚动区上方的那一条（选择条）与滚动内容之间的分界：内容没滚时不画线（顶上本来就是干净的），
 * 滚起来、内容被滚动区的上缘裁掉时才在条下画一根发丝线——不然被裁的内容（提示条、列表行）
 * 紧贴着选择条硬切，读起来像是选择条「盖」在了内容上。`reset` 变了（换了面板内容）就回到未滚态。
 */
export function useScrolledEdge(reset?: unknown): { scrolled: boolean; onScroll: (event: React.UIEvent<HTMLElement>) => void; edgeStyle: React.CSSProperties } {
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => setScrolled(false), [reset]);
  const onScroll = useCallback((event: React.UIEvent<HTMLElement>) => {
    const next = event.currentTarget.scrollTop > 0;
    setScrolled((now) => (now === next ? now : next));
  }, []);
  const edgeStyle: React.CSSProperties = {
    borderBottom: `1px solid ${scrolled ? "var(--color-border-subtle)" : "transparent"}`,
  };
  return { scrolled, onScroll, edgeStyle };
}

/**
 * 每个面板各记一份上次选的（key = 面板名），整个应用生命周期内不丢：右栏关了再开、切走又回来仍停在原来那档。
 * **不按会话记**（用户裁决）：没选过时才走默认（当前会话所在工作区），之后随用户。
 * 唯一例外是能力面板的右栏版（2026-11-07 右栏按会话记到第二层）：它在这份全局记录之上，另按会话记一份自己选过的档
 * （PluginsView 的 ownFilter / PluginsSub.ws），全局这份仍照写，设置里的全屏版与没选过的会话据此默认。
 * 同一个面板可能同时挂两份（能力面板：右栏版与设置里的全屏版），所以是个可订阅的小仓库而不是各自的 state——
 * 一处选了，另一处跟着变。
 */
const chosen = new Map<string, WsFilter>();
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useWorkspaceFilter(
  panel: string,
  fallback: WsFilter,
  workspaces: readonly Workspace[],
  allow: WsAllow,
): [WsFilter, (next: WsFilter) => void] {
  const picked = useSyncExternalStore(subscribe, () => chosen.get(panel));
  const filter = resolveFilter(picked, fallback, workspaces, allow);
  const select = useCallback(
    (next: WsFilter) => {
      chosen.set(panel, next);
      for (const listener of listeners) listener();
    },
    [panel],
  );
  return [filter, select];
}
