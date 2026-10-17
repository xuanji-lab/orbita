import "./settings-view.css";
import { useEffect, useRef, useState } from "react";
import { api } from "../../api";
import { Chip } from "../../shell/Chip";
import { Icon, type IconName } from "../../shell/Icon";
import { Menu } from "../../shell/Menu";
import type { MenuItem } from "../../shell/Menu";
import { PanelButton } from "../../shell/RightPanel";
import type { ProviderDto } from "@shared/provider";
import type {
  BrowserImportedSite,
  BrowserImportReadError,
  BrowserImportSite,
  BrowserImportSource,
  BrowserImportSummary,
} from "@shared/browser";
import type { Workspace } from "@shared/workspace";
import type { DoubaoVoiceConfig, StepfunVoiceConfig, VoiceFailure, DictationProvider, DictationSelection } from "@shared/voice";
import type { ComputerUseProbeResult, SandboxStatus } from "@shared/computer-use";
import { DICTATION_PROVIDERS } from "@shared/voice";
import { CompactViz } from "./CompactViz";
import { COMPACTION_CHOICES } from "./compact-viz.ts";
import {
  probeBlocksStart,
  probeVisual,
  sandboxControl,
  shotFromResult,
  shotMeta,
  statusVisual,
  type ShotView,
} from "./computer-use-view.ts";
import { allShownTicked, importedFirst, setShown } from "./login-sites.ts";
import { formatDay } from "./migration-groups.ts";
import { InfoTip } from "./InfoTip";
import { MigrationView } from "./MigrationView";
import { ProvidersView } from "./ProvidersView";
import { ThemePicker } from "./ThemeCard";
import { EXPERIMENTAL_FEATURES, pullRequestUrl, type ExperimentalFeature } from "../../experimental-features.ts";
import { ModelPickerMenu, useBuiltinCatalog, usableProviders } from "./model-menu";
import {
  COMPACTION_DEFAULT,
  DEFAULT_INTENT_BASE_URL,
  effectiveIntentSettings,
  type AppSettings,
  type CompactionSetting,
  type ExperimentalFeatureId,
  type IntentSettings,
  type SettingsPatch,
} from "@shared/settings";
import type { IntentHealth } from "@shared/intent-lab";
import { intentChannelUnavailable } from "@shared/intent-lab";
import { THINKING_LEVELS } from "@shared/thinking";
import { COMMIT_TRAILER, prAttributionLine } from "@shared/attribution";
import { effectiveLanguage, LANGUAGES, themeLanguage, type Language, type ModelPair } from "@shared/settings";

/** 语言芯片上写各自的自称（English / 中文）：找自己语言的人认的是自称，这两个词不翻译 */
const LANGUAGE_NAMES: Record<Language, string> = { en: "English", zh: "中文" };
import { defaultThinkingLevel } from "@shared/model-defaults";
import { modelThinkingLevels } from "../chat/thinking-choice.ts";
import { useT } from "../../locale.ts";
import { playCompletionChime } from "../notify/chime.ts";

/**
 * 设置面。**它不是弹窗，是内容面的另一种内容**——tab 列表浮在侧栏上（透明、无面），
 * 右边还是同一张 `.pane`，同一个宽度、同一套宽度变化。这样设置与聊天是同一个壳，
 * 不是叠在壳上的另一层。
 */
export const SETTINGS_TABS = [
  { id: "general", icon: "sliders" },
  { id: "providers", icon: "cpu" },
  { id: "migration", icon: "download" },
  { id: "browser", icon: "globe" },
  { id: "voice", icon: "mic" },
  { id: "computer-use", icon: "monitor" },
  { id: "experimental", icon: "flask-conical" },
] as const satisfies readonly { id: string; icon: IconName }[];

export type SettingsTab = (typeof SETTINGS_TABS)[number]["id"];

export function SettingsView(props: {
  tab: SettingsTab;
  settings: AppSettings;
  /** 全部厂商（含没填 key 的）；命名模型菜单自己过 usableProviders */
  providers: readonly ProviderDto[];
  /** 星标过的模型：设置面的两个模型卡片也有那颗星（与输入卡、会话行同一套） */
  starredModels: readonly ModelPair[];
  onToggleStarModel: (pair: ModelPair) => void;
  onSettingsChange: (patch: SettingsPatch) => void;
  onProvidersChange: () => void;
  /** 导入落地后主界面两张列表（会话/工作区）要重读 */
  onImported: () => void;
  /** 既有工作区（Migration 的去向菜单列它们） */
  workspaces: readonly Workspace[];
  /** 切 tab（Migration 的「Set up providers」跳到 Providers） */
  onTab: (tab: SettingsTab) => void;
}) {
  const t = useT();
  /** 实验功能「电脑使用」（设置原值）：关着时侧栏导航与这一页的内容都藏起来。
   *  正常操作进不到这个门：App 的 settingsTab 只由侧栏导航行改写，导航行已过滤。
   *  这里再拦一道是兼容盘上手改 settings.json 的情形——页头与内容各自退回通用页。 */
  const computerUse = props.settings.experimentalFeatures?.["computer-use"] === true;
  const active =
    SETTINGS_TABS.find((tab) => tab.id === props.tab && (tab.id !== "computer-use" || computerUse)) ??
    SETTINGS_TABS[0];
  /**
   * Migration 的状态（扫描结果、勾选、去向）**跨 tab 保留**：用户为了三步清单要跳去
   * Providers / General 再回来，每次回来都重扫就又回到「懵逼」（wafo 2026-09-28）。
   * 做法：第一次进迁移页后保持挂载、切走时 display:none（扫描计划已与模型无关，
   * 保留是安全的）。设置面整个关掉时照旧卸载。
   */
  const [migrationVisited, setMigrationVisited] = useState(props.tab === "migration");
  if (props.tab === "migration" && !migrationVisited) setMigrationVisited(true);
  /** 跳去 General 时高亮家务活模型行（一次性的信号，General 消费后清掉） */
  const [highlightChore, setHighlightChore] = useState(false);
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
          // 页头 48（含 1px 底线）：与右栏标题行（.panel-head）同高，两边底线连成一条
          height: 48,
          padding: "0 18px",
          boxSizing: "border-box",
          borderBottom: "1px solid var(--color-border-subtle)",
        }}
      >
        <strong style={{ fontSize: "var(--font-size-lg)", fontWeight: "var(--weight-bold)" }}>
          {t.settings.tabs[active.id]}
        </strong>
      </header>

      {migrationVisited ? (
        // Migration 自带滚动区与底栏（Import 在底栏，不随内容滚走），占住第二行整格；
        // 切走只是藏起来——扫描结果与勾选都还在（见上面 migrationVisited 的注释）。
        // 显示时包装层必须是 display: contents：MigrationView 的根靠「自己就是第二行的
        // grid 项」被拉伸到有限高度，内部滚动区才滚得动、底栏才贴底；包一层普通块级 div
        // 它就按内容长高、被面板裁掉——整页滚不动、底栏消失（wafo 2026-09-28 验收发现）
        <div
          hidden={props.tab !== "migration"}
          style={{ display: props.tab === "migration" ? "contents" : "none" }}
        >
          <MigrationView
            workspaces={props.workspaces}
            providers={props.providers}
            choreModel={props.settings.choreModel}
            onImported={props.onImported}
            onOpenProviders={() => props.onTab("providers")}
            onOpenGeneral={() => {
              setHighlightChore(true);
              props.onTab("general");
            }}
          />
        </div>
      ) : null}
      {props.tab === "browser" ? (
        <div className="scroll" style={{ minHeight: 0, padding: "var(--space-6) var(--space-5)" }}>
          <BrowserSettings />
        </div>
      ) : props.tab === "voice" ? (
        <div className="scroll" style={{ minHeight: 0, padding: "var(--space-6) var(--space-5)" }}>
          <VoiceSettings />
        </div>
      ) : props.tab === "computer-use" && computerUse ? (
        <div className="scroll" style={{ minHeight: 0, padding: "var(--space-6) var(--space-5)" }}>
          <ComputerUseView />
        </div>
      ) : props.tab === "experimental" ? (
        // 实验功能独立成 Tab（2026-10 用户裁决）：总开关与功能清单都住这里，通用页不再出现
        <div className="scroll" style={{ minHeight: 0, padding: "var(--space-6) var(--space-5)" }}>
          <ExperimentalSettings settings={props.settings} onChange={props.onSettingsChange} />
        </div>
      ) : props.tab === "providers" ? (
        // 模型服务铺满内容面：卡片墙 / 详情页自己内部滚动
        <ProvidersView
          onChange={props.onProvidersChange}
          onSessionsChanged={props.onImported}
          cardSize={props.settings.providerCardSize ?? "large"}
          onCardSize={(providerCardSize) => props.onSettingsChange({ providerCardSize })}
        />
      ) : props.tab === "migration" ? null : (
        <div className="scroll" style={{ minHeight: 0, padding: "var(--space-6) var(--space-5)" }}>
          <General
            settings={props.settings}
            providers={props.providers}
            starredModels={props.starredModels}
            onToggleStarModel={props.onToggleStarModel}
            onChange={props.onSettingsChange}
            highlightChore={highlightChore}
            onHighlightConsumed={() => setHighlightChore(false)}
          />
        </div>
      )}
    </div>
  );
}

