import { useState } from "react";
import type {
  ContextAttachRow,
  ContextFileDir,
  ContextInventory,
  ContextReadRange,
  ContextScope,
} from "@shared/context-inventory";
import { pathTail } from "../../../../shared/path.ts";
import type { Messages } from "../../messages-en.ts";
import { useT } from "../../locale.ts";
import { Icon, type IconName } from "../../shell/Icon";
import { PanelHelp, RightPanelFrame } from "../../shell/RightPanel";
import { Chip } from "../../shell/Chip";
import type { Carryover } from "@shared/session";
import { TaskProgress } from "./TaskProgress";
import { formatTokens } from "../../utils/format-tokens.ts";
import type { SessionEntry } from "../chat/session-states.ts";
import { useContextInventory } from "../chat/useContextInventory.ts";
import {
  contextBar,
  groupSummaries,
  rulesBreakdown,
  shortOutsideDir,
  type ContextBar,
  type ContextGroupKey,
  type ContextGroupSummary,
} from "./context-panel-view.ts";
import "./context-panel.css";

/**
 * 右栏「这条任务」面板（2026-10-30 起两个页签：进度 / 上下文；进度见 TaskProgress.tsx）。
 *
 * 上下文页签回答「智能体这一刻脑子里装了什么」。
 *
 * - 胶囊：标题键 + 「本轮 / 整个任务」两档视野 + 口径说明「?」；
 * - 顶部用量：真实总量 / 窗口（pi 报的），下面一条按来源分段的中性色条——
 *   来源只有七类且都是数据不是状态，不另立七种颜色（设计系统：颜色是第二信号），
 *   悬停某组时条上对应那段点亮；
 * - 下面按来源分组（规则与说明 / 你附带的 / 文件 / 网页 / 其他会话 / MCP / 技能），
 *   空组整组不出，已压缩出上下文的条目灰显。
 *
 * 数据全部来自 `useContextInventory`（转录纯推导 + 规则注入清单），本组件只管画。
 */
export type TaskPanelTab = "progress" | "context";

export function ContextPanel(props: {
  /** 正在看的会话；null = 首页，还没有任务 */
  sessionId: string | null;
  entry: SessionEntry;
  cwd: string;
  /** 「这条任务」的两个页签（2026-10-30）：进度 / 上下文。App 持有——输入框旁的用量环要直接开到「上下文」 */
  tab: TaskPanelTab;
  onTab: (tab: TaskPanelTab) => void;
  /** 这条会话收割的遗留（进度页签的「留到以后」） */
  carryovers: readonly Carryover[];
  onSetCarryoverStatus: (id: string, status: Carryover["status"]) => void;
}) {
  const t = useT();
  const [scope, setScope] = useState<ContextScope>("turn");
  // 页签就是标题（同审查面板）：「进度 / 上下文」；口径说明「?」只在上下文页签有意义
  const header = (
    <div className="cap-review-head tabs-as-title">
      <div className="cap-tabs" role="tablist" aria-label={t.rail.context}>
        <button type="button" role="tab" className="cap-tab no-drag" aria-selected={props.tab === "progress"} onClick={() => props.onTab("progress")}>
          <Icon name="list-todo" size={12} strokeWidth={1.8} />
          {t.taskPanel.tabProgress}
        </button>
        <button type="button" role="tab" className="cap-tab no-drag" aria-selected={props.tab === "context"} onClick={() => props.onTab("context")}>
          <Icon name="layers" size={12} strokeWidth={1.8} />
          {t.taskPanel.tabContext}
        </button>
      </div>
      <div className="cap-slot-right">
        {props.tab === "context" && <PanelHelp label={t.contextPanel.helpLabel} text={t.contextPanel.help} />}
      </div>
    </div>
  );
  return (
    <RightPanelFrame header={header} contentKey={`task:${props.tab}:${scope}`}>
      {props.sessionId === null ? (
        <p className="panel-empty" style={{ paddingTop: "var(--space-3)" }}>
          {props.tab === "progress" ? t.taskPanel.noTask : t.contextPanel.noSession}
        </p>
      ) : props.tab === "progress" ? (
        <TaskProgress
          entry={props.entry}
          carryovers={props.carryovers}
          onSetCarryoverStatus={props.onSetCarryoverStatus}
          onOpenContext={() => props.onTab("context")}
        />
      ) : (
        <>
          {/* 视野：本轮 / 整个任务——原来住在胶囊里当页签，现在胶囊让给「进度 / 上下文」 */}
          <div className="ctx-scope set-chips" role="group" aria-label={t.contextPanel.title}>
            <Chip active={scope === "turn"} onClick={() => setScope("turn")}>
              {t.contextPanel.scopeTurn}
            </Chip>
            <Chip active={scope === "task"} onClick={() => setScope("task")}>
              {t.contextPanel.scopeTask}
            </Chip>
          </div>
          <ContextBody sessionId={props.sessionId} entry={props.entry} cwd={props.cwd} scope={scope} />
        </>
      )}
    </RightPanelFrame>
  );
}

