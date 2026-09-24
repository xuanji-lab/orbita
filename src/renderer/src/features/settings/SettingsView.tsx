import "./settings-view.css";
import { useEffect, useState } from "react";
import { api } from "../../api";
import { Chip } from "../../shell/Chip";
import { Icon, type IconName } from "../../shell/Icon";
import { Menu } from "../../shell/Menu";
import type { MenuItem } from "../../shell/Menu";
import { PanelButton } from "../../shell/RightPanel";
import type { ProviderDto } from "@shared/provider";
import type { Workspace } from "@shared/workspace";
import { CompactViz } from "./CompactViz";
import { COMPACTION_CHOICES } from "./compact-viz.ts";
import { MigrationView } from "./MigrationView";
import { ProvidersView } from "./ProvidersView";
import { ThemePicker } from "./ThemeCard";
import { modelMenuItems, useBuiltinCatalog, usableProviders } from "./model-menu";
import {
  COMPACTION_DEFAULT,
  type AppSettings,
  type CompactionSetting,
  type SettingsPatch,
} from "@shared/settings";
import { THINKING_LEVELS, thinkingLevelLabel } from "@shared/thinking";
import { defaultThinkingLevel } from "@shared/model-defaults";
import { modelThinkingLevels } from "../chat/thinking-choice.ts";

/**
 * 设置面。**它不是弹窗，是内容面的另一种内容**——tab 列表浮在侧栏上（透明、无面），
 * 右边还是同一张 `.pane`，同一个宽度、同一套宽度变化。这样设置与聊天是同一个壳，
 * 不是叠在壳上的另一层。
 */
export const SETTINGS_TABS = [
  { id: "general", label: "General", icon: "sliders" },
  { id: "providers", label: "Providers", icon: "cpu" },
  { id: "migration", label: "Migration", icon: "download" },
] as const satisfies readonly { id: string; label: string; icon: IconName }[];

export type SettingsTab = (typeof SETTINGS_TABS)[number]["id"];