/**
 * 「退回继承」菜单的公共形状：Chore model / Sub-session model 的模型与思考档
 * 三处菜单都是「第一项退回上游（session 或 parent）、其后是具体可选值」——集合与文案
 * 各不相同，但「fallback 项 + 选中态 + null 清除」这段接线相同，抽出来避免三处重复。
 */
function withInheritedFirst(
  fallback: InheritedFallback,
  items: MenuItem[],
): MenuItem[] {
  return [inheritedRow(fallback), ...items];
}

/** 同上，只要那一行——模型卡片把它当 `leading` 传进去（卡片自己拿着过滤后的行） */
function inheritedRow(fallback: InheritedFallback): MenuItem {
  return {
    id: fallback.id,
    label: fallback.label,
    /*
     * 说明放哪儿分两档：模型卡片里放主行下面当副行（两行行）——卡片里其余行
     * 都是两行行，而且右端 hint 会把那一行拉得很长、说明还被截断（2026-10-02
     * 用户实测）；思考档菜单都是单行行，说明留在右端 hint。
     */
    ...(fallback.hintBelow === true ? { subLabel: fallback.hint } : { hint: fallback.hint }),
    checked: fallback.inherited,
    onSelect: fallback.onSelect,
  };
}

type InheritedFallback = { id: string; label: string; hint: string; inherited: boolean; onSelect: () => void; hintBelow?: boolean };

function General(props: {
  settings: AppSettings;
  providers: readonly ProviderDto[];
  /** 星标过的模型：设置面的两个模型卡片也有那颗星（与输入卡、会话行同一套） */
  starredModels: readonly ModelPair[];
  onToggleStarModel: (pair: ModelPair) => void;
  onChange: (patch: SettingsPatch) => void;
  /** 迁移页三步清单第②步跳过来时：滚到家务活模型行、短暂高亮、焦点落到选择器 */
  highlightChore?: boolean;
  onHighlightConsumed?: () => void;
}) {
  const t = useT();
  const choreRowRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (props.highlightChore !== true) return;
    const row = choreRowRef.current;
    if (row === null) return;
    row.scrollIntoView({ block: "center" });
    // 焦点落到选择器本体（Chip 是 button）：键盘用户从这一行继续
    row.querySelector("button")?.focus();
    row.dataset.flash = "on";
    // 高亮的收尾听 animationend，不靠计时器；清 data-flash 的同一拍才通知父级
    // 消费完——在 effect 里同步消费会让它立刻重跑、cleanup 把监听拆掉，
    // data-flash 就永远留在行上（动画 1.6s，effect 依赖只有这个布尔）
    const done = (): void => {
      delete row.dataset.flash;
      row.removeEventListener("animationend", done);
      props.onHighlightConsumed?.();
    };
    row.addEventListener("animationend", done);
    return () => row.removeEventListener("animationend", done);
    // 依赖故意只有 highlightChore：onHighlightConsumed 只是 setHighlightChore(false)，
    // 每次渲染新箭头函数，进依赖会让 effect 每帧重挂监听
  }, [props.highlightChore]);
  // 缺席 = 出厂默认：解析层只管坏值回默认，UI 的选中态要自己兜这一层
  const compaction = props.settings.compaction ?? COMPACTION_DEFAULT;
  const setCompaction = (next: CompactionSetting) => props.onChange({ compaction: next });
  // 同理：缺席 = 开启，UI 要把这一层兜回来，否则新用户看到的是 Off、实际在签名
  const gitAttribution = props.settings.gitAttribution ?? true;
  // 同理：缺席 = 折叠（粘贴文本 chip 的出厂形态）
  const pastedCollapse = props.settings.collapsePastedText ?? true;
  // 完成提示音：缺席 = 响（这个提醒的价值在人不在跟前时也成立；只管声音，卡片与未读不受它影响）
  const completionSound = props.settings.completionSound ?? true;

  const catalog = useBuiltinCatalog();
  const usable = usableProviders(props.providers);

  const choreModel = props.settings.choreModel;
  /**
   * 两个模型 picker 都走 `ModelPickerMenu`——与输入卡的模型芯片**同一个卡片**
   * （左栏过滤、两行行、定高六行、宽度按全部模型里最长那一行定、星标同一颗）。
   * 形状分家就是这一刀返工五次的起因，所以三处必须共用同一个外壳（2026-10-01）。
   */
  const choreFallback = inheritedRow({
    id: "same-as-session",
    label: t.settings.sameAsSession,
    hint: t.settings.sameAsSessionHint,
    hintBelow: true,
    inherited: choreModel === undefined,
    // null 而不是 undefined：补丁里的 undefined 是「这个键没改」，选不回默认
    onSelect: () => props.onChange({ choreModel: null }),
  });

  // 子会话的默认模型：同 choreModel 的「继承 + null 清除」语义，退回点是父会话而不是家务活模型。
  // 换模型 = 思考档回到新模型的默认档（shared 的 settings.ts 契约：subSessionThinking
  // 绑定 subSessionModel，脱离模型单独存一档是假选项），所以两个字段一起改
  const subSessionModel = props.settings.subSessionModel;
  const subSessionFallback = inheritedRow({
    id: "same-as-parent",
    label: t.settings.sameAsParent,
    hint: t.settings.sameAsParentHint,
    hintBelow: true,
    inherited: subSessionModel === undefined,
    onSelect: () => props.onChange({ subSessionModel: null, subSessionThinking: null }),
  });

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
            label: t.settings.modelDefault,
            hint: t.thinkingLevel(subSessionThinkingModel.fallback, subSessionThinkingModel.modelId),
            inherited: subSessionThinking === undefined,
            onSelect: () => props.onChange({ subSessionThinking: null }),
          },
          (subSessionThinkingModel.supported ?? THINKING_LEVELS).map((level): MenuItem => ({
            id: level,
            label: t.thinkingLevel(level, subSessionThinkingModel.modelId),
            checked: subSessionThinking === level,
            onSelect: () => props.onChange({ subSessionThinking: level }),
          })),
        );

  // 单语主题定死的语言（null = 双语主题，听设置）；芯片亮的是实际生效的那一门
  const lockedLanguage = themeLanguage(props.settings.theme);
  const shownLanguage = effectiveLanguage(props.settings.theme, props.settings.language);

  return (
    <div className="set-page">
      <SettingGroup label={t.settings.appearance}>
        <SettingRow name={t.settings.theme}>
          <ThemePicker
            value={props.settings.theme}
            paperThemes={props.settings.experimentalFeatures?.["paper-themes"] === true}
            onChange={props.onChange}
          />
        </SettingRow>
        <SettingRow name={t.settings.language} info={t.settings.languageInfo}>
          {/* 单语主题下两个芯片都置灰、亮的是主题定的那门语言，旁边说清为什么——
              设置里存的值不动，切回双语主题就恢复 */}
          <span className="set-chips" role="group" aria-label={t.settings.language}>
            {LANGUAGES.map((language) => (
              <Chip
                key={language}
                active={shownLanguage === language}
                disabled={lockedLanguage !== null}
                onClick={() => props.onChange({ language })}
              >
                {LANGUAGE_NAMES[language]}
              </Chip>
            ))}
          </span>
          {lockedLanguage !== null && (
            <span className="set-row-hint">
              {lockedLanguage === "zh" ? t.settings.languageLockedZh : t.settings.languageLockedEn}
            </span>
          )}
        </SettingRow>
      </SettingGroup>
      {/* 原来的 Context / Git / Sessions 各只有一两行，三个分组标题比内容还显眼；
          它们调的都是「agent 怎么干活」，并成一组（实验开关与功能清单已搬到独立的实验功能 Tab） */}
      <SettingGroup label={t.settings.agent}>
        <SettingRow
          name={t.settings.autoCompact}
          info={
            <>
              {t.settings.autoCompactInfoLead}
              <b>/compact</b>
              {t.settings.autoCompactInfoTail}
            </>
          }
        >
          <span className="set-chips" role="group" aria-label={t.settings.autoCompact}>
            <Chip
              active={compaction.enabled === false}
              onClick={() => setCompaction({ ...compaction, enabled: false })}
            >
              {t.common.off}
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
          {/* Off 时整条可视化不渲染（条件渲染，不是隐藏）——没有折叠点可画 */}
          {compaction.enabled !== false && <CompactViz percent={compaction.reservePercent} />}
        </SettingRow>
        <SettingRow
          name={t.settings.choreModel}
          info={t.settings.choreModelInfo}
          rowRef={choreRowRef}
        >
          {/* 触发芯片不带图标：跟底栏的模型芯片同形，模型 id 本身就是内容 */}
          <ModelPickerMenu
            t={t}
            providers={usable}
            catalog={catalog}
            selected={choreModel ?? null}
            starred={props.starredModels}
            onToggleStar={props.onToggleStarModel}
            onSelect={(providerId, modelId) => props.onChange({ choreModel: { providerId, modelId } })}
            leading={[choreFallback]}
            trigger={({ open, toggle }) => (
              <Chip
                active={open}
                title={
                  choreModel === undefined
                    ? t.settings.choreModelTip
                    : `${choreModel.providerId} · ${choreModel.modelId}`
                }
                onClick={toggle}
                chevron
              >
                {choreModel?.modelId ?? t.settings.sameAsSession}
              </Chip>
            )}
          />
        </SettingRow>
        <SettingRow
          name={t.settings.subSessionModel}
          info={t.settings.subSessionModelInfo}
        >
          {/* 模型与思考档一行：思考档是模型的属性（档位集与默认档都随型号变），所以先有
              模型芯片、选了具体模型才长出思考档芯片。Same as parent 时思考档跟父走，
              不放一个置灰的芯片占位——没有可选的东西就不画控件 */}
          <span className="set-chips">
            <ModelPickerMenu
              t={t}
              providers={usable}
              catalog={catalog}
              selected={subSessionModel ?? null}
              starred={props.starredModels}
              onToggleStar={props.onToggleStarModel}
              onSelect={(providerId, modelId) =>
                props.onChange({ subSessionModel: { providerId, modelId }, subSessionThinking: null })}
              leading={[subSessionFallback]}
              trigger={({ open, toggle }) => (
                <Chip
                  active={open}
                  title={
                    subSessionModel === undefined
                      ? t.settings.subSessionModelTip
                      : `${subSessionModel.providerId} · ${subSessionModel.modelId}`
                  }
                  onClick={toggle}
                  chevron
                >
                  {subSessionModel?.modelId ?? t.settings.sameAsParent}
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
                    title={t.settings.thinkingLevelFor(subSessionThinkingModel.modelId)}
                    onClick={toggle}
                    chevron
                  >
                    {subSessionThinking === undefined
                      ? t.settings.defaultThinking(
                          t.thinkingLevel(subSessionThinkingModel.fallback, subSessionThinkingModel.modelId),
                        )
                      : t.thinkingLevel(subSessionThinking, subSessionThinkingModel.modelId)}
                  </Chip>
                )}
              />
            )}
          </span>
        </SettingRow>
        <SettingRow
          name={t.settings.attribution}
          info={t.settings.attributionInfo}
        >
          {/* 设计系统里没有 Switch，开关就用两个 Chip——与 Auto-compact 的 Off 同一个形状 */}
          <span className="set-chips" role="group" aria-label={t.settings.attributionAria}>
            <Chip active={gitAttribution} onClick={() => props.onChange({ gitAttribution: true })}>
              {t.common.on}
            </Chip>
            <Chip active={!gitAttribution} onClick={() => props.onChange({ gitAttribution: false })}>
              {t.common.off}
            </Chip>
          </span>
          <AttributionPreview enabled={gitAttribution} language={shownLanguage} />
        </SettingRow>
        <SettingRow
          name={t.settings.pastedCollapse}
          info={t.settings.pastedCollapseInfo}
        >
          {/* 设计系统里没有 Switch，开关就用两个 Chip——与署名开关同一个形状 */}
          <span className="set-chips" role="group" aria-label={t.settings.pastedCollapseAria}>
            <Chip active={pastedCollapse} onClick={() => props.onChange({ collapsePastedText: true })}>
              {t.common.on}
            </Chip>
            <Chip active={!pastedCollapse} onClick={() => props.onChange({ collapsePastedText: false })}>
              {t.common.off}
            </Chip>
          </span>
        </SettingRow>
        <SettingRow name={t.settings.completionSound} info={t.settings.completionSoundInfo}>
          <span className="set-chips" role="group" aria-label={t.settings.completionSoundAria}>
            <Chip
              active={completionSound}
              onClick={() => {
                props.onChange({ completionSound: true });
                // 打开时当场响一声：开关的意义就是这个声音，让人先听到它是什么
                playCompletionChime();
              }}
            >
              {t.common.on}
            </Chip>
            <Chip active={!completionSound} onClick={() => props.onChange({ completionSound: false })}>
              {t.common.off}
            </Chip>
          </span>
        </SettingRow>
      </SettingGroup>
      <SettingGroup label={t.settings.data}>
        <DataDirectoryRow />
      </SettingGroup>
    </div>
  );
}