function ContextBody(props: { sessionId: string; entry: SessionEntry; cwd: string; scope: ContextScope }) {
  const t = useT();
  const view = useContextInventory(props.sessionId, props.entry, props.cwd, props.scope);
  const { inventory } = view;
  const groups = groupSummaries(inventory);
  const bar = contextBar(groups, props.entry.stats?.contextUsage ?? null);
  /** 悬停中的组：条上对应那段点亮 */
  const [lit, setLit] = useState<ContextGroupKey | null>(null);
  /** 折叠的组：规则组默认收着（每轮都在、量大但用户最少需要看） */
  const [collapsed, setCollapsed] = useState<ReadonlySet<ContextGroupKey>>(() => new Set(["rules"]));
  const toggle = (key: ContextGroupKey): void =>
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const sourceGroups = groups.filter((group) => group.key !== "rules");
  return (
    <div className="ctx-body">
      {bar !== null && <UsageBlock bar={bar} scope={props.scope} lit={lit} />}
      {view.loading && <p className="panel-empty">{t.contextPanel.loading(view.fetched)}</p>}
      {view.capped && <p className="panel-empty">{t.contextPanel.capped}</p>}
      {view.error !== null && (
        <p className="panel-empty" role="alert" data-tone="danger">
          {t.contextPanel.loadError(view.error)}
        </p>
      )}
      <div className="panel-list ctx-list" onMouseLeave={() => setLit(null)}>
        {inventory.rules === null && (
          <div className="panel-group-head">
            <span className="panel-group-toggle">
              <span className="panel-group-label">{t.contextPanel.groups.rules}</span>
              <span className="panel-group-detail">{t.contextPanel.rulesUnknown}</span>
            </span>
          </div>
        )}
        {groups.map((group) => (
          <section key={group.key} onMouseEnter={() => setLit(group.key)}>
            <GroupHead group={group} collapsed={collapsed.has(group.key)} onToggle={() => toggle(group.key)} />
            {!collapsed.has(group.key) && <GroupRows group={group.key} inventory={inventory} scope={props.scope} />}
          </section>
        ))}
        {sourceGroups.length === 0 && !view.loading && (
          <p className="panel-empty ctx-empty">
            {props.scope === "turn" ? t.contextPanel.emptyTurn : t.contextPanel.emptyTask}
          </p>
        )}
      </div>
    </div>
  );
}

function UsageBlock(props: { bar: ContextBar; scope: ContextScope; lit: ContextGroupKey | null }) {
  const t = useT();
  const { bar } = props;
  const label =
    bar.used === null || bar.percent === null
      ? t.contextPanel.usageUnknown(formatTokens(bar.window))
      : t.contextPanel.usage(formatTokens(bar.used), formatTokens(bar.window), Math.round(bar.percent));
  const restName = props.scope === "turn" ? t.contextPanel.restTurn : t.contextPanel.restTask;
  const nameOf = (key: ContextGroupKey | "rest"): string => (key === "rest" ? restName : t.contextPanel.groups[key]);
  return (
    <div className="ctx-usage">
      <div className="ctx-usage-line">
        <span className="ctx-usage-label">{t.contextPanel.used}</span>
        <span className="ctx-usage-value">{label}</span>
      </div>
      <div className="ctx-bar" role="img" aria-label={label}>
        {bar.segments.map((segment) => (
          <span
            key={segment.key}
            className="ctx-seg"
            data-rest={segment.key === "rest" ? "true" : undefined}
            data-lit={props.lit === null ? undefined : props.lit === segment.key ? "true" : "false"}
            title={`${nameOf(segment.key)} · ${t.contextPanel.approx(formatTokens(segment.tokens))}`}
            style={{ width: `${segment.ratio * 100}%` }}
          />
        ))}
      </div>
      {bar.rest !== null && bar.rest > 0 && (
        <div className="ctx-rest">
          {restName} · {t.contextPanel.approx(formatTokens(bar.rest))}
        </div>
      )}
    </div>
  );
}