export function SettingsView(props: {
  tab: SettingsTab;
  settings: AppSettings;
  /** 全部厂商（含没填 key 的）；命名模型菜单自己过 usableProviders */
  providers: readonly ProviderDto[];
  onSettingsChange: (patch: SettingsPatch) => void;
  onProvidersChange: () => void;
  /** 导入落地后主界面两张列表（会话/工作区）要重读 */
  onImported: () => void;
  /** 既有工作区（Migration 的去向菜单列它们） */
  workspaces: readonly Workspace[];
  /** 切 tab（Migration 的「Set up providers」跳到 Providers） */
  onTab: (tab: SettingsTab) => void;
}) {
  const active = SETTINGS_TABS.find((t) => t.id === props.tab) ?? SETTINGS_TABS[0];
  return (
    <div
      style={{
        height: "100%",
        minHeight: 0,
        display: "grid",
        gridTemplateRows: "auto minmax(0,1fr)",
      }}
    >
      {/* 与聊天页同一个页头形状——同一张卡，页头就该长一样，拖拽区也一样 */}
      <header
        className="titlebar"
        style={{
          display: "flex",
          alignItems: "center",
          minWidth: 0,
          height: 30,
          padding: "12px 18px",
          boxSizing: "content-box",
          borderBottom: "1px solid var(--color-border-subtle)",
        }}
      >
        <strong style={{ fontSize: "var(--font-size-title)", fontWeight: "var(--weight-bold)" }}>
          {active.label}
        </strong>
      </header>

      {props.tab === "migration" ? (
        // Migration 自带滚动区与底栏（Import 在底栏，不随内容滚走），占住第二行整格
        <MigrationView
          workspaces={props.workspaces}
          onImported={props.onImported}
          onOpenProviders={() => props.onTab("providers")}
        />
      ) : (
        <div className="scroll" style={{ minHeight: 0, padding: "var(--space-6) var(--space-5)" }}>
          <div style={{ width: "min(100%, var(--content-max-width))", height: "100%", margin: "0 auto" }}>
            {props.tab === "general" ? (
              <General settings={props.settings} providers={props.providers} onChange={props.onSettingsChange} />
            ) : (
              <ProvidersView onChange={props.onProvidersChange} />
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * 「退回继承」菜单的公共形状：Title model / Sub-session model 的模型与思考档
 * 三处菜单都是「第一项退回上游（session 或 parent）、其后是具体可选值」——集合与文案
 * 各不相同，但「fallback 项 + 选中态 + null 清除」这段接线相同，抽出来避免三处重复。
 */
function withInheritedFirst(
  fallback: { id: string; label: string; hint: string; inherited: boolean; onSelect: () => void },
  items: MenuItem[],
): MenuItem[] {
  return [
    {
      id: fallback.id,
      label: fallback.label,
      hint: fallback.hint,
      checked: fallback.inherited,
      onSelect: fallback.onSelect,
    },
    ...items,
  ];
}

function General(props: {
  settings: AppSettings;
  providers: readonly ProviderDto[];
  onChange: (patch: SettingsPatch) => void;
}) {
  // 缺席 = 出厂默认：解析层只管坏值回默认，UI 的选中态要自己兜这一层
  const compaction = props.settings.compaction ?? COMPACTION_DEFAULT;
  const setCompaction = (next: CompactionSetting) => props.onChange({ compaction: next });
  // 同理：缺席 = 开启，UI 要把这一层兜回来，否则新用户看到的是 Off、实际在签名
  const gitAttribution = props.settings.gitAttribution ?? true;

  const catalog = useBuiltinCatalog();
  const usable = usableProviders(props.providers);

  const titleModel = props.settings.titleModel;
  const titleModelItems: MenuItem[] = withInheritedFirst(
    {
      id: "same-as-session",
      label: "Same as session",
      hint: "Use whichever model the task is running",
      inherited: titleModel === undefined,
      // null 而不是 undefined：补丁里的 undefined 是「这个键没改」，选不回默认
      onSelect: () => props.onChange({ titleModel: null }),
    },
    modelMenuItems({
      providers: usable,
      catalog,
      selected: titleModel ?? null,
      onSelect: (providerId, modelId) => props.onChange({ titleModel: { providerId, modelId } }),
    }),
  );

  // 子会话的默认模型：同 titleModel 的「继承 + null 清除」语义，退回点是父会话而不是命名会话。
  // 换模型 = 思考档回到新模型的默认档（shared 的 settings.ts 契约：subSessionThinking
  // 绑定 subSessionModel，脱离模型单独存一档是假选项），所以两个字段一起改
  const subSessionModel = props.settings.subSessionModel;
  const subSessionModelItems: MenuItem[] = withInheritedFirst(
    {
      id: "same-as-parent",
      label: "Same as parent",
      hint: "Use the model the delegating task is running",
      inherited: subSessionModel === undefined,
      onSelect: () => props.onChange({ subSessionModel: null, subSessionThinking: null }),
    },
    modelMenuItems({
      providers: usable,
      catalog,
      selected: subSessionModel ?? null,
      onSelect: (providerId, modelId) =>
        props.onChange({ subSessionModel: { providerId, modelId }, subSessionThinking: null }),
    }),
  );

  // 子会话的默认思考档：**绑定 subSessionModel**——模型是 Same as parent 时没有
  // 型号可算支持集或默认档，这一档没有意义（不渲染思考档芯片）；指定了模型才按这个
  // 型号的真实支持集（未知就全量词汇表兜底）展开，首项是这个型号的默认档
  const subSessionThinking = props.settings.subSessionThinking;
  const subSessionThinkingModel =
    subSessionModel === undefined
      ? null
      : (() => {
          const supported = modelThinkingLevels(subSessionModel.modelId, catalog);
          return {
            modelId: subSessionModel.modelId,
            supported,
            fallback: defaultThinkingLevel(subSessionModel.modelId, supported),
          };
        })();
  const subSessionThinkingItems: MenuItem[] =
    subSessionThinkingModel === null
      ? []
      : withInheritedFirst(
          {
            id: "model-default",
            label: "Model default",
            hint: thinkingLevelLabel(subSessionThinkingModel.fallback, subSessionThinkingModel.modelId),
            inherited: subSessionThinking === undefined,
            onSelect: () => props.onChange({ subSessionThinking: null }),
          },
          (subSessionThinkingModel.supported ?? THINKING_LEVELS).map((level) => ({
            id: level,
            label: thinkingLevelLabel(level, subSessionThinkingModel.modelId),
            checked: subSessionThinking === level,
            onSelect: () => props.onChange({ subSessionThinking: level }),
          })),
        );

  return (
    <div style={{ display: "grid", gap: "var(--space-6)", alignContent: "start" }}>
      <Section label="Appearance">
        <Row
          name="Theme"
          hint="System follows your desktop's light or dark appearance and lands on Ink; Warm and Ink are manual."
          layout="stack"
          control={<ThemePicker value={props.settings.theme} onChange={props.onChange} />}
        />
      </Section>
      <Section label="Context">
        <Row
          name="Auto-compact"
          hint="Fold older history into a summary once remaining context drops to this level. Off keeps manual /compact only. Applies from the next message."
          control={
            <span style={{ display: "grid", gap: "var(--space-2)" }}>
              <span style={{ display: "flex", gap: 2, flexWrap: "wrap" }}>
                <Chip
                  active={compaction.enabled === false}
                  onClick={() => setCompaction({ ...compaction, enabled: false })}
                >
                  Off
                </Chip>
                {COMPACTION_CHOICES.map((value) => (
                  <Chip
                    key={value}
                    active={compaction.enabled !== false && compaction.reservePercent === value}
                    onClick={() => setCompaction({ enabled: true, reservePercent: value })}
                  >
                    {value}%
                  </Chip>
                ))}
              </span>
              {/* Off 时整条可视化不渲染（条件渲染，不是隐藏）——没有数值可画 */}
              {compaction.enabled !== false && <CompactViz percent={compaction.reservePercent} />}
            </span>
          }
        />
      </Section>
      <Section label="Git">
        <Row
          name="Commit & PR attribution"
          hint="Adds a Made-with: Orbita trailer to commits the agent writes for you, and a Made with Orbita line to pull request descriptions. Never sets Co-Authored-By or changes the author."
          control={
            /* 设计系统里没有 Switch，开关就用两个 Chip——与 Auto-compact 的 Off 同一个形状 */
            <span style={{ display: "flex", gap: 2 }}>
              <Chip active={gitAttribution} onClick={() => props.onChange({ gitAttribution: true })}>
                On
              </Chip>
              <Chip
                active={!gitAttribution}
                onClick={() => props.onChange({ gitAttribution: false })}
              >
                Off
              </Chip>
            </span>
          }
        />
      </Section>
      <Section label="Sessions">
        <Row
          name="Title model"
          hint="Names a task from its first message. It's one small call — a fast, cheap model does it well. Applies to tasks named from now on."
          control={
            /* 触发芯片不带图标：跟底栏的模型芯片同形，模型 id 本身就是内容 */
            <Menu
              items={titleModelItems}
              searchable
              trigger={({ open, toggle }) => (
                <Chip
                  active={open}
                  title={
                    titleModel === undefined
                      ? "Titles use the model the task is running"
                      : `${titleModel.providerId} · ${titleModel.modelId}`
                  }
                  onClick={toggle}
                  chevron
                >
                  {titleModel?.modelId ?? "Same as session"}
                </Chip>
              )}
            />
          }
        />
        <Row
          name="Sub-session model"
          hint="Model and thinking level for sub-sessions a task delegates to. Thinking follows the model: Default is the level its vendor recommends. The agent can still pick either per delegation."
          control={
            /* 模型与思考档一行：思考档是模型的属性（档位集与默认档都随型号变），所以先有
               模型芯片、选了具体模型才长出思考档芯片。Same as parent 时思考档跟父走，
               不放一个置灰的芯片占位——没有可选的东西就不画控件 */
            <span style={{ display: "flex", alignItems: "center", gap: 2 }}>
              <Menu
                items={subSessionModelItems}
                searchable
                trigger={({ open, toggle }) => (
                  <Chip
                    active={open}
                    title={
                      subSessionModel === undefined
                        ? "Sub-sessions use the model and thinking level of the delegating task"
                        : `${subSessionModel.providerId} · ${subSessionModel.modelId}`
                    }
                    onClick={toggle}
                    chevron
                  >
                    {subSessionModel?.modelId ?? "Same as parent"}
                  </Chip>
                )}
              />
              {subSessionThinkingModel !== null && (
                <Menu
                  items={subSessionThinkingItems}
                  panelMinWidth={112}
                  trigger={({ open, toggle }) => (
                    <Chip
                      active={open}
                      title={`Thinking level for ${subSessionThinkingModel.modelId}`}
                      onClick={toggle}
                      chevron
                    >
                      {subSessionThinking === undefined
                        ? `Default · ${thinkingLevelLabel(subSessionThinkingModel.fallback, subSessionThinkingModel.modelId)}`
                        : thinkingLevelLabel(subSessionThinking, subSessionThinkingModel.modelId)}
                    </Chip>
                  )}
                />
              )}
            </span>
          }
        />
      </Section>
      <Section label="Data">
        <DataDirectoryRow />
      </Section>
    </div>
  );
}

/** 分组标题与侧栏的节点标题同一个处理：mono、micro、大写加字距（`.section-label`，Migration 同用） */
function Section(props: { label: string; children: React.ReactNode }) {
  return (
    <section style={{ display: "grid", gap: "var(--space-1)" }}>
      <span className="section-label">{props.label}</span>
      {props.children}
    </section>
  );
}

/**
 * 一条设置。**直接坐在内容面上，靠发丝线分隔，不套第二张卡**——
 * 玻璃已经分了三层，再加一层只会把层级讲糊。
 *
 * `layout="stack"`：name+hint 在上、control 独占下面一整行（Theme 预览卡组用）——
 * 单列 grid 天然让两个直接子项上下排，不用给 control 单独开分支。默认 `"row"`
 * 还是原来的左右两栏。只加这一个可选项，别把整个组件改成只适配某一行。
 */
function Row(props: {
  name: string;
  hint: string;
  control: React.ReactNode;
  layout?: "row" | "stack";
}) {
  const stack = props.layout === "stack";
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: stack ? "1fr" : "minmax(0,1fr) auto",
        alignItems: stack ? "start" : "center",
        gap: stack ? "var(--space-3)" : "var(--space-4)",
        minHeight: "var(--list-item-rich)",
        padding: "var(--space-3) 0",
        borderBottom: "1px solid var(--color-border-subtle)",
      }}
    >
      <RowCopy name={props.name} hint={props.hint} />
      {props.control}
    </div>
  );
}

/** 行的左半：名字 + 说明，`note` 是说明下方可选的一行状态。Row 与 DataDirectoryRow 共用 */
function RowCopy(props: { name: string; hint: string; note?: React.ReactNode }) {
  return (
    <span style={{ display: "grid", gap: 2, minWidth: 0 }}>
      <span style={{ fontSize: "var(--font-size-control)", fontWeight: "var(--weight-medium)" }}>
        {props.name}
      </span>
      <span
        style={{
          fontSize: "var(--font-size-caption)",
          lineHeight: "var(--line-height-caption)",
          color: "var(--color-text-secondary)",
        }}
      >
        {props.hint}
      </span>
      {props.note}
    </span>
  );
}

/**
 * Data section 的最后一行：数据目录的绝对路径 + Reveal。不走通用 Row：
 * 路径是全页唯一可能比说明还宽的 control——Row 的 control 列是 `auto`，
 * 放进去窗口一窄就先把说明挤没。这里说明列保底 240px，窄了先截路径。
 * 是 Data section 最后一行，照设计稿去掉底部发丝线。
 */
function DataDirectoryRow() {
  const [dir, setDir] = useState<
    { kind: "loading" } | { kind: "ready"; path: string } | { kind: "error" }
  >({ kind: "loading" });
  // Reveal 失败原因；成功一次就清掉，不用「上一次失败」压住这一次成功
  const [revealError, setRevealError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void api.settings
      .dataDir()
      .then((path) => {
        if (!cancelled) setDir({ kind: "ready", path });
      })
      .catch(() => {
        if (!cancelled) setDir({ kind: "error" });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const reveal = () => {
    void api.settings
      .revealDataDir()
      .then(() => setRevealError(null))
      .catch((cause: unknown) =>
        setRevealError(cause instanceof Error ? cause.message : String(cause)),
      );
  };

  return (
    <div
      style={{
        display: "grid",
        // 控件列最小是 0：列宽不够时路径（overflow:hidden，自动最小宽为 0）跟着收窄
        gridTemplateColumns: "minmax(240px,1fr) minmax(0,auto)",
        alignItems: "center",
        gap: "var(--space-4)",
        minHeight: "var(--list-item-rich)",
        padding: "var(--space-3) 0",
      }}
    >
      <RowCopy
        name="Data directory"
        hint="Sessions, workspaces, skills and mcp.json live here as plain files."
        note={
          revealError !== null && (
            <span role="alert" style={{ fontSize: "var(--font-size-caption)", color: "var(--color-danger)" }}>
              {revealError}
            </span>
          )
        }
      />
      <span
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "flex-end",
          gap: "var(--space-2)",
          minWidth: 0,
        }}
      >
        {dir.kind === "ready" && (
          // 路径很长，从左边截断让末段（真正区分不同机器的那一截）留在视野里；
          // 取到之前不渲染，免得先闪一下 "undefined"。bdi 见 .data-dir-path 的注释
          <code className="data-dir-path" title={dir.path}>
            <bdi dir="ltr">{dir.path}</bdi>
          </code>
        )}
        {dir.kind === "error" && <code className="data-dir-path-unavailable">Unavailable</code>}
        <PanelButton onClick={reveal} title="Open the data directory">
          <Icon name="folder" size={14} /> Reveal
        </PanelButton>
      </span>
    </div>
  );
}