/**
 * 分组：标题与侧栏的节点标题同一个处理（`.section-label`，UI 字、sm、semibold，
 * Migration 同用）。最后一组的最后一行不画底线（`.set-group:last-child` 那条 CSS）。
 */
function SettingGroup(props: { label: string; children: React.ReactNode }) {
  return (
    <section className="set-group">
      <span className="section-label">{props.label}</span>
      {props.children}
    </section>
  );
}

/**
 * 一条设置：左边只有名字（说明收进旁边的 info 悬停），右边是控件与它的效果预览。
 * **直接坐在内容面上，靠发丝线分隔，不套第二张卡**——玻璃已经分了三层，再加一层只会把层级讲糊。
 *
 * `note` 是名字下方可选的一行状态（Data directory 的 Reveal 失败原因）——它不是说明，
 * 是这一次操作的结果，所以常驻、不进悬停。
 */
function SettingRow(props: {
  name: string;
  info?: React.ReactNode;
  note?: React.ReactNode;
  /** 挂在整行上（迁移页三步清单跳过来时滚动 / 高亮 / 聚焦用） */
  rowRef?: React.Ref<HTMLDivElement>;
  children: React.ReactNode;
}) {
  const t = useT();
  return (
    <div className="set-row" ref={props.rowRef}>
      <span className="set-row-head">
        <span className="set-row-name">
          {props.name}
          {props.info !== undefined && <InfoTip label={t.settings.aboutSetting(props.name)}>{props.info}</InfoTip>}
        </span>
        {props.note}
      </span>
      <div className="set-row-ctl">{props.children}</div>
    </div>
  );
}

/**
 * 设置 › 实验功能（独立 Tab，2026-10 用户裁决）。逐项开关（2026-10-12）：每个
 * 功能一张卡（同「服务商」页的卡片配方 `pv-cards` / `pv-vcard`，原型 exp-B）：
 * 图标 + 名字 + 开 / 关，一句说明，底部发丝线下面是最近一次更新与
 * 「全部 N 条 ⌄」；点开后这张卡横跨两列铺开完整日志（新的在上，PR 号可点）。
 * 没有总开关——每一项自己管自己。默认全关：不成熟的功能在公开快照里不出现；
 * 只藏入口不动数据，开了就原样回来。
 */
function ExperimentalSettings(props: {
  settings: AppSettings;
  onChange: (patch: SettingsPatch) => void;
}) {
  const t = useT();
  // 单语主题定死的语言：与通用页语言行同一条解析规则（shared 的 effectiveLanguage）
  const language = effectiveLanguage(props.settings.theme, props.settings.language);
  /** 展开哪一张卡的日志（一次至多一张）：默认都收着，只看最近一条 */
  const [openId, setOpenId] = useState<ExperimentalFeatureId | null>(null);
  // 意图系统（实验）：开关打开才出现设置区（地址 / 渠道 / 连接状态 / 新任务默认）
  const intentOn = props.settings.experimentalFeatures?.["intent-system"] === true;
  return (
    <div className="set-page">
      <p className="exp-lead">{t.settings.experimentalLead}</p>
      {intentOn && <IntentSettingsSection settings={props.settings} onChange={props.onChange} />}
      <div className="pv-cards large exp-cards">
        {EXPERIMENTAL_FEATURES.map((feature) => (
          <ExperimentalFeatureCard
            key={feature.id}
            feature={feature}
            language={language}
            on={props.settings.experimentalFeatures?.[feature.id] === true}
            open={openId === feature.id}
            onToggleLog={() => setOpenId(openId === feature.id ? null : feature.id)}
            onSwitch={(value) =>
              props.onChange({
                experimentalFeatures: {
                  [feature.id]: value,
                  // 互斥的项连带关掉（黑洞 ↔ 俄罗斯方块）：两个都开没有定义的行为，
                  // 与其让 parseSettings 静默裁决，不如打开的这一制替用户关上另一个
                  ...(value && feature.exclusiveWith !== undefined ? { [feature.exclusiveWith]: false } : {}),
                },
              })
            }
          />
        ))}
      </div>
    </div>
  );
}

/**
 * 意图系统的设置区（实验功能 intent-system，开关打开才渲染）：地址 / 连接状态 /
 * 渠道二选一 / 新任务默认。连接状态是探活结果（不落盘）：挂载与改地址时各探一次。
 */