function GroupHead(props: { group: ContextGroupSummary; collapsed: boolean; onToggle: () => void }) {
  const t = useT();
  const { group } = props;
  return (
    <div className="panel-group-head">
      <button
        type="button"
        className="panel-group-toggle"
        aria-expanded={!props.collapsed}
        onClick={props.onToggle}
        data-gone={group.allGone ? "true" : undefined}
      >
        <Icon name="chevron-right" size={12} strokeWidth={2} className="panel-group-chev" />
        <span className="panel-group-label">{t.contextPanel.groups[group.key]}</span>
        <span className="panel-group-detail">{group.count}</span>
        <span className="row-trailing ctx-tokens">
          {group.allGone ? t.contextPanel.gone : t.contextPanel.approx(formatTokens(group.liveTokens))}
        </span>
      </button>
    </div>
  );
}

/** 一行的统一形状：图标 + 主名 + 浅灰副标 + 行尾 token；gone 整行灰显 */
interface RowView {
  key: string;
  icon: IconName;
  name: string;
  detail: string[];
  tokens: number;
  gone: boolean;
  turn: number | null;
  /** 悬停全文（路径 / url / 引用原文） */
  title?: string;
}

function Row(props: { row: RowView; scope: ContextScope }) {
  const t = useT();
  const { row } = props;
  // 整个任务视野才标轮号：本轮视野里全是这一轮，标了是噪音
  const detail = [
    ...(props.scope === "task" && row.turn !== null ? [t.contextPanel.turnOf(row.turn)] : []),
    ...row.detail,
    ...(row.gone ? [t.contextPanel.gone] : []),
  ].filter((part) => part !== "");
  return (
    <div className="ctx-row" data-gone={row.gone ? "true" : undefined} title={row.title ?? row.name}>
      <Icon name={row.icon} size={14} className="ctx-row-icon" />
      <span className="ctx-row-name">{row.name}</span>
      {detail.length > 0 && <span className="ctx-row-detail">{detail.join(" · ")}</span>}
      <span className="row-trailing ctx-tokens">{t.contextPanel.approx(formatTokens(row.tokens))}</span>
    </div>
  );
}

function rangeText(range: ContextReadRange, t: Messages): string {
  if (range.kind === "all") return t.contextPanel.rangeAll;
  if (range.kind === "pages-default") return t.contextPanel.rangePagesDefault;
  return range.kind === "lines"
    ? t.contextPanel.rangeLines(range.from, range.to)
    : t.contextPanel.rangePages(range.from, range.to);
}

function attachRow(row: ContextAttachRow, index: number, t: Messages): RowView {
  const base = { key: `attach:${index}`, tokens: row.tokens, gone: row.gone, turn: row.turn };
  if (row.kind === "quote") {
    return {
      ...base,
      icon: "quote",
      name: `「${row.text}」`,
      detail: [t.contextPanel.quote(row.quoteTurn, row.quoteRole === "user")],
      title: row.text,
    };
  }
  if (row.kind === "pasted") {
    return { ...base, icon: "file-text", name: t.contextPanel.pasted, detail: [t.contextPanel.pastedChars(row.chars)] };
  }
  if (row.kind === "image") {
    return { ...base, icon: "image", name: t.contextPanel.images(row.count), detail: [] };
  }
  return {
    ...base,
    icon: row.dir ? "folder" : "file",
    name: pathTail(row.path) || row.path,
    detail: [row.dir ? t.contextPanel.folderRef : "", row.count > 1 ? t.contextPanel.times(row.count) : ""],
    title: row.path,
  };
}

function dirLabel(dir: ContextFileDir, t: Messages): string {
  if (dir.outside) return `${shortOutsideDir(dir.dir)} · ${t.contextPanel.outside}`;
  return dir.dir === "." ? t.contextPanel.root : dir.dir;
}

