import "./settings-view.css";
import { Chip } from "../../shell/Chip";
import type { IconName } from "../../shell/Icon";
import { Menu } from "../../shell/Menu";
import type { MenuItem } from "../../shell/Menu";
import type { ProviderDto } from "@shared/provider";
import { CompactViz } from "./CompactViz";
import { COMPACTION_CHOICES } from "./compact-viz.ts";
import { ImportPromaRow } from "./ImportPromaRow";
import { ProvidersView } from "./ProvidersView";
import { ThemePicker } from "./ThemeCard";
import { modelMenuItems, useBuiltinCatalog, usableProviders } from "./model-menu";
import {
  COMPACTION_DEFAULT,
  type AppSettings,
  type CompactionSetting,
  type SettingsPatch,
} from "@shared/settings";
import { THINKING_LEVELS, THINKING_LEVEL_LABELS } from "@shared/thinking";

/**
 * 设置面。**它不是弹窗，是内容面的另一种内容**——tab 列表浮在侧栏上（透明、无面），
 * 右边还是同一张 `.pane`，同一个宽度、同一套宽度变化。这样设置与聊天是同一个壳，
 * 不是叠在壳上的另一层。
 */
export const SETTINGS_TABS = [
  { id: "general", label: "General", icon: "sliders" },
  { id: "providers", label: "Providers", icon: "cpu" },
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

      <div className="scroll" style={{ minHeight: 0, padding: "var(--space-6) var(--space-5)" }}>
        <div style={{ width: "min(100%, var(--content-max-width))", height: "100%", margin: "0 auto" }}>
          {props.tab === "general" ? (
            <General
              settings={props.settings}
              providers={props.providers}
              onChange={props.onSettingsChange}
              onImported={props.onImported}
            />
          ) : (
            <ProvidersView onChange={props.onProvidersChange} />
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * 「退回继承」菜单的公共形状：Title model / Sub-session model / Sub-session thinking
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
  onImported: () => void;
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

  // 子会话的默认模型：同 titleModel 的「继承 + null 清除」语义，退回点是父会话而不是命名会话
  const subSessionModel = props.settings.subSessionModel;
  const subSessionModelItems: MenuItem[] = withInheritedFirst(
    {
      id: "same-as-parent",
      label: "Same as parent",
      hint: "Use the model the delegating task is running",
      inherited: subSessionModel === undefined,
      onSelect: () => props.onChange({ subSessionModel: null }),
    },
    modelMenuItems({
      providers: usable,
      catalog,
      selected: subSessionModel ?? null,
      onSelect: (providerId, modelId) => props.onChange({ subSessionModel: { providerId, modelId } }),
    }),
  );

  // 子会话的默认思考档：菜单集合来自词汇表全量（THINKING_LEVELS），不按某个模型的
  // 支持集裁剪——这里选的是「派出时的默认值」，还不知道子会话最终落在哪个模型上
  const subSessionThinking = props.settings.subSessionThinking;
  const subSessionThinkingItems: MenuItem[] = withInheritedFirst(
    {
      id: "same-as-parent",
      label: "Same as parent",
      hint: "Use the thinking level the delegating task is running",
      inherited: subSessionThinking === undefined,
      onSelect: () => props.onChange({ subSessionThinking: null }),
    },
    THINKING_LEVELS.map((level) => ({
      id: level,
      label: THINKING_LEVEL_LABELS[level].label,
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
          hint="Default model for sub-sessions a task delegates to. The agent can still pick a model per delegation."
          control={
            <Menu
              items={subSessionModelItems}
              searchable
              trigger={({ open, toggle }) => (
                <Chip
                  active={open}
                  title={
                    subSessionModel === undefined
                      ? "Sub-sessions use the model the delegating task is running"
                      : `${subSessionModel.providerId} · ${subSessionModel.modelId}`
                  }
                  onClick={toggle}
                  chevron
                >
                  {subSessionModel?.modelId ?? "Same as parent"}
                </Chip>
              )}
            />
          }
        />
        <Row
          name="Sub-session thinking"
          hint="Default thinking level for sub-sessions a task delegates to. The agent can still pick a level per delegation."
          control={
            <Menu
              items={subSessionThinkingItems}
              panelMinWidth={112}
              trigger={({ open, toggle }) => (
                <Chip
                  active={open}
                  title={
                    subSessionThinking === undefined
                      ? "Sub-sessions use the thinking level the delegating task is running"
                      : THINKING_LEVEL_LABELS[subSessionThinking].label
                  }
                  onClick={toggle}
                  chevron
                >
                  {subSessionThinking === undefined
                    ? "Same as parent"
                    : THINKING_LEVEL_LABELS[subSessionThinking].label}
                </Chip>
              )}
            />
          }
        />
      </Section>
      <Section label="Data">
        {/* 导入入口自带行卡样式（按钮组 + 汇总多行），不走通用 Row */}
        <ImportPromaRow onImported={props.onImported} />
      </Section>
    </div>
  );
}

/** 分组标题与侧栏的节点标题同一个处理：mono、micro、大写加字距 */
function Section(props: { label: string; children: React.ReactNode }) {
  return (
    <section style={{ display: "grid", gap: "var(--space-1)" }}>
      <span
        style={{
          fontFamily: "var(--font-family-business)",
          fontSize: "var(--font-size-micro)",
          letterSpacing: "0.06em",
          textTransform: "uppercase",
          fontWeight: "var(--weight-bold)",
          color: "var(--color-text-secondary)",
        }}
      >
        {props.label}
      </span>
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
      </span>
      {props.control}
    </div>
  );
}
