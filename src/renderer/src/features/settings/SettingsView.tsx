import { Chip } from "../../shell/Chip";
import type { IconName } from "../../shell/Icon";
import { ProvidersView } from "./ProvidersView";
import {
  COMPACTION_DEFAULT,
  THEME_PREFERENCES,
  type AppSettings,
  type CompactionSetting,
  type SettingsPatch,
  type ThemePreference,
} from "@shared/settings";

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
  onSettingsChange: (patch: SettingsPatch) => void;
  onProvidersChange: () => void;
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
            <General settings={props.settings} onChange={props.onSettingsChange} />
          ) : (
            <ProvidersView onChange={props.onProvidersChange} />
          )}
        </div>
      </div>
    </div>
  );
}

const THEME_LABELS: Record<ThemePreference, string> = {
  system: "System",
  light: "Light",
  dark: "Warm",
  black: "Ink",
};

/** 自动压缩的档位（%）。与 shared 的合法区间 [5,50] 对齐，档距是「一眼分得清」的粒度 */
const COMPACTION_CHOICES = [30, 25, 20, 15, 10, 5] as const;

function General(props: { settings: AppSettings; onChange: (patch: SettingsPatch) => void }) {
  // 缺席 = 出厂默认：解析层只管坏值回默认，UI 的选中态要自己兜这一层
  const compaction = props.settings.compaction ?? COMPACTION_DEFAULT;
  const setCompaction = (next: CompactionSetting) => props.onChange({ compaction: next });
  // 同理：缺席 = 开启，UI 要把这一层兜回来，否则新用户看到的是 Off、实际在签名
  const gitAttribution = props.settings.gitAttribution ?? true;
  return (
    <div style={{ display: "grid", gap: "var(--space-6)", alignContent: "start" }}>
      <Section label="Appearance">
        <Row
          name="Theme"
          hint="System follows your desktop's light or dark appearance and lands on Ink; Warm and Ink are manual."
          control={
            <span style={{ display: "flex", gap: 2 }}>
              {THEME_PREFERENCES.map((value) => (
                <Chip
                  key={value}
                  active={props.settings.theme === value}
                  onClick={() => props.onChange({ theme: value })}
                >
                  {THEME_LABELS[value]}
                </Chip>
              ))}
            </span>
          }
        />
      </Section>
      <Section label="Context">
        <Row
          name="Auto-compact"
          hint="Fold older history into a summary once remaining context drops to this level. Off keeps manual /compact only. Applies from the next message."
          control={
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
 */
function Row(props: { name: string; hint: string; control: React.ReactNode }) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "minmax(0,1fr) auto",
        alignItems: "center",
        gap: "var(--space-4)",
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