function GroupRows(props: { group: ContextGroupKey; inventory: ContextInventory; scope: ContextScope }) {
  const t = useT();
  const { inventory, scope } = props;
  const rows = (list: readonly RowView[]) => list.map((row) => <Row key={row.key} row={row} scope={scope} />);

  if (props.group === "rules") {
    if (inventory.rules === null) return null;
    const breakdown = rulesBreakdown(inventory.rules);
    return (
      <>
        {rows([
          ...breakdown.files.map((file, index) => ({
            key: `rule:${index}`,
            icon: "scroll-text" as const,
            name: file.name,
            detail: [file.scope === "global" ? t.contextPanel.ruleGlobal : t.contextPanel.ruleProject],
            tokens: file.tokens,
            gone: false,
            turn: null,
            title: file.path,
          })),
          ...(breakdown.skillsIndex === null
            ? []
            : [
                {
                  key: "skills-index",
                  icon: "book-open" as const,
                  name: t.contextPanel.skillsIndex(breakdown.skillsIndex.names.length),
                  detail: [],
                  tokens: breakdown.skillsIndex.tokens,
                  gone: false,
                  turn: null,
                  title: breakdown.skillsIndex.names.join("\n"),
                },
              ]),
          {
            key: "builtin",
            icon: "bot" as const,
            name: t.contextPanel.builtin,
            detail: [],
            tokens: breakdown.builtinTokens,
            gone: false,
            turn: null,
          },
        ])}
      </>
    );
  }

  if (props.group === "attach") return <>{rows(inventory.attach.rows.map((row, index) => attachRow(row, index, t)))}</>;

  if (props.group === "files") {
    return (
      <>
        {inventory.files.dirs.map((dir) => (
          <div key={`${dir.outside ? "o" : "i"}:${dir.dir}`} className="ctx-dir-block">
            <div className="ctx-dir" title={dir.dir}>
              {dirLabel(dir, t)}
            </div>
            {rows(
              dir.rows.map((row) => ({
                key: `file:${row.path}`,
                icon: "file-text" as const,
                name: row.name,
                detail: [row.ranges.map((range) => rangeText(range, t)).join("、")],
                tokens: row.tokens,
                gone: row.gone,
                turn: row.turn,
                title: row.path,
              })),
            )}
          </div>
        ))}
        {rows(
          inventory.files.searches.map((note) => ({
            key: `search:${note.tool}`,
            icon: "search" as const,
            name: note.tool,
            detail: [t.contextPanel.times(note.count)],
            tokens: note.tokens,
            gone: note.gone,
            turn: note.turn,
          })),
        )}
      </>
    );
  }

  if (props.group === "web") {
    return (
      <>
        {rows(
          inventory.web.rows.map((row) => ({
            key: `web:${row.url}`,
            icon: "globe" as const,
            name: row.title ?? row.domain ?? row.url,
            detail: [row.title !== null && row.domain !== null ? row.domain : ""],
            tokens: row.tokens,
            gone: row.gone,
            turn: row.turn,
            title: row.url,
          })),
        )}
      </>
    );
  }

  if (props.group === "tasks") {
    return (
      <>
        {rows(
          inventory.tasks.rows.map((row) => ({
            key: `task:${row.ref}`,
            icon: "messages-square" as const,
            name: row.catalog ? t.contextPanel.catalog : (row.title ?? row.ref),
            detail: [
              row.external ? t.contextPanel.external : "",
              row.rounds === null ? "" : t.contextPanel.rounds(row.rounds.join(", ")),
            ],
            tokens: row.tokens,
            gone: row.gone,
            turn: row.turn,
          })),
        )}
      </>
    );
  }

  if (props.group === "mcp") {
    return (
      <>
        {rows(
          inventory.mcp.rows.map((row) => ({
            key: `mcp:${row.server}:${row.tool}`,
            icon: "plug" as const,
            name: row.tool === "" ? row.server : `${row.server} › ${row.tool}`,
            detail: [
              row.tool === "" ? t.contextPanel.named : (row.query ?? ""),
              row.calls > 1 ? t.contextPanel.times(row.calls) : "",
            ],
            tokens: row.tokens,
            gone: row.gone,
            turn: row.turn,
          })),
        )}
      </>
    );
  }

  return (
    <>
      {rows(
        inventory.skills.rows.map((row) => ({
          key: `skill:${row.how}:${row.name}`,
          icon: "book-open" as const,
          name: row.name,
          detail: [row.how === "invoked" ? t.contextPanel.named : t.contextPanel.readOnDemand],
          tokens: row.tokens,
          gone: row.gone,
          turn: row.turn,
        })),
      )}
    </>
  );
}
