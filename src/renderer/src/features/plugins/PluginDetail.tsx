/**
 * 插件详情（设计稿 v5 屏 1）：**一张长页**——头部（头像、名字、来源、描述）+ 各节：
 * 它能做什么（技能、脚本、外接）/ 输入与输出 / 工作流（标出等你的步骤）/ 看板样式（缩小的看板 + 每卡一行 +「打开看板」）/
 * 要你填的 / 装在哪 / 来源与版本。宽的时候左右两列（左：能做什么、输入输出、工作流；右：装在哪、要你填的、来源与版本，
 * 看板样式跨两列放最下），窄的时候（右栏）单列，顺序见 plugins.css 的 `order`。
 *
 * 「正在做」（草稿，`draftPath` 非空）就是这张页：清单里还没写的节画虚线框「还没聊到」，刚变化的节外圈高亮 2 秒，
 * 文件改动几秒内刷新；没有安装记录，所以没有开关、没有卸载。
 * 旧技能与旧 MCP 同样走这一页，只是没有输入输出 / 工作流 / 看板，能做的动作少几样。
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { parsePluginViewId, type PluginScope, type PluginView } from "@shared/plugin";
import type { Workspace } from "@shared/workspace";
import { api } from "../../api";
import { useT } from "../../locale.ts";
import { Icon } from "../../shell/Icon";
import { ConfigField, ScopeEditor } from "./PluginConfig.tsx";
import { BoardStyleBody } from "./PluginBoardSection.tsx";
import { ExternalAbility, McpAbility, PluginAvatar, ScriptsAbility, SkillAbility, UnsupportedAbility } from "./PluginParts.tsx";
import { WorkflowList } from "./PluginWorkflow.tsx";
import {
  FRESH_HIGHLIGHT_MS,
  changedSections,
  sectionFilled,
  sectionSignatures,
  waitCount,
  type DetailSection,
  type SectionSignatures,
} from "./detail-sections.ts";
import { conflictText, problemText } from "./plugin-text.ts";
import { isBuiltinView, sourceKey } from "./plugin-view.ts";

const DATE = new Intl.DateTimeFormat(undefined, { year: "numeric", month: "2-digit", day: "2-digit" });

export function PluginDetail(props: {
  view: PluginView;
  workspaces: readonly Workspace[];
  /** 当前会话所在的工作区（看板的数据路径里 `${workspaceFolder}` 按它解析，也决定看板在这里启没启用） */
  currentWorkspaceId: string | null;
  /** 「正在做」：这份视图是还没安装的草稿（工作区内插件文件夹的路径）；null / 不给 = 已装的 */
  draftPath?: string | null;
  /** 点「打开看板」：右栏版进入看板视图；设置里的全屏版 = 关设置并在右栏打开 */
  onOpenBoard: () => void;
  /** 页内是否画返回键：右栏版的返回键在工具栏胶囊里，不重复 */
  showBack: boolean;
  onBack: () => void;
  onScope: (scope: PluginScope) => Promise<void>;
  /** 配置 / 重载 / 卸载之后让列表回读 */
  onChanged: () => Promise<void>;
  /** 卸载完成：回已装列表 */
  onUninstalled: () => void;
}) {
  const messages = useT();
  const t = messages.plugins;
  const { view } = props;
  const draft = props.draftPath !== undefined && props.draftPath !== null;
  const parsed = parsePluginViewId(view.id);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState<null | "reload" | "uninstall">(null);
  const [reloaded, setReloaded] = useState(false);
  const [leadOpen, setLeadOpen] = useState(false);

  // 草稿里刚变化的节高亮 2 秒：只比较各节自己的内容签名（标题 / 描述变了不亮）
  const signatures = useMemo(() => sectionSignatures(view), [view]);
  const previousSignatures = useRef<SectionSignatures | null>(null);
  const [fresh, setFresh] = useState<readonly DetailSection[]>([]);
  useEffect(() => {
    if (!draft) return;
    const changed = changedSections(previousSignatures.current, signatures);
    previousSignatures.current = signatures;
    if (changed.length > 0) setFresh(changed);
  }, [signatures, draft]);
  useEffect(() => {
    if (fresh.length === 0) return;
    const timer = window.setTimeout(() => setFresh([]), FRESH_HIGHLIGHT_MS);
    return () => window.clearTimeout(timer);
  }, [fresh]);

  const run = async (task: () => Promise<void>): Promise<void> => {
    setError(null);
    try {
      await task();
    } catch (cause) {
      setError(t.actionFailed(cause instanceof Error ? cause.message : String(cause)));
    }
  };

  const source = sourceKey(view);
  const sourceLabel = {
    builtin: t.sourceBuiltin,
    userSkill: t.sourceUserSkill,
    userMcp: t.sourceUserMcp,
    copy: t.sourceCopy,
    link: t.sourceLink,
    git: t.sourceGit,
  }[source];
  const by = draft ? [t.draftBy] : [view.author, view.version, view.license, sourceLabel].filter((part): part is string => part !== null && part !== "");
  const isPlugin = view.origin === "plugin";
  const hasAbilities = sectionFilled(view, "abilities");
  const linked = view.install?.source.kind === "link";
  /** Orbita 内置（做插件）：可以停用，不能卸载 */
  const builtin = isBuiltinView(view);
  const pluginName = parsed?.key ?? "";

  /** 一节：草稿里没写的画虚线框「还没聊到」+ 一句提示，写了的正常画；刚变化的外圈亮一下 */
  const section = (key: DetailSection, title: string, body: ReactNode, opts: { hint?: string; trailing?: ReactNode; placeholder: string }): ReactNode => {
    if (draft && !sectionFilled(view, key)) {
      return (
        <section className="pl-card pl-ph" data-sec={key}>
          <div className="pl-card-h">
            {title}
            <span className="hint">{t.notChatted}</span>
          </div>
          <p className="pl-ph-text">{opts.placeholder}</p>
        </section>
      );
    }
    return (
      <section className="pl-card" data-sec={key} data-fresh={fresh.includes(key) ? "true" : undefined}>
        <div className="pl-card-h">
          {title}
          {opts.hint !== undefined && <span className="hint">{opts.hint}</span>}
          {opts.trailing !== undefined && <span className="pl-card-trail">{opts.trailing}</span>}
        </div>
        {body}
      </section>
    );
  };

  const abilities = section(
    "abilities",
    t.abilitiesTitle,
    hasAbilities ? (
      <div>
        {view.skills.map((skill) => (
          <SkillAbility key={`s:${skill.slug}`} skill={skill} />
        ))}
        {view.mcp.map((server) => (
          <McpAbility key={`m:${server.name}`} server={server} />
        ))}
        {view.contents.scripts && <ScriptsAbility />}
        {view.external.length > 0 && <ExternalAbility items={view.external} />}
        {view.unsupported.map((entry) => (
          <UnsupportedAbility key={`u:${entry.kind}`} entry={entry} />
        ))}
      </div>
    ) : (
      // 只带看板的插件（技能 / MCP 都没有）不是「加载不了」，是本来就没有
      <span className="pl-muted">{view.board !== null ? t.abilitiesNone : t.abilitiesEmpty}</span>
    ),
    { hint: t.abilitiesHint, placeholder: t.phAbilities },
  );

  const hasIo = sectionFilled(view, "io");
  const io =
    draft || hasIo
      ? section(
          "io",
          t.ioTitle,
          <div>
            {(["reads", "writes"] as const).map((side) =>
              view.io[side].length === 0 ? null : (
                <div className="pl-ab" key={side}>
                  <span className="pl-ab-kind pl-io-kind">
                    <Icon name={side === "reads" ? "log-in" : "log-out"} size={12} strokeWidth={1.8} />
                    {side === "reads" ? t.ioRead : t.ioWrite}
                  </span>
                  <div className="pl-ab-body">
                    {view.io[side].map((item, index) => (
                      <span className="pl-io" key={index}>
                        <code>{item.path}</code>
                        {(item.note !== null || item.when !== null) && <small>{[item.note, item.when].filter((part) => part !== null).join(" · ")}</small>}
                      </span>
                    ))}
                  </div>
                </div>
              ),
            )}
          </div>,
          { hint: t.ioHint, placeholder: t.phIo },
        )
      : null;

  const hasWorkflow = view.workflow.length > 0;
  const waits = waitCount(view.workflow);
  const workflow =
    draft || hasWorkflow
      ? section("workflow", t.workflowTitle, <WorkflowList pluginName={pluginName} steps={view.workflow} canView={!draft} />, {
          hint: waits === 0 ? t.workflowHint : undefined,
          trailing: waits > 0 ? t.workflowWaits(waits) : undefined,
          placeholder: t.phWorkflow,
        })
      : null;

  const board =
    view.board !== null || draft
      ? section(
          "board",
          t.boardTitle,
          view.board === null ? null : (
            <BoardStyleBody
              board={view.board}
              target={draft ? { kind: "draft", path: props.draftPath ?? "", workspaceId: props.currentWorkspaceId } : { kind: "installed", name: pluginName, workspaceId: props.currentWorkspaceId }}
            />
          ),
          {
            trailing:
              view.board === null ? undefined : (
                <button type="button" className="pl-btn pl-open-board" onClick={props.onOpenBoard}>
                  <Icon name="layout-grid" size={12} strokeWidth={1.8} />
                  {t.boardOpen}
                </button>
              ),
            placeholder: t.phBoard,
          },
        )
      : null;

  const scope = section(
    "scope",
    t.scopeTitle,
    <ScopeEditor scope={view.scope} workspaces={props.workspaces} offLabel={t.scopeOff} onChange={(next) => void run(() => props.onScope(next))} />,
    { placeholder: t.phScope },
  );

  const config = section(
    "config",
    t.configTitle,
    view.config.length === 0 ? (
      <span className="pl-muted">{t.configNone}</span>
    ) : draft ? (
      // 草稿还没装，没有地方存值：只列出它会问你什么，装上之后再填
      <ul className="pl-list">
        {view.config.map((state) => (
          <li key={state.field.key}>
            <b>{state.field.title}</b>
            {state.field.description !== "" && <small> {state.field.description}</small>}
          </li>
        ))}
      </ul>
    ) : (
      <div className="pl-form">
        {view.config.map((state) => (
          <ConfigField
            key={state.field.key}
            state={state}
            onSave={async (value) => {
              await api.plugin.setConfig(pluginName, state.field.key, value);
              await props.onChanged();
            }}
          />
        ))}
      </div>
    ),
    { placeholder: t.phConfig },
  );

  const sourceCard = section(
    "source",
    t.sourceTitle,
    <>
      <dl className="pl-kv">
        {view.version !== null && (
          <>
            <dt>{t.kvVersion}</dt>
            <dd className="mono">{view.version}</dd>
          </>
        )}
        <dt>{t.kvSource}</dt>
        <dd>{sourceLine(view, t, sourceLabel)}</dd>
        {view.install?.source.kind === "git" && (
          <>
            <dt>{t.kvCommit}</dt>
            <dd className="mono">{view.install.source.commit.slice(0, 12)}</dd>
          </>
        )}
        {view.install !== null && (
          <>
            <dt>{t.kvInstalled}</dt>
            <dd>{DATE.format(view.install.installedAt)}</dd>
            <dt>{t.kvUpdates}</dt>
            <dd>{builtin ? t.kvUpdatesBuiltin : t.kvUpdatesValue}</dd>
          </>
        )}
      </dl>
      {view.location !== null && view.install === null && <span className="pl-code">{view.location}</span>}
      {/* 链接安装的根就是来源那一行的路径，不再重复一遍 */}
      {view.install !== null && view.install.source.kind !== "link" && <span className="pl-code">{view.install.root}</span>}
    </>,
    { placeholder: t.phSource },
  );

  const problemsCard =
    view.problems.length > 0 ? (
      <section className="pl-card" data-sec="problems">
        <div className="pl-card-h">{t.problemsTitle}</div>
        <ul className="pl-list">
          {view.problems.map((problem, index) => (
            <li key={index}>{problemText(t, problem)}</li>
          ))}
        </ul>
      </section>
    ) : null;

  // 打开文件夹 / 重新载入 / 卸载：宽的时候在头部右侧，窄的时候收成末尾一张卡（CSS 二选一）
  const actionButtons = (
    <>
      {isPlugin && !draft && (
        <>
          <button type="button" className="pl-btn" onClick={() => void run(() => api.plugin.reveal(pluginName))}>
            <Icon name="folder-open" size={13} strokeWidth={1.8} />
            {t.openFolder}
          </button>
          <button
            type="button"
            className="pl-btn"
            title={t.reloadTip}
            disabled={busy !== null}
            onClick={() =>
              void run(async () => {
                setBusy("reload");
                setReloaded(false);
                try {
                  await api.plugin.reload();
                  await props.onChanged();
                  setReloaded(true);
                } finally {
                  setBusy(null);
                }
              })
            }
          >
            <Icon name="refresh-cw" size={13} strokeWidth={1.8} />
            {busy === "reload" ? t.reloading : reloaded ? t.reloaded : t.reload}
          </button>
          {!builtin && (
            <button type="button" className="pl-btn danger" disabled={busy !== null} onClick={() => setConfirming(true)}>
              <Icon name="trash-2" size={13} strokeWidth={1.8} />
              {t.uninstall}
            </button>
          )}
        </>
      )}
      {view.origin === "user-skill" && (
        <button type="button" className="pl-btn" onClick={() => void run(() => api.skill.reveal(parsed?.key ?? null))}>
          <Icon name="folder-open" size={13} strokeWidth={1.8} />
          {t.openFolder}
        </button>
      )}
      {view.origin === "user-mcp" && (
        <button type="button" className="pl-btn" onClick={() => void run(() => api.mcp.openConfig())}>
          <Icon name="file-text" size={13} strokeWidth={1.8} />
          {t.openMcpConfig}
        </button>
      )}
    </>
  );
  const hasActions = !draft;

  return (
    <div className="pl-detail" data-draft={draft ? "true" : undefined}>
      {props.showBack && (
        <button type="button" className="pl-back" onClick={props.onBack}>
          <Icon name="chevron-left" size={14} strokeWidth={1.8} />
          {t.backToInstalled}
        </button>
      )}

      <div className="pl-hero">
        <PluginAvatar view={view} big />
        <div className="pl-hero-main">
          <div className="pl-title">{view.name}</div>
          <div className="pl-by">{by.join(" · ")}</div>
          {view.description !== "" ? (
            // 描述原文常常几百字（技能的触发词清单）：默认三行，点一下展开——简洁为默认、细节可展开
            <button type="button" className="pl-lead" aria-expanded={leadOpen} data-open={leadOpen} onClick={() => setLeadOpen((open) => !open)}>
              {view.description}
            </button>
          ) : (
            draft && <p className="pl-lead pl-ph-text">{t.phLead}</p>
          )}
        </div>
        {hasActions && <span className="pl-acts pl-acts-hero">{actionButtons}</span>}
      </div>

      {confirming && (
        <div className="pl-note danger" role="alertdialog" aria-label={t.uninstall}>
          <Icon name="triangle-alert" size={14} strokeWidth={1.8} />
          <div style={{ display: "grid", gap: "var(--space-2)" }}>
            <span>{linked ? t.uninstallConfirmLink(view.name) : t.uninstallConfirm(view.name)}</span>
            <span style={{ display: "flex", gap: "var(--space-2)" }}>
              <button
                type="button"
                className="pl-btn danger"
                disabled={busy !== null}
                onClick={() =>
                  void run(async () => {
                    setBusy("uninstall");
                    try {
                      await api.plugin.uninstall(pluginName);
                      await props.onChanged();
                      props.onUninstalled();
                    } finally {
                      setBusy(null);
                      setConfirming(false);
                    }
                  })
                }
              >
                {busy === "uninstall" ? t.uninstalling : t.uninstallAction}
              </button>
              <button type="button" className="pl-btn" onClick={() => setConfirming(false)}>
                {messages.common.cancel}
              </button>
            </span>
          </div>
        </div>
      )}

      {error !== null && (
        <div className="pl-note danger" role="alert">
          <Icon name="triangle-alert" size={14} strokeWidth={1.8} />
          <span>{error}</span>
        </div>
      )}

      {view.origin !== "plugin" && (
        <div className="pl-note">
          <Icon name="info" size={14} strokeWidth={1.8} />
          <span>{view.origin === "user-skill" ? t.legacySkillNote : t.legacyMcpNote}</span>
        </div>
      )}

      {view.conflicts.length > 0 && (
        <div className="pl-note warn" role="alert">
          <Icon name="triangle-alert" size={14} strokeWidth={1.8} />
          <div style={{ display: "grid", gap: "var(--space-1)" }}>
            <b>{t.conflictsTitle}</b>
            {view.conflicts.map((conflict, index) => (
              <span key={index}>{conflictText(t, conflict)}</span>
            ))}
          </div>
        </div>
      )}

      {builtin && (
        <div className="pl-note">
          <Icon name="info" size={14} strokeWidth={1.8} />
          <span>{t.builtinNote}</span>
        </div>
      )}

      {/* 两列（宽）：左 能做什么 / 输入与输出 / 工作流，右 装在哪 / 要你填的 / 来源与版本，看板样式跨两列放最下；
          单列（窄）：.pl-cols / .pl-col 退成 display: contents，各节按 order 重排（plugins.css） */}
      <div className="pl-cols">
        <div className="pl-col">
          {abilities}
          {io}
          {workflow}
        </div>
        <div className="pl-col">
          {scope}
          {config}
          {sourceCard}
          {problemsCard}
        </div>
      </div>
      {board}

      {hasActions && (
        <section className="pl-card pl-acts-card" data-sec="actions">
          <div className="pl-card-h">{t.actionsTitle}</div>
          <div className="pl-acts">{actionButtons}</div>
        </section>
      )}
    </div>
  );
}

function sourceLine(view: PluginView, t: ReturnType<typeof useT>["plugins"], fallback: string): string {
  const source = view.install?.source;
  if (source === undefined) return fallback;
  if (source.kind === "copy") return t.sourceCopyLine(source.from);
  if (source.kind === "link") return t.sourceLinkLine(source.path);
  if (source.kind === "builtin") return fallback;
  return t.sourceGitLine(source.url);
}