function IntentSettingsSection(props: {
  settings: AppSettings;
  onChange: (patch: SettingsPatch) => void;
}) {
  const t = useT();
  const effective = effectiveIntentSettings(props.settings.intent);
  const [health, setHealth] = useState<"checking" | IntentHealth | null>("checking");
  useEffect(() => {
    setHealth("checking");
    let cancelled = false;
    void api.intent.health().then((result) => {
      if (!cancelled) setHealth(result);
    });
    return () => {
      cancelled = true;
    };
    // 改地址后重探：baseUrl 在依赖里（effective 按它派生）
  }, [effective.baseUrl]);
  const patchIntent = (patch: Partial<IntentSettings>): void =>
    props.onChange({ intent: { ...props.settings.intent, ...patch } });
  return (
    <section className="set-group">
      <h3 className="set-group-title">{t.settings.intentTitle}</h3>
      <div className="set-row">
        <span className="set-row-head">
          <span className="set-row-name">{t.settings.intentBaseUrl}</span>
          <span className="set-row-hint">{t.settings.intentBaseUrlHint}</span>
        </span>
        <div className="set-row-ctl">
          <input
            className="text-field voice-field"
            style={{ width: 240 }}
            value={props.settings.intent?.baseUrl ?? ""}
            placeholder={DEFAULT_INTENT_BASE_URL}
            spellCheck={false}
            onChange={(event) => patchIntent({ baseUrl: event.target.value.trim() })}
          />
        </div>
      </div>
      <div className="set-row">
        <span className="set-row-head">
          <span className="set-row-name">{t.settings.intentConnection}</span>
        </span>
        <div className="set-row-ctl">
          {health === "checking" ? (
            <span className="set-row-hint">{t.settings.intentChecking}</span>
          ) : health === null ? (
            <span className="set-row-hint" style={{ color: "var(--color-danger)" }}>
              {t.settings.intentOffline}
            </span>
          ) : (
            <span className="set-row-hint">
              {t.settings.intentOnline(health.main.model, health.qaImported, health.qaIngested)}
            </span>
          )}
        </div>
      </div>
      <div className="set-row">
        <span className="set-row-head">
          <span className="set-row-name">{t.settings.intentChannel}</span>
          <span className="set-row-hint">{t.settings.intentChannelHint}</span>
          {/* 渠道在服务端不可用就就地说（2026-10-15 联调）：/recall 会 400，提示里带上修法 */}
          {health !== "checking" &&
            health !== null &&
            intentChannelUnavailable(effective.channel, health.s3Presets) === true && (
              <span className="set-row-hint">{t.settings.intentChannelMissing(effective.channel)}</span>
            )}
        </span>
        <div className="set-row-ctl">
          <span className="set-chips" role="group" aria-label={t.settings.intentChannel}>
            <Chip
              active={effective.channel === "proma"}
              onClick={() => patchIntent({ channel: "proma" })}
              title={t.settings.intentChannelProma}
            >
              {t.settings.intentChannelProma}
            </Chip>
            <Chip
              active={effective.channel === "deepseek"}
              onClick={() => patchIntent({ channel: "deepseek" })}
              title={t.settings.intentChannelDeepseek}
            >
              {t.settings.intentChannelDeepseek}
            </Chip>
          </span>
        </div>
      </div>
      <div className="set-row">
        <span className="set-row-head">
          <span className="set-row-name">{t.settings.intentNewSessionOn}</span>
        </span>
        <div className="set-row-ctl">
          <span className="set-chips" role="group" aria-label={t.settings.intentNewSessionOn}>
            <Chip active={effective.newSessionOn} onClick={() => patchIntent({ newSessionOn: true })}>
              {t.common.on}
            </Chip>
            <Chip active={!effective.newSessionOn} onClick={() => patchIntent({ newSessionOn: false })}>
              {t.common.off}
            </Chip>
          </span>
        </div>
      </div>
    </section>
  );
}

/**
 * 一张实验功能卡（原型 exp-B）：头部图标 + 名字 + 开 / 关两个 Chip；说明一到两行；
 * 底部发丝线下面是最近一次更新（PR 号 + 一句话）与「全部 N 条 ⌄」。展开后
 * （`.exp-card.open` 横跨两列）换出完整日志，新的在上；PR 号在内置浏览器里打开。
 */
function ExperimentalFeatureCard(props: {
  feature: ExperimentalFeature;
  language: Language;
  on: boolean;
  open: boolean;
  onToggleLog: () => void;
  onSwitch: (value: boolean) => void;
}) {
  const t = useT();
  const { feature, language } = props;
  const name = feature.name[language];
  // 展开的日志新的在上——用户想知道的是「最近改了什么」
  const entries = [...feature.changelog].reverse();
  return (
    <div className={`pv-vcard exp-card${props.open ? " open" : ""}`}>
      <div className="exp-card-head">
        <span className="exp-card-icon">
          <Icon name={feature.icon} size={16} strokeWidth={1.8} />
        </span>
        <span className="exp-card-name">{name}</span>
        {/* 开关用两个 Chip——设计系统里没有 Switch，与署名行同一个形状 */}
        <span className="set-chips" role="group" aria-label={name}>
          <Chip active={props.on} onClick={() => props.onSwitch(true)}>
            {t.common.on}
          </Chip>
          <Chip active={!props.on} onClick={() => props.onSwitch(false)}>
            {t.common.off}
          </Chip>
        </span>
      </div>
      <p className="exp-card-sum">{feature.summary[language]}</p>
      {props.open ? (
        <>
          <ol className="exp-card-log">
            {entries.map((entry, i) => (
              <li key={i} className="exp-card-log-entry">
                <ExperimentalPrLink pr={entry.pr} />
                {/* 日期都是同年，卡片里只记月日；完整年份在 changelog 数据里 */}
                <span className="exp-card-date">{entry.date.slice(5)}</span>
                <span className="exp-card-note">{entry.note[language]}</span>
              </li>
            ))}
          </ol>
          <button type="button" className="exp-toggle" aria-expanded={true} onClick={props.onToggleLog}>
            {t.settings.experimentalCollapse}
            <Icon name="chevron-down" size={12} />
          </button>
        </>
      ) : (
        <div className="exp-card-latest">
          <ExperimentalPrLink pr={entries[0]?.pr ?? null} />
          <span className="exp-card-latest-note">{entries[0]?.note[language] ?? ""}</span>
          <button type="button" className="exp-toggle" aria-expanded={false} onClick={props.onToggleLog}>
            {t.settings.experimentalAllChanges(feature.changelog.length)}
            <Icon name="chevron-down" size={12} />
          </button>
        </div>
      )}
    </div>
  );
}

/** PR 号链接（无 PR 的旧条目画一个灰色的 —）：mono、次要色，点开在内置浏览器里打开 */
function ExperimentalPrLink(props: { pr: number | null }) {
  if (props.pr === null) return <span className="exp-pr">—</span>;
  const url = pullRequestUrl(props.pr);
  return (
    <a
      className="exp-pr"
      href={url}
      onClick={(event) => {
        event.preventDefault();
        window.open(url);
      }}
    >
      #{props.pr}
    </a>
  );
}

/**
 * 提交署名的效果预览：直接写出会追加的那两行（commit trailer、PR 描述行），
 * 代替原来那句「Adds a Made-with: Orbita trailer…」。Off 时同样两行划掉，
 * 用户看得出「关掉的是什么」。字面量与讲给模型的说明同源（shared/attribution.ts），
 * PR 那一行跟着界面语言走；commit trailer 的键恒为英文（git 只认 ASCII 键）。
 */
function AttributionPreview(props: { enabled: boolean; language: Language }) {
  // 预览只写链接文字，不写 URL：这一行在设置页里是示意，完整的 markdown 在 PR 描述里
  const prLine = prAttributionLine(props.language).replace(/\[(.+?)\]\([^)]*\)/, "$1");
  return (
    <span className="set-trailer" data-off={!props.enabled || undefined} aria-hidden="true">
      <span className="set-trailer-line">
        <Icon name="git-commit-horizontal" size={11} />
        <span className="set-trailer-text">{COMMIT_TRAILER}</span>
      </span>
      <span className="set-trailer-line">
        <Icon name="git-pull-request" size={11} />
        <span className="set-trailer-text">{prLine}</span>
      </span>
    </span>
  );
}

/**
 * 设置 › 语音。语音是一整套系统（听写 + 实时对话，厂商会有好几家，shared/voice.ts 顶注释）；
 * 这里选「听写用哪家」，下面各家凭证一组一组排开——各家要填的东西不一样，不硬凑成一张表单。
 */
function VoiceSettings() {
  return (
    <div className="set-page">
      <DictationEngineGroup />
      <DoubaoVoiceGroup />
      <StepfunVoiceGroup />
    </div>
  );
}

/**
 * 「听写用哪家」：芯片选厂商（同 General 里语言行的形状）。选中的那家没配好时名字下方说一句，
 * 但不拦着选——用户可能想先选好再去下面填凭证。
 */
function DictationEngineGroup() {
  const t = useT();
  const [selection, setSelection] = useState<DictationSelection | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void api.voice
      .dictationSelection()
      .then((loaded) => {
        if (!cancelled) setSelection(loaded);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const select = (provider: DictationProvider) => {
    if (busy || selection?.provider === provider) return;
    setBusy(true);
    void api.voice
      .setDictationProvider(provider)
      .then((next) => setSelection(next))
      .catch(() => undefined)
      .finally(() => setBusy(false));
  };

  return (
    <SettingGroup label={t.voice.dictationGroup}>
      <SettingRow
        name={t.voice.dictationEngine}
        info={t.voice.dictationEngineInfo}
        note={
          selection !== null && !selection.configured ? (
            <span className="set-row-hint">{t.voice.engineNotReady}</span>
          ) : undefined
        }
      >
        {selection === null ? (
          <span className="set-row-hint">…</span>
        ) : (
          <span className="set-chips" role="group" aria-label={t.voice.dictationEngine}>
            {DICTATION_PROVIDERS.map((provider) => (
              <Chip key={provider} active={selection.provider === provider} disabled={busy} onClick={() => select(provider)}>
                {t.voice.providers[provider]}
              </Chip>
            ))}
          </span>
        )}
      </SettingRow>
    </SettingGroup>
  );
}

type VoiceStatus =
  | { kind: "idle" }
  | { kind: "busy"; what: "test" | "save" }
  | { kind: "tested" }
  | { kind: "saved" }
  | { kind: "failed"; failure: VoiceFailure }
  | { kind: "save-failed" };

/**
 * 豆包三样：APP ID、Access Token、Resource ID。Token 只进不出——输入框永远是空的，占位写着
 * 已存的掩码，留空保存 = 保留（同 Providers 的 API key）。「测试连接」用输入框里的草稿试，
 * 不落盘；Token 没填就拿已存的试。
 */
function DoubaoVoiceGroup() {
  const t = useT();
  const [config, setConfig] = useState<DoubaoVoiceConfig | null>(null);
  const [appId, setAppId] = useState("");
  const [resourceId, setResourceId] = useState("");
  const [token, setToken] = useState("");
  const [status, setStatus] = useState<VoiceStatus>({ kind: "idle" });

  useEffect(() => {
    let cancelled = false;
    void api.voice
      .doubaoGet()
      .then((loaded) => {
        if (cancelled) return;
        setConfig(loaded);
        setAppId(loaded.appId);
        setResourceId(loaded.resourceId);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const draft = { appId, resourceId, ...(token.trim() === "" ? {} : { accessToken: token }) };
  const dirty = config !== null && (appId !== config.appId || resourceId !== config.resourceId || token.trim() !== "");
  const busy = status.kind === "busy";
  // 改了任何一格，上一次的结果就不再说明现在这组值了
  const edit = (set: (value: string) => void) => (value: string) => {
    set(value);
    if (status.kind !== "busy") setStatus({ kind: "idle" });
  };

  const test = () => {
    setStatus({ kind: "busy", what: "test" });
    void api.voice
      .doubaoTest(draft)
      .then((result) => setStatus(result.ok ? { kind: "tested" } : { kind: "failed", failure: result }))
      .catch(() => setStatus({ kind: "failed", failure: { reason: "network" } }));
  };
  const save = () => {
    setStatus({ kind: "busy", what: "save" });
    void api.voice
      .doubaoSave(draft)
      .then((saved) => {
        setConfig(saved);
        setAppId(saved.appId);
        setResourceId(saved.resourceId);
        setToken("");
        setStatus({ kind: "saved" });
      })
      .catch(() => setStatus({ kind: "save-failed" }));
  };

  const note =
    status.kind === "busy" ? (
      <span className="set-row-hint">
        <Icon name="loader-circle" size={12} spin /> {status.what === "test" ? t.voice.testing : t.voice.saving}
      </span>
    ) : status.kind === "tested" || status.kind === "saved" ? (
      <span role="status" className="set-row-note">
        <Icon name="check" size={12} /> {status.kind === "tested" ? t.voice.testOk("doubao") : t.voice.saved}
      </span>
    ) : status.kind === "failed" ? (
      <span role="alert" className="set-row-error">
        {t.voice.failures[status.failure.reason]("doubao")}
        {status.failure.detail !== undefined && <code className="voice-failure-detail"> {status.failure.detail}</code>}
      </span>
    ) : status.kind === "save-failed" ? (
      <span role="alert" className="set-row-error">
        {t.voice.saveFailed}
      </span>
    ) : undefined;

  return (
    <SettingGroup label={t.voice.doubaoGroup}>
      <SettingRow name={t.voice.appId} info={t.voice.appIdInfo}>
        <input
          className="text-field voice-field"
          aria-label={t.voice.appId}
          spellCheck={false}
          value={appId}
          onChange={(event) => edit(setAppId)(event.target.value)}
        />
      </SettingRow>
      <SettingRow name={t.voice.accessToken} info={t.voice.accessTokenInfo}>
        <input
          className="text-field voice-field"
          type="password"
          aria-label={t.voice.accessToken}
          autoComplete="off"
          placeholder={
            config !== null && config.tokenMasked !== null ? t.voice.tokenSaved(config.tokenMasked) : t.voice.tokenPaste
          }
          value={token}
          onChange={(event) => edit(setToken)(event.target.value)}
        />
      </SettingRow>
      <SettingRow name={t.voice.resourceId} info={t.voice.resourceIdInfo}>
        <input
          className="text-field voice-field"
          aria-label={t.voice.resourceId}
          spellCheck={false}
          value={resourceId}
          onChange={(event) => edit(setResourceId)(event.target.value)}
        />
      </SettingRow>
      <SettingRow name={t.voice.connection} note={note}>
        <span className="set-inline">
          <PanelButton onClick={test} disabled={busy || config === null}>
            {t.voice.test}
          </PanelButton>
          <PanelButton onClick={save} disabled={busy || !dirty}>
            {t.voice.save}
          </PanelButton>
        </span>
      </SettingRow>
    </SettingGroup>
  );
}

/**
 * 阶跃凭证就一样：API Key。规矩同豆包组——key 只进不出，输入框永远空、占位写已存掩码，
 * 留空保存 = 保留；「测试连接」用草稿试、不落盘，key 没填拿已存的试。
 */
function StepfunVoiceGroup() {
  const t = useT();
  const [config, setConfig] = useState<StepfunVoiceConfig | null>(null);
  const [key, setKey] = useState("");
  const [status, setStatus] = useState<VoiceStatus>({ kind: "idle" });

  useEffect(() => {
    let cancelled = false;
    void api.voice
      .stepfunGet()
      .then((loaded) => {
        if (!cancelled) setConfig(loaded);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const draft = key.trim() === "" ? {} : { apiKey: key };
  const dirty = config !== null && key.trim() !== "";
  const busy = status.kind === "busy";
  // 改了 key，上一次的结果就不再说明现在这组值了
  const edit = (value: string) => {
    setKey(value);
    if (status.kind !== "busy") setStatus({ kind: "idle" });
  };

  const test = () => {
    setStatus({ kind: "busy", what: "test" });
    void api.voice
      .stepfunTest(draft)
      .then((result) => setStatus(result.ok ? { kind: "tested" } : { kind: "failed", failure: result }))
      .catch(() => setStatus({ kind: "failed", failure: { reason: "network" } }));
  };
  const save = () => {
    setStatus({ kind: "busy", what: "save" });
    void api.voice
      .stepfunSave(draft)
      .then((saved) => {
        setConfig(saved);
        setKey("");
        setStatus({ kind: "saved" });
      })
      .catch(() => setStatus({ kind: "save-failed" }));
  };

  const note =
    status.kind === "busy" ? (
      <span className="set-row-hint">
        <Icon name="loader-circle" size={12} spin /> {status.what === "test" ? t.voice.testing : t.voice.saving}
      </span>
    ) : status.kind === "tested" || status.kind === "saved" ? (
      <span role="status" className="set-row-note">
        <Icon name="check" size={12} /> {status.kind === "tested" ? t.voice.testOk("stepfun") : t.voice.saved}
      </span>
    ) : status.kind === "failed" ? (
      <span role="alert" className="set-row-error">
        {t.voice.failures[status.failure.reason]("stepfun")}
        {status.failure.detail !== undefined && <code className="voice-failure-detail"> {status.failure.detail}</code>}
      </span>
    ) : status.kind === "save-failed" ? (
      <span role="alert" className="set-row-error">
        {t.voice.saveFailed}
      </span>
    ) : undefined;

  return (
    <SettingGroup label={t.voice.stepfunGroup}>
      <SettingRow name={t.voice.stepfunApiKey} info={t.voice.stepfunApiKeyInfo}>
        <input
          className="text-field voice-field"
          type="password"
          aria-label={t.voice.stepfunApiKey}
          autoComplete="off"
          placeholder={
            config !== null && config.apiKeyMasked !== null
              ? t.voice.tokenSaved(config.apiKeyMasked)
              : t.voice.keyPaste
          }
          value={key}
          onChange={(event) => edit(event.target.value)}
        />
      </SettingRow>
      <SettingRow name={t.voice.connection} note={note}>
        <span className="set-inline">
          <PanelButton onClick={test} disabled={busy || config === null}>
            {t.voice.test}
          </PanelButton>
          <PanelButton onClick={save} disabled={busy || !dirty}>
            {t.voice.save}
          </PanelButton>
        </span>
      </SettingRow>
    </SettingGroup>
  );
}

/**
 * 设置 › 浏览器（受管浏览器，main/browser/sandbox.ts）。单独一页而不是 General 里的一行：
 * 浏览器以后还会长出别的设置（登录状态导入、证书、下载位置…），先把位置占对。
 */
function BrowserSettings() {
  const t = useT();
  /** 清除全部浏览器数据会清空导入账本：计数一跳，已导入清单重新拉一次 */
  const [clearedCount, setClearedCount] = useState(0);
  return (
    <div className="set-page">
      <SettingGroup label={t.settings.browserDownloads}>
        <DownloadDirectoryRow />
      </SettingGroup>
      <SettingGroup label={t.settings.browserData}>
        <ClearBrowserDataRow onCleared={() => setClearedCount((count) => count + 1)} />
      </SettingGroup>
      {/* 登录状态导入只做了 macOS（钥匙串 + Chrome 存储格式）；别的平台不显示这一组 */}
      {api.platform === "darwin" && <LoginImportSection clearedCount={clearedCount} />}
    </div>
  );
}

/** 读取/导入的失败码（IPC 契约）加上提交制自己的 no-pending，都走同一张文案表 */
type LoginImportError = BrowserImportReadError | "no-pending";

function loginImportErrorText(t: ReturnType<typeof useT>, error: LoginImportError): string {
  const errors = t.settings.loginImportErrors;
  if (error === "keychain-denied") return errors.denied;
  if (error === "profile-not-found" || error === "not-supported") return errors.missing;
  if (error === "no-cookie-db") return errors.noCookies;
  if (error === "no-pending") return errors.expired;
  return errors.failed;
}

/** 来源在列表里的键：browserId + profileId 唯一确定一项 */
function sourceKey(source: BrowserImportSource): string {
  return `${source.browserId}/${source.profileId}`;
}

/**
 * 登录状态导入（main/browser/chrome-import.ts）：上面是「已导入的网站」清单（导入账本 +
 * 此刻还有没有 cookie），下面是导入入口：选来源 → 选择网站（主进程弹钥匙串框）→ 勾网站导入。
 * cookie 值不过 IPC，这里自始至终只拿「网站 + 条数」；默认一个都不勾——
 * 把选择权留给人，是把邮箱、银行登录交给 agent 之前的最后一道闸。
 *
 * 清单先于入口：打开这一页要先回答「我把哪些网站的登录交出去了」，导入是之后才做的事。
 */
function LoginImportSection(props: { clearedCount: number }) {
  const t = useT();
  const [imported, setImported] = useState<
    { kind: "loading" } | { kind: "ready"; list: BrowserImportedSite[] } | { kind: "error" }
  >({ kind: "loading" });
  const [removeError, setRemoveError] = useState(false);
  const refreshImported = () => {
    void api.browser
      .imported()
      .then((list) => setImported({ kind: "ready", list }))
      .catch(() => setImported({ kind: "error" }));
  };
  // 挂载时拉一次；清除全部浏览器数据之后（账本已清空）再拉一次
  useEffect(() => {
    refreshImported();
  }, [props.clearedCount]);
  const removeImported = (site: string) => {
    setRemoveError(false);
    void api.browser
      .removeImported(site)
      .then((list) => setImported({ kind: "ready", list }))
      .catch(() => setRemoveError(true));
  };
  const importedSites = new Set(imported.kind === "ready" ? imported.list.map((entry) => entry.site) : []);
  const [sources, setSources] = useState<{ kind: "loading" } | { kind: "ready"; list: BrowserImportSource[] }>({
    kind: "loading",
  });
  const [selected, setSelected] = useState<string | null>(null);
  /** idle 选来源 / reading 等钥匙串 / picking 勾网站 / importing 写入中 */
  const [phase, setPhase] = useState<"idle" | "reading" | "picking" | "importing">("idle");
  const [pending, setPending] = useState<{ id: string; sites: BrowserImportSite[] } | null>(null);
  const [error, setError] = useState<LoginImportError | null>(null);
  const [done, setDone] = useState<BrowserImportSummary | null>(null);

  useEffect(() => {
    let cancelled = false;
    void api.browser
      .importSources()
      .then((list) => {
        if (cancelled) return;
        setSources({ kind: "ready", list });
        const recommended = list.find((source) => source.recommended) ?? list[0];
        setSelected(recommended !== undefined ? sourceKey(recommended) : null);
      })
      .catch(() => {
        if (!cancelled) setSources({ kind: "ready", list: [] });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const current =
    sources.kind === "ready" ? sources.list.find((source) => sourceKey(source) === selected) : undefined;

  const read = () => {
    if (current === undefined) return;
    setPhase("reading");
    setError(null);
    setDone(null);
    void api.browser
      .importRead(current.browserId, current.profileId)
      .then((result) => {
        if (result.ok) {
          setPending({ id: result.pendingId, sites: result.sites });
          setPhase("picking");
        } else {
          setError(result.error);
          setPhase("idle");
        }
      })
      .catch(() => {
        setError("read-failed");
        setPhase("idle");
      });
  };

  const finish = (outcome: { error: LoginImportError } | { summary: BrowserImportSummary }) => {
    setPending(null);
    setPhase("idle");
    if ("error" in outcome) setError(outcome.error);
    else {
      setDone(outcome.summary);
      refreshImported();
    }
  };

  // ── 导入入口：来源下拉 + 选择网站 ──
  const menuItems: MenuItem[] =
    sources.kind === "ready"
      ? sources.list.map((source): MenuItem => ({
          id: sourceKey(source),
          label: `${source.browserName} · ${source.profileName}`,
          checked: sourceKey(source) === selected,
          onSelect: () => setSelected(sourceKey(source)),
        }))
      : [];

  const note =
    error !== null ? (
      <span role="alert" className="set-row-error">
        {loginImportErrorText(t, error)}
      </span>
    ) : phase === "reading" ? (
      <span className="set-row-hint">
        <Icon name="loader-circle" size={12} spin /> {t.settings.loginImportReading}
      </span>
    ) : done !== null ? (
      <span role="status" className="set-row-note">
        <Icon name="check" size={12} /> {t.settings.loginImportDone(done.imported, done.sites, done.skipped)}
      </span>
    ) : undefined;

  return (
    <SettingGroup label={t.settings.loginImportGroup}>
      <SettingRow
        name={t.settings.loginImported}
        info={t.settings.loginImportedInfo}
        note={
          removeError && (
            <span role="alert" className="set-row-error">
              {t.settings.loginImportedRemoveFailed}
            </span>
          )
        }
      >
        {imported.kind === "loading" ? (
          <span className="set-row-hint">…</span>
        ) : imported.kind === "error" ? (
          <span className="set-row-hint">{t.settings.unavailable}</span>
        ) : imported.list.length === 0 ? (
          <span className="set-row-hint">{t.settings.loginImportedNone}</span>
        ) : null}
      </SettingRow>
      {imported.kind === "ready" && imported.list.length > 0 && (
        <ImportedSitesList sites={imported.list} onRemove={removeImported} />
      )}
      <SettingRow name={t.settings.loginImport} info={t.settings.loginImportInfo} note={note}>
        {sources.kind === "loading" ? (
          <span className="set-row-hint">…</span>
        ) : sources.list.length === 0 ? (
          <span className="set-row-hint">{t.settings.loginImportNoBrowsers}</span>
        ) : (
          <span className="set-inline">
            <Menu
              items={menuItems}
              searchable={sources.list.length > 8}
              trigger={({ open, toggle }) => (
                <Chip active={open} onClick={toggle} chevron title={t.settings.loginImportSource}>
                  {current !== undefined ? `${current.browserName} · ${current.profileName}` : "…"}
                </Chip>
              )}
            />
            <PanelButton
              onClick={read}
              disabled={phase !== "idle" || current === undefined}
              title={t.settings.loginImportReadTitle}
            >
              <Icon name="key" size={14} /> {t.settings.loginImportRead}
            </PanelButton>
          </span>
        )}
      </SettingRow>
      {(phase === "picking" || phase === "importing") && pending !== null && (
        <LoginSitesPanel
          sites={pending.sites}
          imported={importedSites}
          busy={phase === "importing"}
          onImport={(ticked) => {
            setPhase("importing");
            setError(null);
            void api.browser
              .importCommit(pending.id, ticked)
              .then((result) =>
                finish(result.ok ? { summary: result.summary } : { error: "no-pending" }),
              )
              .catch(() => finish({ error: "read-failed" }));
          }}
          onCancel={() => {
            void api.browser.importCancel(pending.id).catch(() => undefined);
            setPending(null);
            setPhase("idle");
          }}
        />
      )}
    </SettingGroup>
  );
}

/**
 * 已导入的网站：一行一个网站——名字（mono，机器事实）、来源与导入日期、「移除」。
 * cookie 已不在（全过期 / 被网站清掉）的行把来源换成「已失效 · 请重新导入」：清单只说真话，
 * 账本记过不等于此刻还登录着。移除不二次确认：删的是内置浏览器里的登录，重新导入就回来。
 */
function ImportedSitesList(props: { sites: BrowserImportedSite[]; onRemove: (site: string) => void }) {
  const t = useT();
  const now = Date.now();
  return (
    <ul className="login-imported" aria-label={t.settings.loginImported}>
      {props.sites.map((entry) => (
        <li key={entry.site} className="login-imported-row">
          <span className="login-site-name" title={entry.site}>
            {entry.site}
          </span>
          {entry.present ? (
            <span className="login-imported-meta">
              {t.settings.loginImportedFrom(`${entry.browserName} · ${entry.profileName}`, formatDay(entry.importedAt, now))}
            </span>
          ) : (
            <span className="login-imported-meta" data-stale="">
              <Icon name="triangle-alert" size={12} /> {t.settings.loginImportedStale}
            </span>
          )}
          <button
            type="button"
            className="mg-textbtn"
            title={t.settings.loginImportedRemoveTitle(entry.site)}
            onClick={() => props.onRemove(entry.site)}
          >
            {t.settings.loginImportedRemove}
          </button>
        </li>
      ))}
    </ul>
  );
}

/**
 * 网站清单：搜索框（右侧「全选 / 全不选」，只作用于搜索结果）+ 复选框行 + 底部「导入所选 N 个网站」。默认一个都不勾；
 * 条数在每行末尾（mono，机器事实）。面板限高内滚，几十个网站也不把设置页撑长。
 * 已导入过的网站排最前、行内标「已导入」——重新读取时不会让人以为它没导进去；勾上它 = 重新导入（刷新）。
 */
function LoginSitesPanel(props: {
  sites: BrowserImportSite[];
  imported: ReadonlySet<string>;
  busy: boolean;
  onImport: (ticked: string[]) => void;
  onCancel: () => void;
}) {
  const t = useT();
  const [query, setQuery] = useState("");
  const [ticked, setTicked] = useState<ReadonlySet<string>>(new Set());
  const needle = query.trim().toLowerCase();
  const shown = importedFirst(props.sites, props.imported).filter(
    (site) => needle === "" || site.site.toLowerCase().includes(needle),
  );
  const shownNames = shown.map((site) => site.site);
  const allTicked = allShownTicked(shownNames, ticked);
  const toggle = (site: string) => {
    setTicked((before) => {
      const next = new Set(before);
      if (next.has(site)) next.delete(site);
      else next.add(site);
      return next;
    });
  };

  return (
    <div className="login-sites">
      <div className="login-sites-search">
        <Icon name="search" size={13} />
        <input
          type="search"
          className="text-field"
          placeholder={t.settings.loginImportSearchPlaceholder}
          aria-label={t.settings.loginImportSearchPlaceholder}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        {/* 全选 / 全不选：只作用于当前显示的网站（login-sites.ts）。沿用 Migration 页的文字按钮样式 mg-textbtn */}
        {shown.length > 1 && (
          <button
            type="button"
            className="mg-textbtn"
            disabled={props.busy}
            onClick={() => setTicked((before) => setShown(before, shownNames, !allTicked))}
          >
            {allTicked ? t.settings.loginImportDeselectAll : t.settings.loginImportSelectAll}
          </button>
        )}
      </div>
      <div className="login-sites-list" role="group" aria-label={t.settings.loginImportSitesAria}>
        {shown.map((site) => (
          <label key={site.site} className="login-site-row">
            <input type="checkbox" checked={ticked.has(site.site)} onChange={() => toggle(site.site)} />
            <span className="login-site-name" title={site.site}>
              {site.site}
            </span>
            {props.imported.has(site.site) && (
              <span className="login-site-tag">
                <Icon name="check" size={11} /> {t.settings.loginImportAlready}
              </span>
            )}
            <span className="login-site-count">{t.settings.loginImportSiteCount(site.count)}</span>
          </label>
        ))}
        {shown.length === 0 && (
          <span className="login-sites-empty">
            {/* 读到零个网站（全是过期 / 解不开的）与搜索没命中是两回事 */}
            {props.sites.length === 0 ? t.settings.loginImportErrors.noCookies : t.settings.loginImportNoMatch}
          </span>
        )}
      </div>
      <div className="login-sites-footer">
        <PanelButton disabled={props.busy || ticked.size === 0} onClick={() => props.onImport([...ticked])}>
          <Icon name="arrow-down" size={14} /> {t.settings.loginImportAction(ticked.size)}
        </PanelButton>
        <PanelButton disabled={props.busy} onClick={props.onCancel}>
          {t.common.cancel}
        </PanelButton>
      </div>
    </div>
  );
}

/**
 * 下载位置：「你的」tab 下载的文件落在这里（2026-09-27 wafo 裁决：用户指定目录，不弹保存框），
 * agent 每轮被告知这个目录、可以帮着整理。与 Data directory 行同一个形状：路径从左截断 + 操作键。
 */
function DownloadDirectoryRow() {
  const t = useT();
  const [dir, setDir] = useState<{ kind: "loading" } | { kind: "ready"; path: string } | { kind: "error" }>({
    kind: "loading",
  });
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void api.browser
      .downloadDir()
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

  const report = (cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause));
  const change = () => {
    void api.browser
      .pickDownloadDir()
      .then((picked) => {
        setError(null);
        if (picked !== null) setDir({ kind: "ready", path: picked });
      })
      .catch(report);
  };
  const reveal = () => {
    void api.browser
      .revealDownloadDir()
      .then(() => setError(null))
      .catch(report);
  };

  return (
    <SettingRow
      name={t.settings.downloadDirectory}
      info={t.settings.downloadDirectoryInfo}
      note={
        error !== null && (
          <span role="alert" className="set-row-error">
            {error}
          </span>
        )
      }
    >
      <span className="set-inline">
        {dir.kind === "ready" && (
          <code className="data-dir-path" title={dir.path}>
            <bdi dir="ltr">{dir.path}</bdi>
          </code>
        )}
        {dir.kind === "error" && <code className="data-dir-path-unavailable">{t.settings.unavailable}</code>}
        <PanelButton onClick={reveal} title={t.settings.openDownloadDirectory}>
          <Icon name="folder" size={14} /> {t.settings.reveal}
        </PanelButton>
        <PanelButton onClick={change} title={t.settings.chooseDownloadDirectory}>
          {t.settings.changeDirectory}
        </PanelButton>
      </span>
    </SettingRow>
  );
}

/**
 * 清除全部浏览器数据：两段式确认（同 Skills 面清理引用的写法），清完在名字下方留一行结果。
 * 不可撤销，所以危险键只在第二段出现。
 */
function ClearBrowserDataRow(props: { onCleared: () => void }) {
  const t = useT();
  const [phase, setPhase] = useState<"idle" | "confirming" | "clearing" | "done">("idle");
  const [error, setError] = useState<string | null>(null);

  const clear = () => {
    setPhase("clearing");
    setError(null);
    void api.browser
      .clearData()
      .then(() => {
        setPhase("done");
        props.onCleared();
      })
      .catch((cause: unknown) => {
        setPhase("idle");
        setError(cause instanceof Error ? cause.message : String(cause));
      });
  };

  return (
    <SettingRow
      name={t.settings.clearBrowserData}
      info={t.settings.clearBrowserDataInfo}
      note={
        error !== null ? (
          <span role="alert" className="set-row-error">
            {error}
          </span>
        ) : phase === "done" ? (
          <span role="status" className="set-row-note">
            <Icon name="check" size={12} /> {t.settings.clearBrowserDataDone}
          </span>
        ) : undefined
      }
    >
      {phase === "confirming" || phase === "clearing" ? (
        <span className="set-inline">
          <span className="set-row-hint">{t.settings.clearBrowserDataConfirm}</span>
          <PanelButton danger disabled={phase === "clearing"} onClick={clear}>
            <Icon name="trash-2" size={14} /> {t.settings.clearBrowserDataAction}
          </PanelButton>
          <PanelButton disabled={phase === "clearing"} onClick={() => setPhase("idle")}>
            {t.common.cancel}
          </PanelButton>
        </span>
      ) : (
        <PanelButton onClick={() => setPhase("confirming")}>
          <Icon name="trash-2" size={14} /> {t.settings.clearBrowserDataAction}
        </PanelButton>
      )}
    </SettingRow>
  );
}

/**
 * Data 组的唯一一行：数据目录的绝对路径 + Reveal。路径是全页唯一可能很长的控件，
 * 名字列保底 150px（`.set-row` 的列定义），窗口窄了先从左截路径（`.data-dir-path`）。
 */
function DataDirectoryRow() {
  const t = useT();
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
    <SettingRow
      name={t.settings.dataDirectory}
      info={t.settings.dataDirectoryInfo}
      note={
        revealError !== null && (
          <span role="alert" className="set-row-error">
            {revealError}
          </span>
        )
      }
    >
      <span className="set-inline">
        {dir.kind === "ready" && (
          // 路径很长，从左边截断让末段（真正区分不同机器的那一截）留在视野里；
          // 取到之前不渲染，免得先闪一下 "undefined"。bdi 见 .data-dir-path 的注释
          <code className="data-dir-path" title={dir.path}>
            <bdi dir="ltr">{dir.path}</bdi>
          </code>
        )}
        {dir.kind === "error" && <code className="data-dir-path-unavailable">{t.settings.unavailable}</code>}
        <PanelButton onClick={reveal} title={t.settings.openDataDirectory}>
          <Icon name="folder" size={14} /> {t.settings.reveal}
        </PanelButton>
      </span>
    </SettingRow>
  );
}

// ── 设置 › 电脑使用 ──────────────────────────────────────────────────────

/**
 * 设置 › 电脑使用（PR1）：能力检测、沙箱启停、手动「看一眼」。单独一页而不是
 * General 里的一行：三组内容与浏览器 / 语音同一档，侧栏入口由 SETTINGS_TABS
 * 自动长出来。状态不走拉取：主进程每次迁移推 computerUseStatus，冷启动按 off
 * 画（shared/computer-use.ts 的契约说明——沙箱不跨应用存活）。五态 → 按钮/图标/
 * 文字的全部换算在 computer-use-view.ts（纯函数层，node --test 直接测）。
 */
function ComputerUseView() {
  const t = useT();
  const [status, setStatus] = useState<SandboxStatus>({ state: "off" });
  /** 在途的那次点击。只压自己那颗按钮：starting 的 60 秒里 stop 必须随时可点（取消启动） */
  const [pending, setPending] = useState<"start" | "stop" | null>(null);
  /** 这次 start / stop 调用的失败原话。与状态机的 error 是两个来源：这个是主进程的 return 值 */
  const [actionError, setActionError] = useState<string | null>(null);
  /** 最近一次探测结果。提升到这里：「启动」要不要置灰看它（平台不对时主进程也会拒） */
  const [probeResult, setProbeResult] = useState<ComputerUseProbeResult | null>(null);

  // onStatus 返回退订函数，正好作 effect 的清理
  useEffect(() => api.computerUse.onStatus(setStatus), []);

  const control = sandboxControl(status.state, pending);
  const visual = statusVisual(status.state, t);
  /** 错误行：在途调用的失败原话优先（更新），其次是状态机停在 error 时的 message。
      用户中途「关闭」取消启动时主进程回「启动已取消」——如实显示，它解释了为什么
      沙箱回到了未启动；下一次动作即清掉。 */
  const errorLine = actionError ?? (status.state === "error" ? status.message : null);

  const run = (action: "start" | "stop") => {
    setPending(action);
    setActionError(null);
    const call = action === "start" ? api.computerUse.start() : api.computerUse.stop();
    void call
      .then((result) => {
        if (!result.ok) setActionError(result.error);
      })
      .catch((cause: unknown) => setActionError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setPending(null));
  };

  return (
    <div className="set-page">
      <ProbeGroup result={probeResult} onResult={setProbeResult} />
      <SettingGroup label={t.computerUse.sandboxGroup}>
        <SettingRow
          name={t.computerUse.sandboxState}
          info={t.computerUse.sandboxStateInfo}
          note={
            errorLine !== null ? (
              <span role="alert" className="set-row-error">
                {errorLine}
              </span>
            ) : undefined
          }
        >
          <span className="set-inline">
            {/* 状态徽标：图标 + 文字说话，颜色只是第二信号（tone 是视图层给的 CSS 变量） */}
            <span className="cu-state">
              <Icon name={visual.icon} size={14} spin={visual.spin} style={{ color: visual.tone }} />
              {visual.label}
            </span>
            <PanelButton onClick={() => run("start")} disabled={!control.canStart || probeBlocksStart(probeResult)}>
              <Icon name="play" size={13} /> {t.computerUse.start}
            </PanelButton>
            <PanelButton onClick={() => run("stop")} disabled={!control.canStop}>
              <Icon name="square" size={13} /> {t.computerUse.stop}
            </PanelButton>
          </span>
        </SettingRow>
      </SettingGroup>
      <LookGroup canScreenshot={control.canScreenshot} running={status.state === "running"} />
    </div>
  );
}

/**
 * 能力检测：点按钮才查（全部只读，绝不代跑提权命令）；结果保留到下次检测。
 * 未就绪时逐条铺开主进程的 guidance（那边已组织成人话，这里只拆行）。
 */
function ProbeGroup(props: { result: ComputerUseProbeResult | null; onResult: (result: ComputerUseProbeResult) => void }) {
  const t = useT();
  const [failed, setFailed] = useState(false);
  const [probing, setProbing] = useState(false);

  const run = () => {
    setProbing(true);
    setFailed(false);
    void api.computerUse
      .probe()
      .then((next) => {
        props.onResult(next);
        setProbing(false);
      })
      .catch(() => {
        setProbing(false);
        setFailed(true);
      });
  };

  const visual = props.result === null ? null : probeVisual(props.result);
  const note =
    probing ? (
      <span className="set-row-hint">
        <Icon name="loader-circle" size={12} spin /> {t.computerUse.probing}
      </span>
    ) : failed ? (
      <span role="alert" className="set-row-error">
        {t.computerUse.probeFailed}
      </span>
    ) : visual === null ? (
      <span className="set-row-hint">{t.computerUse.probeIdle}</span>
    ) : visual.kind === "ready" ? (
      // 就绪：绿色只是第二信号，勾与文字已经在说话（.cu-ready 只把图标染绿）
      <span role="status" className="set-row-note cu-ready">
        <Icon name="check" size={12} /> {t.computerUse.probeReady}
      </span>
    ) : (
      <span className="set-row-hint">{t.computerUse.probeNotReady}</span>
    );

  return (
    <SettingGroup label={t.computerUse.capabilityGroup}>
      <SettingRow name={t.computerUse.sandboxFeature} info={t.computerUse.sandboxFeatureInfo} note={note}>
        <PanelButton onClick={run} disabled={probing}>
          <Icon name="shield-check" size={13} /> {t.computerUse.probe}
        </PanelButton>
      </SettingRow>
      {visual?.kind === "not-ready" && visual.guidance.length > 0 && (
        <ul className="cu-guidance">
          {visual.guidance.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      )}
    </SettingGroup>
  );
}

/**
 * 「看一眼」：手动拍一张沙箱桌面。上一张图只活到沙箱离开 running——旧沙箱的图
 * 留在新一局里会让人误读，PR1 不做跨实例的图缓存（面板切走再回来同样清空）。
 */
function LookGroup(props: { canScreenshot: boolean; running: boolean }) {
  const t = useT();
  const [shot, setShot] = useState<ShotView>({ kind: "idle" });

  useEffect(() => {
    if (!props.running) setShot((current) => (current.kind === "idle" ? current : { kind: "idle" }));
  }, [props.running]);

  const busy = shot.kind === "loading";
  const capture = () => {
    setShot({ kind: "loading" });
    void api.computerUse
      .screenshot()
      .then((result) => setShot(shotFromResult(result)))
      .catch((cause: unknown) =>
        setShot({ kind: "failed", message: cause instanceof Error ? cause.message : String(cause) }),
      );
  };

  return (
    <SettingGroup label={t.computerUse.shotGroup}>
      <SettingRow
        name={t.computerUse.shotRow}
        info={t.computerUse.shotRowInfo}
        note={
          shot.kind === "failed" ? (
            <span role="alert" className="set-row-error">
              {shot.message}
            </span>
          ) : props.running ? undefined : (
            <span className="set-row-hint">{t.computerUse.shotNeedsRunning}</span>
          )
        }
      >
        <PanelButton onClick={capture} disabled={!props.canScreenshot || busy}>
          {busy ? <Icon name="loader-circle" size={13} spin /> : <Icon name="eye" size={13} />} {" "}
          {busy ? t.computerUse.shotBusy : t.computerUse.shot}
        </PanelButton>
      </SettingRow>
      {shot.kind === "ok" && (
        // 图片按内容面宽度缩放；原始桌面尺寸与拍摄时间是机器事实，进元信息条走 mono
        <figure className="cu-shot">
          <img src={shot.src} alt={t.computerUse.shotAlt} />
          <figcaption className="cu-shot-meta">
            <span>{t.computerUse.shotNativeSize}</span>
            <code>{shotMeta(shot.width, shot.height, shot.takenAt, t)}</code>
          </figcaption>
        </figure>
      )}
    </SettingGroup>
  );
}
