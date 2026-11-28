import "./settings-view.css";
import { useEffect, useRef, useState } from "react";
import { api } from "../../api";
import { Chip } from "../../shell/Chip";
import { Icon, type IconName } from "../../shell/Icon";
import { PanelEmpty } from "../../shell/PanelEmpty";
import { Menu } from "../../shell/Menu";
import type { MenuItem } from "../../shell/Menu";
import { PanelButton } from "../../shell/RightPanel";
import type { PluginDraftTarget } from "../plugins/plugin-draft.ts";
import { MemoryLibraryView } from "../memory/MemoryLibraryView";
import type { MemoryEntryView } from "@shared/memory";
import { PluginsView } from "../plugins/PluginsView.tsx";
import { SETTINGS_TABS, type SettingsTab } from "./settings-tabs.ts";
import type { ProviderDto } from "@shared/provider";
import type {
  BrowserImportedSite,
  BrowserImportReadError,
  BrowserImportSite,
  BrowserImportSource,
  BrowserImportSummary,
} from "@shared/browser";
import type { Workspace } from "@shared/workspace";
import type { DoubaoVoiceConfig, ElevenlabsVoiceConfig, StepfunVoiceConfig, VoiceFailure, DictationProvider, DictationSelection } from "@shared/voice";
import type { ComputerUseBackendChoice, ComputerUseLeaseStatus, ComputerUseProbeResult, EmergencyStopStatus, SandboxStatus, WslState } from "@shared/computer-use";
import { COMPUTER_USE_BROWSER_CHOICES, computerUseBackendChoices, type ComputerUseBrowser } from "@shared/computer-use";
import type { ComputerUsePlatformSupport } from "@shared/computer-use-platform";
import { playSpeech } from "../voice/speech-playback.ts";
import { DICTATION_PROVIDERS } from "@shared/voice";
import { CompactViz } from "./CompactViz";
import { COMPACTION_CHOICES } from "./compact-viz.ts";
import {
  allowNetworkEnabled,
  allowNetworkPatch,
  allowNetworkRow,
  backendChoice,
  backendChoicesView,
  backendPatch,
  browserChoice,
  browserLabel,
  browserPatch,
  computerUsePage,
  probeBlocksStart,
  probeVisual,
  sandboxControl,
  sandboxStatusPollMs,
  sameSandboxStatus,
  shotFromResult,
  shotMeta,
  statusVisual,
  type ShotView,
} from "./computer-use-view.ts";
import { allShownTicked, importedFirst, setShown } from "./login-sites.ts";
import { formatDay } from "./migration-groups.ts";
import { MigrationView } from "./MigrationView";
import { GuideSettings } from "./GuideSettings";
import { SettingGroup, SettingRow } from "./SettingRow";
import { Segmented, SelectButton, Switch } from "./SettingControls";
import { UpdateCard } from "./UpdateCard";
import { useChatStatusFlag } from "../context/chat-status-flag.ts";
import { ProvidersView } from "./ProvidersView";
import { ThemePicker } from "./ThemeCard";
import { EXPERIMENTAL_FEATURES, pullRequestUrl, type ExperimentalFeature } from "../../experimental-features.ts";
import { inheritedRow, ModelPickerMenu, type InheritedFallback, useBuiltinCatalog, usableProviders } from "./model-menu";
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
import { panelUsageRows, type PanelUsageSnapshot } from "@shared/panel-usage";
import { COMMIT_TRAILER, prAttributionLine } from "@shared/attribution";
import { effectiveLanguage, galaxyBatterySaverOf, GALAXY_DUST_DENSITIES, galaxyDustDensityOf, type GalaxyDustDensity, GALAXY_TILT, galaxyAzimuthOf, galaxyTiltOf, galaxyTurntableOf, LANGUAGES, type Language, type ModelPair } from "@shared/settings";
import { HomeGalaxy } from "../chat/HomeGalaxy.tsx";
import type { GalaxySpec } from "../chat/galaxy.ts";

/** 星系倾角的小预览：一颗主星、三颗行星、三十来颗碎石（演示形状，不是哪个工作区的真数据） */
const TILT_PREVIEW_SPEC: GalaxySpec = {
  starMass: 620,
  sessions: 36,
  planets: [
    { id: "p1", mass: 4, composition: "rock", orbitRadius: 19, inclinationDeg: 0, nodeDeg: 0, phaseDeg: 200 },
    { id: "p2", mass: 6, composition: "gas", orbitRadius: 31, inclinationDeg: 0, nodeDeg: 0, phaseDeg: 320 },
    { id: "p3", mass: 3, composition: "ice", orbitRadius: 43, inclinationDeg: 0, nodeDeg: 0, phaseDeg: 70 },
  ],
};

/** 语言芯片上写各自的自称（English / 中文）：找自己语言的人认的是自称，这两个词不翻译 */
const LANGUAGE_NAMES: Record<Language, string> = { en: "English", zh: "中文" };
import { defaultThinkingLevel, modelThinkingLevels } from "@shared/model-defaults";
import { declaredThinkingLevels, isPairOnClosedProvider, modelPreferenceById } from "./providers-view-model.ts";
import { useT } from "../../locale.ts";
import { playCompletionChime } from "../notify/chime.ts";

/**
 * 设置面。**它不是弹窗，是内容面的另一种内容**——tab 列表浮在侧栏上（透明、无面），
 * 右边还是同一张 `.pane`，同一个宽度、同一套宽度变化。这样设置与聊天是同一个壳，
 * 不是叠在壳上的另一层。
 */
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
  /** 当前会话所在的工作区与「打开看板」：插件页（全屏版）的详情页用 */
  /** 切 tab（Migration 的「Set up providers」跳到 Providers） */
  onTab: (tab: SettingsTab) => void;
  /** 插件页签（全屏版）要接到会话引擎与右栏上的三样 */
  plugins: {
    currentWorkspaceId: string | null;
    onMakeWithAgent: () => void;
    onOpenBoard: (pluginName: string) => void;
    /** 「正在做」组里点一行 / 点「回到对话」：退出设置，右栏开该草稿 / 打开那条会话 */
    onOpenDraft: (draft: PluginDraftTarget) => void;
    onOpenSession: (sessionId: string, draftPath: string) => void;
  };
  /** 「新手引导」页签：全屏打开引导，从第几页开始（0 = 从头；点某章 = 那章的章首页）。不改「看过」的设置键 */
  onOpenOnboarding: (startAt: number) => void;
  /** 记忆库页签里「回到原文」：退出设置、打开出处会话并滚到那一轮 */
  onJumpToMemorySource: (view: MemoryEntryView) => void;
  /** 收起右栏；右栏没开就是 null。模型服务页的价格 · 能力图太窄时给「收起右栏」按钮用 */
  onCollapseRail: (() => void) | null;
}) {
  const t = useT();
  /** 实验功能「电脑使用」（设置原值）：关着时侧栏导航与这一页的内容都藏起来。
   *  正常操作进不到这个门：App 的 settingsTab 只由侧栏导航行改写，导航行已过滤。
   *  这里再拦一道是兼容盘上手改 settings.json 的情形——页头与内容各自退回通用页。 */
  const computerUse = props.settings.experimentalFeatures?.["computer-use"] === true;
  /** 这一页画控件还是警示卡：平台判定读 shared 的同一个谓词（与主进程 / agent 工具注册同源） */
  const cuPage = computerUsePage(api.platform);
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
        gridTemplateRows: "minmax(0,1fr)",
        // 列必须显式写 minmax(0,1fr)：缺省是隐式的 auto 列，它的下限是页签内容的 min-content——
        // 右栏一开、主槽变窄时这一列不肯缩，内容溢出 .pane-main 画到右栏底下（2026-11-07 用户：
        // 模型服务页被右栏盖住；1000 宽窗口 + 右栏实测溢出 198px，补这一行后为 0）
        gridTemplateColumns: "minmax(0,1fr)",
      }}
    >

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
          {/* 平台闸门（2026-11-27）：非 Windows 上整页换说明卡，一个启动按钮都不画——
              那些按钮在那边点了必然失败（主进程 start() 与 agent 工具注册读同一个谓词）。
              入口不藏：藏掉会让用户以为页面坏了。平台值不明（preload 桥没就绪）时
              两样都不给，只留一句中性提示：这时候报「平台不支持」是错误归因 */}
          {cuPage.kind === "unknown" ? (
            <div className="set-page">
              <p className="set-row-hint" role="status">
                {t.computerUse.platformUnsupported.unknown}
              </p>
            </div>
          ) : cuPage.kind === "unsupported" ? (
            <ComputerUseUnsupported support={cuPage.support} />
          ) : (
            /* 出网开关读写同一份设置（App 的 changeSettings → api.settings.set），不另开通道 */
            <ComputerUseView settings={props.settings} onChange={props.onSettingsChange} />
          )}
        </div>
      ) : props.tab === "guide" ? (
        <div className="scroll" style={{ minHeight: 0, padding: "var(--space-6) var(--space-5)" }}>
          <GuideSettings seen={props.settings.onboardingSeen === true} onOpen={props.onOpenOnboarding} />
        </div>
      ) : props.tab === "plugins" ? (
        // 插件页的全屏版：自己带滚动区；窄了（右栏同时开着）由它自己的容器查询收成单列
        <PluginsView
          workspaces={props.workspaces}
          chrome="page"
          page={props.settings.pluginsPage}
          onPage={(pluginsPage) => props.onSettingsChange({ pluginsPage })}
          {...props.plugins}
        />
      ) : props.tab === "memory" ? (
        // 记忆库页签：页内自带范围导航与滚动区；宽 / 窄的排法看容器宽度（memory.css 的 @container mem）
        <MemoryLibraryView
          onJump={props.onJumpToMemorySource}
          choreLabel={props.settings.choreModel?.modelId ?? null}
          onOpenGeneral={() => {
            setHighlightChore(true);
            props.onTab("general");
          }}
        />
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
          page={props.settings.providersPage ?? {}}
          onPage={(providersPage) => props.onSettingsChange({ providersPage })}
          onCollapseRail={props.onCollapseRail}
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
            onOpenProviders={() => props.onTab("providers")}
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

/** 设置里选的模型指向了被关的服务商：旁边一行提示（不静默改选，运行时按既有兜底退回） */
function ClosedProviderNote(props: { title: string; body: string }) {
  return (
    <span className="set-row-note" role="status">
      <Icon name="triangle-alert" size={12} strokeWidth={1.8} />
      <span>
        {props.title} · {props.body}
      </span>
    </span>
  );
}


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
  /** 模型菜单底部「已关闭的服务 · 去模型服务打开」的去向 */
  onOpenProviders: () => void;
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
  const planFirst = props.settings.planFirst ?? false;
  // 同理：缺席 = 折叠（粘贴文本 chip 的出厂形态）
  const pastedCollapse = props.settings.collapsePastedText ?? true;
  // 完成提示音：缺席 = 响（这个提醒的价值在人不在跟前时也成立；只管声音，卡片与未读不受它影响）
  const completionSound = props.settings.completionSound ?? true;
  // 过程显示：缺席 = 一轮一行（2026-10-30）
  const processView = props.settings.processView ?? "chapters";

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
          const supported = modelThinkingLevels(
            subSessionModel.modelId,
            catalog,
            null,
            modelPreferenceById(usable, subSessionModel.providerId),
            declaredThinkingLevels(usable, subSessionModel.providerId, subSessionModel.modelId),
          );
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

  const shownLanguage = effectiveLanguage(props.settings.language);

  return (
    <div className="set-page">
      <SettingGroup label={t.settings.appearance}>
        <SettingRow name={t.settings.theme}>
          <ThemePicker value={props.settings.theme} onChange={props.onChange} />
        </SettingRow>
        <SettingRow name={t.settings.language} info={t.settings.languageInfo}>
          <Segmented
            label={t.settings.language}
            value={shownLanguage}
            options={LANGUAGES.map((language) => ({ value: language, label: LANGUAGE_NAMES[language] }))}
            onChange={(language) => props.onChange({ language })}
          />
        </SettingRow>
        <ChatStatusToggle />
        <SettingRow
          name={t.settings.galaxyTilt}
          info={t.settings.galaxyTiltInfo}
          below={
            // 小预览：同一个星系组件、同一个俯角（App 发下来的设置值），拖滑块时跟着变
            <div className="set-galaxy-preview">
              <HomeGalaxy spec={TILT_PREVIEW_SPEC} label={t.settings.galaxyTiltPreview} surface={null} />
            </div>
          }
        >
          <span className="set-galaxy-tilt">
            <input
              type="range"
              className="gd-range"
              min={GALAXY_TILT.min}
              max={GALAXY_TILT.max}
              step={GALAXY_TILT.step}
              value={galaxyTiltOf(props.settings)}
              aria-label={t.settings.galaxyTilt}
              onChange={(event) => props.onChange({ galaxyTilt: Number(event.target.value) })}
            />
            <span className="set-galaxy-tilt-value">{t.settings.galaxyTiltValue(galaxyTiltOf(props.settings))}</span>
          </span>
        </SettingRow>
        {/* 碎石密度：碎石带里普通会话画多少（在跑 / 等你 / 最近的会话永远画）；计数照旧按全部会话 */}
        <SettingRow name={t.settings.galaxyDust} info={t.settings.galaxyDustInfo}>
          <Segmented<GalaxyDustDensity>
            label={t.settings.galaxyDust}
            value={galaxyDustDensityOf(props.settings)}
            options={GALAXY_DUST_DENSITIES.map((value) => ({ value, label: t.settings.galaxyDustOptions[value] }))}
            onChange={(galaxyDustDensity) => props.onChange({ galaxyDustDensity })}
          />
        </SettingRow>
        {/* 离电时省电：用电池时星系停转、碎石带隐藏、眼睛不跟；缺席 = 开 */}
        <SettingRow name={t.settings.galaxyBatterySaver} info={t.settings.galaxyBatterySaverInfo}>
          <Switch
            label={t.settings.galaxyBatterySaver}
            checked={galaxyBatterySaverOf(props.settings)}
            onChange={(next) => props.onChange({ galaxyBatterySaver: next })}
          />
        </SettingRow>
        {/* 转台：星系空白处左右拖动绕竖直轴转（方位角）。关掉后左右拖动与左右方向键不改方位角，只剩上下改倾角 */}
        <SettingRow name={t.settings.galaxyTurntable} info={t.settings.galaxyTurntableInfo(galaxyAzimuthOf(props.settings))}>
          <Switch
            label={t.settings.galaxyTurntable}
            checked={galaxyTurntableOf(props.settings)}
            onChange={(next) => props.onChange({ galaxyTurntable: next })}
          />
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
          <Segmented<number | "off">
            label={t.settings.autoCompact}
            value={compaction.enabled === false ? "off" : compaction.reservePercent}
            options={[
              { value: "off", label: t.common.off },
              ...COMPACTION_CHOICES.map((value) => ({ value, label: `${value}%` })),
            ]}
            onChange={(value) =>
              setCompaction(value === "off" ? { ...compaction, enabled: false } : { enabled: true, reservePercent: value })
            }
          />
          {/* Off 时整条可视化不渲染（条件渲染，不是隐藏）——没有折叠点可画 */}
          {compaction.enabled !== false && <CompactViz percent={compaction.reservePercent} />}
        </SettingRow>
        <SettingRow
          name={t.settings.choreModel}
          info={t.settings.choreModelInfo}
          rowRef={choreRowRef}
          note={
            isPairOnClosedProvider(usable, choreModel) ? (
              <ClosedProviderNote title={t.providers.closedModelSet} body={t.providers.closedModelChore} />
            ) : undefined
          }
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
            onOpenProviders={props.onOpenProviders}
            trigger={({ open, toggle }) => (
              <SelectButton
                open={open}
                title={
                  choreModel === undefined
                    ? t.settings.choreModelTip
                    : `${choreModel.providerId} · ${choreModel.modelId}`
                }
                onClick={toggle}
              >
                {choreModel?.modelId ?? t.settings.sameAsSession}
              </SelectButton>
            )}
          />
        </SettingRow>
        <SettingRow
          name={t.settings.subSessionModel}
          info={t.settings.subSessionModelInfo}
          note={
            isPairOnClosedProvider(usable, subSessionModel) ? (
              <ClosedProviderNote title={t.providers.closedModelSet} body={t.providers.closedModelSub} />
            ) : undefined
          }
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
              onOpenProviders={props.onOpenProviders}
              trigger={({ open, toggle }) => (
                <SelectButton
                  open={open}
                  title={
                    subSessionModel === undefined
                      ? t.settings.subSessionModelTip
                      : `${subSessionModel.providerId} · ${subSessionModel.modelId}`
                  }
                  onClick={toggle}
                >
                  {subSessionModel?.modelId ?? t.settings.sameAsParent}
                </SelectButton>
              )}
            />
            {subSessionThinkingModel !== null && (
              <Menu
                items={subSessionThinkingItems}
                panelMinWidth={112}
                trigger={({ open, toggle }) => (
                  <SelectButton
                    open={open}
                    title={t.settings.thinkingLevelFor(subSessionThinkingModel.modelId)}
                    onClick={toggle}
                  >
                    {subSessionThinking === undefined
                      ? t.settings.defaultThinking(
                          t.thinkingLevel(subSessionThinkingModel.fallback, subSessionThinkingModel.modelId),
                        )
                      : t.thinkingLevel(subSessionThinking, subSessionThinkingModel.modelId)}
                  </SelectButton>
                )}
              />
            )}
          </span>
        </SettingRow>
        <SettingRow
          name={t.settings.attribution}
          info={t.settings.attributionInfo}
        >
          <Switch
            label={t.settings.attributionAria}
            checked={gitAttribution}
            onChange={(next) => props.onChange({ gitAttribution: next })}
          />
          <AttributionPreview enabled={gitAttribution} language={shownLanguage} />
        </SettingRow>
        <SettingRow name={t.settings.planFirst} info={t.settings.planFirstInfo}>
          <Switch
            label={t.settings.planFirstAria}
            checked={planFirst}
            onChange={(next) => props.onChange({ planFirst: next })}
          />
        </SettingRow>
        <SettingRow name={t.settings.processView} info={t.settings.processViewInfo}>
          <Segmented
            label={t.settings.processViewAria}
            value={processView}
            options={[
              { value: "chapters" as const, label: t.settings.processViewChapters },
              { value: "flat" as const, label: t.settings.processViewFlat },
              { value: "steps" as const, label: t.settings.processViewSteps },
            ]}
            onChange={(next) => props.onChange({ processView: next })}
          />
        </SettingRow>
        <SettingRow
          name={t.settings.pastedCollapse}
          info={t.settings.pastedCollapseInfo}
        >
          <Switch
            label={t.settings.pastedCollapseAria}
            checked={pastedCollapse}
            onChange={(next) => props.onChange({ collapsePastedText: next })}
          />
        </SettingRow>
        <SettingRow name={t.settings.completionSound} info={t.settings.completionSoundInfo}>
          <Switch
            label={t.settings.completionSoundAria}
            checked={completionSound}
            onChange={(next) => {
              props.onChange({ completionSound: next });
              // 打开时当场响一声：开关的意义就是这个声音，让人先听到它是什么
              if (next) playCompletionChime();
            }}
          />
        </SettingRow>
      </SettingGroup>
      <SettingGroup label={t.settings.data}>
        <DataDirectoryRow />
      </SettingGroup>
      {/* 「软件更新」殿后（2026-10-18 原型定稿）：关于这份安装的事实性信息，看完其余设置才关心它 */}
      <UpdateCard />
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
  // 与通用页语言行同一条解析规则（shared 的 effectiveLanguage）
  const language = effectiveLanguage(props.settings.language);
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
                experimentalFeatures: { [feature.id]: value },
              })
            }
          />
        ))}
      </div>
      <PanelUsageSection />
    </div>
  );
}

/**
 * 每个面板打开了几次（本机的统计，shared/panel-usage.ts；放在实验功能页底部，不随任何开关隐藏）：一行只读统计，
 * 全部面板都列、0 次也列，多的在前——一周后看它决定删什么。只在本机数、不上传；
 * 拉不到（IPC 出错）就不画这一节。
 */
function PanelUsageSection() {
  const t = useT();
  const [snapshot, setSnapshot] = useState<PanelUsageSnapshot | null>(null);
  useEffect(() => {
    let cancelled = false;
    api.panelUsage
      .get()
      .then((next) => {
        if (!cancelled) setSnapshot(next);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);
  if (snapshot === null) return null;
  const since = new Date(snapshot.since);
  return (
    <section className="set-group panel-usage">
      <span className="section-label">{t.settings.panelUsageTitle}</span>
      <p className="panel-usage-line">
        {panelUsageRows(snapshot).map((row, index) => (
          <span key={row.key} data-zero={row.count === 0 || undefined}>
            {index > 0 && " · "}
            {t.settings.panelUsageName(row.key)} <span className="panel-usage-count">{row.count}</span>
          </span>
        ))}
      </p>
      <p className="set-row-desc">{t.settings.panelUsageSince(since.getMonth() + 1, since.getDate())}</p>
    </section>
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
          <Segmented
            label={t.settings.intentChannel}
            value={effective.channel}
            options={[
              { value: "proma" as const, label: t.settings.intentChannelProma, title: t.settings.intentChannelProma },
              { value: "deepseek" as const, label: t.settings.intentChannelDeepseek, title: t.settings.intentChannelDeepseek },
            ]}
            onChange={(channel) => patchIntent({ channel })}
          />
        </div>
      </div>
      <div className="set-row">
        <span className="set-row-head">
          <span className="set-row-name">{t.settings.intentNewSessionOn}</span>
        </span>
        <div className="set-row-ctl">
          <Switch
            label={t.settings.intentNewSessionOn}
            checked={effective.newSessionOn}
            onChange={(newSessionOn) => patchIntent({ newSessionOn })}
          />
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
        <Switch label={name} checked={props.on} onChange={props.onSwitch} />
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
      <ElevenlabsVoiceGroup />
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
          <Segmented
            label={t.voice.dictationEngine}
            value={selection.provider}
            options={DICTATION_PROVIDERS.map((provider) => ({ value: provider, label: t.voice.providers[provider] }))}
            disabled={busy}
            onChange={select}
          />
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
 * ElevenLabs 语音合成（通话里「它说」的那一半）：API Key、音色 ID、模型三样。规矩同阶跃组——
 * key 只进不出，输入框永远空、占位写已存掩码，留空保存 = 保留；「试听」用草稿合成一句短话并
 * 播出来，不落盘，key 没填拿已存的。
 */
function ElevenlabsVoiceGroup() {
  const t = useT();
  const [config, setConfig] = useState<ElevenlabsVoiceConfig | null>(null);
  const [key, setKey] = useState("");
  const [voiceId, setVoiceId] = useState("");
  const [modelId, setModelId] = useState("");
  const [status, setStatus] = useState<VoiceStatus>({ kind: "idle" });

  useEffect(() => {
    let cancelled = false;
    void api.voice
      .elevenlabsGet()
      .then((loaded) => {
        if (cancelled) return;
        setConfig(loaded);
        setVoiceId(loaded.voiceId);
        setModelId(loaded.modelId);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const draft = { voiceId, modelId, ...(key.trim() === "" ? {} : { apiKey: key }) };
  const dirty = config !== null && (key.trim() !== "" || voiceId !== config.voiceId || modelId !== config.modelId);
  const busy = status.kind === "busy";
  const edit = (set: (value: string) => void) => (value: string) => {
    set(value);
    if (status.kind !== "busy") setStatus({ kind: "idle" });
  };

  const preview = () => {
    setStatus({ kind: "busy", what: "test" });
    void api.voice
      .elevenlabsTest(draft)
      .then(async (result) => {
        if (!result.ok) {
          setStatus({ kind: "failed", failure: result });
          return;
        }
        await playSpeech(result.audio).done;
        setStatus({ kind: "tested" });
      })
      .catch(() => setStatus({ kind: "failed", failure: { reason: "network" } }));
  };
  const save = () => {
    setStatus({ kind: "busy", what: "save" });
    void api.voice
      .elevenlabsSave(draft)
      .then((saved) => {
        setConfig(saved);
        setVoiceId(saved.voiceId);
        setModelId(saved.modelId);
        setKey("");
        setStatus({ kind: "saved" });
      })
      .catch(() => setStatus({ kind: "save-failed" }));
  };

  const note =
    status.kind === "busy" ? (
      <span className="set-row-hint">
        <Icon name="loader-circle" size={12} spin /> {status.what === "test" ? t.voice.previewing : t.voice.saving}
      </span>
    ) : status.kind === "tested" || status.kind === "saved" ? (
      <span role="status" className="set-row-note">
        <Icon name="check" size={12} /> {status.kind === "tested" ? t.voice.previewOk : t.voice.saved}
      </span>
    ) : status.kind === "failed" ? (
      <span role="alert" className="set-row-error">
        {t.voice.speechFailures[status.failure.reason]}
        {status.failure.detail !== undefined && <code className="voice-failure-detail"> {status.failure.detail}</code>}
      </span>
    ) : status.kind === "save-failed" ? (
      <span role="alert" className="set-row-error">
        {t.voice.saveFailed}
      </span>
    ) : undefined;

  return (
    <SettingGroup label={t.voice.elevenlabsGroup}>
      <SettingRow name={t.voice.elevenlabsApiKey} info={t.voice.elevenlabsApiKeyInfo}>
        <input
          className="text-field voice-field"
          type="password"
          aria-label={t.voice.elevenlabsApiKey}
          autoComplete="off"
          placeholder={
            config !== null && config.apiKeyMasked !== null ? t.voice.tokenSaved(config.apiKeyMasked) : t.voice.keyPaste
          }
          value={key}
          onChange={(event) => edit(setKey)(event.target.value)}
        />
      </SettingRow>
      <SettingRow name={t.voice.elevenlabsVoiceId} info={t.voice.elevenlabsVoiceIdInfo}>
        <input
          className="text-field voice-field"
          aria-label={t.voice.elevenlabsVoiceId}
          spellCheck={false}
          value={voiceId}
          onChange={(event) => edit(setVoiceId)(event.target.value)}
        />
      </SettingRow>
      <SettingRow name={t.voice.elevenlabsModelId} info={t.voice.elevenlabsModelIdInfo}>
        <input
          className="text-field voice-field"
          aria-label={t.voice.elevenlabsModelId}
          spellCheck={false}
          value={modelId}
          onChange={(event) => edit(setModelId)(event.target.value)}
        />
      </SettingRow>
      <SettingRow name={t.voice.connection} note={note}>
        <span className="set-inline">
          <PanelButton onClick={preview} disabled={busy || config === null}>
            {t.voice.preview}
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
                <SelectButton open={open} onClick={toggle} title={t.settings.loginImportSource}>
                  {current !== undefined ? `${current.browserName} · ${current.profileName}` : "…"}
                </SelectButton>
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
          // 读到零个网站（全是过期 / 解不开的）与搜索没命中是两回事
          <PanelEmpty icon={props.sites.length === 0 ? "globe" : "search"} className="login-sites-empty">
            {props.sites.length === 0 ? t.settings.loginImportErrors.noCookies : t.settings.loginImportNoMatch}
          </PanelEmpty>
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

/** 「状态」卡的原型开关（关 = 改前，#522 现状）：存在 localStorage，不进设置文件 */
function ChatStatusToggle() {
  const t = useT();
  const [on, setOn] = useChatStatusFlag();
  return (
    <SettingRow name={t.chatStatus.toggleName} info={t.chatStatus.toggleInfo}>
      <Switch label={t.chatStatus.toggleName} checked={on} onChange={setOn} />
    </SettingRow>
  );
}

// ── 电脑使用视图（自 cu/full 移植，见「设置 › 电脑使用」说明） ──
// ── 设置 › 电脑使用 ──────────────────────────────────────────────────────

/**
 * 非 Windows 上的整页说明（2026-11-27）。
 *
 * 为什么整页换掉而不是把控件置灰：那边的主进程 start() 一律拒（先报平台那条），agent
 * 也不再拿到 computer_* / sandbox_*——一组点了必然失败的按钮会把「不支持」误写成「坏了」。
 * 为什么不把入口藏掉：藏掉同样像坏了，用户会一遍遍找；说明 + 今天你能用什么才诚实。
 * 正文按 reasonKey 取（平台枚举与文案表的对应由 computer-use-view.test.ts 钉住）。
 */
function ComputerUseUnsupported(props: { support: ComputerUsePlatformSupport }) {
  const t = useT();
  // reasonKey 为 null 只可能发生在 Windows（supported），这里兜一层 other，不让正文空着
  const reason = props.support.reasonKey ?? "other";
  return (
    <div className="set-page">
      <section className="cu-unsupported">
        <h2 className="cu-unsupported-title">
          <Icon name="triangle-alert" size={16} strokeWidth={1.8} />
          {t.computerUse.platformUnsupported.title}
        </h2>
        <p className="cu-unsupported-body">{t.computerUse.platformUnsupported.body[reason]}</p>
        <p className="cu-unsupported-body">{t.computerUse.platformUnsupported.requirement}</p>
      </section>
    </div>
  );
}

/**
 * 主动拉一次沙箱状态，**只在真的变了才 setState**（轮询每 1.5–5 秒一次，不能每次都让
 * 整页重渲染）。失败静默：与状态推送同一条纪律——设置页不该因为一次读数失败弹红字。
 *
 * 为什么值得单独一个函数：事件订阅、兜底轮询、动作回执之后三处都要这一下，
 * 抄三份迟早有一份漏掉去重或漏掉 catch。
 */
function pullSandboxStatus(set: (update: (prev: SandboxStatus) => SandboxStatus) => void): void {
  void api.computerUse
    .status()
    .then((next) => set((prev) => (sameSandboxStatus(prev, next) ? prev : next)))
    .catch(() => undefined);
}

/**
 * 设置 › 电脑使用（PR1）：能力检测、沙箱启停、手动「看一眼」。单独一页而不是
 * General 里的一行：三组内容与浏览器 / 语音同一档，侧栏入口由 SETTINGS_TABS
 * 自动长出来。状态不走拉取：主进程每次迁移推 computerUseStatus，冷启动按 off
 * 画（shared/computer-use.ts 的契约说明——沙箱不跨应用存活）。五态 → 按钮/图标/
 * 文字的全部换算在 computer-use-view.ts（纯函数层，node --test 直接测）。
 */
function ComputerUseView(props: { settings: AppSettings; onChange: (patch: SettingsPatch) => void }) {
  const t = useT();
  const [status, setStatus] = useState<SandboxStatus>({ state: "off" });
  /** 在途的那次点击。只压自己那颗按钮：starting 的 60 秒里 stop 必须随时可点（取消启动） */
  const [pending, setPending] = useState<"start" | "stop" | null>(null);
  /** 这次 start / stop 调用的失败原话。与状态机的 error 是两个来源：这个是主进程的 return 值 */
  const [actionError, setActionError] = useState<string | null>(null);
  /** 最近一次探测结果。提升到这里：「启动」要不要置灰看它（平台不对时主进程也会拒） */
  const [probeResult, setProbeResult] = useState<ComputerUseProbeResult | null>(null);
  /** 桌面现在归谁（租约）；null = 空闲。每秒拉一次——「已 X 分 Y 秒」要跟着走 */
  const [lease, setLease] = useState<ComputerUseLeaseStatus>(null);
  /** 关闭沙箱的二次确认：误点就丢掉沙箱里的一切，所以只在第二段才真的调 stop() */
  const [confirmStop, setConfirmStop] = useState(false);
  /** 主进程给的可选后端（开发者开关关着时只有两档）。null = 还没拿到 */
  const [backends, setBackends] = useState<readonly ComputerUseBackendChoice[] | null>(null);
  /** 拉列表失败：不能静默成「一个后端都没有」——回退到默认两档并在行下说一句人话 */
  const [backendsError, setBackendsError] = useState(false);

  // onStatus 返回退订函数，正好作 effect 的清理；
  // 挂载时再拉一次当前值——沙盒是应用级的，离开设置页再回来时组件重挂载，
  // 只靠迁移推送会一直按 off 画（停不掉正在跑的沙盒）。
  useEffect(() => {
    const unsubscribe = api.computerUse.onStatus(setStatus);
    pullSandboxStatus(setStatus);
    return unsubscribe;
  }, []);

  /**
   * **兜底轮询（真机 P0）**：事件漏一条就足以把用户锁死——QEMU 后端起起来了，设置页
   * 一直「未启动」、「关闭」灰着，界面上停不掉那台 VM。事件那一处已修（qemu.ts 每次
   * 迁移都发），但这里不把命押在事件上：页面在就按 `sandboxStatusPollMs` 的周期问一次
   * 主进程（`status()` 只读内存里的状态机，不碰 VM）。非稳态 / 刚点完动作 1.5 s 一次，
   * off / error 5 s 一次（漏事件的现场正是「界面说 off、实际在跑」，所以稳态也轮询）。
   * 每次状态或在途动作变化都会重建定时器并立刻拉一次；页面卸载即停。
   */
  useEffect(() => {
    let alive = true;
    const pull = (): void => {
      if (alive) pullSandboxStatus(setStatus);
    };
    pull();
    const timer = setInterval(pull, sandboxStatusPollMs(status.state, pending !== null));
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [status.state, pending]);

  /**
   * 沙箱归属：每秒问一次主进程（数据源是桌面租约本身，不另写一套状态）。
   * 只有一秒一跳才让「已 X 分 Y 秒」是活的；页面切走时组件卸载，定时器随 effect 清掉。
   * 失败静默（与状态推送同一条纪律：设置页不该因为一次读数失败弹红字）。
   */
  useEffect(() => {
    let alive = true;
    const pull = (): void => {
      void api.computerUse
        .leaseStatus()
        .then((next) => {
          if (alive) setLease(next);
        })
        .catch(() => undefined);
    };
    pull();
    const timer = setInterval(pull, 1_000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);

  /**
   * 可选后端列表由主进程给（开发者后端的开关在主进程那边）。拉一次就够：
   * 环境变量变了要重启应用，这个值在本次运行里不会变。
   * **失败不能静默**：空列表会让用户看到「一个后端都没有」且无从解释。回退到默认两档
   * （与开关关闭时同形），并把「读取失败」写在那一行下面；已存的选择一个字不改。
   */
  useEffect(() => {
    let alive = true;
    void api.computerUse
      .backends()
      .then((next) => {
        if (alive) setBackends(next);
      })
      .catch(() => {
        if (!alive) return;
        setBackends(computerUseBackendChoices(false));
        setBackendsError(true);
      });
    return () => {
      alive = false;
    };
  }, []);

  // 状态一旦离开可关闭的那几档，第二段确认就没有意义了——收起它，免得下次停在「仍然关闭」上
  useEffect(() => {
    if (sandboxControl(status.state, pending).canStop !== true) setConfirmStop(false);
  }, [status.state, pending]);

  const control = sandboxControl(status.state, pending);
  const visual = statusVisual(status.state, t);
  /** 出网开关：缺席 = 允许（UI 自己兜缺省，否则新用户看到 Off、沙箱实际在联网） */
  const allowNetwork = allowNetworkEnabled(props.settings);
  /** 沙箱浏览器：缺席 = Edge（同上，UI 自己兜缺省） */
  const browser = browserChoice(props.settings);
  /** 隔离后端：缺席 = Windows 沙箱（P2 是可选升级，不是默认路径） */
  const backend = backendChoice(props.settings);
  /**
  /**
   * 后端行要画的形态：主进程的列表 + 已存值。开关关而存的是 qemu 时不改写设置，
   * 而是把 qemu 画成「选中 + 锁住」，并给出警示与启动置灰的理由。
   */
  const backendView = backends === null ? null : backendChoicesView(backend, backends);
  /**
   * 列表读取失败时我们**不知道**开关的真实状态，不能替主进程断言「开发者后端被关」：
   * 只画回退列表与一句失败说明，「启动」直接交给主进程按环境变量判（它不会骗人）。
   */
  const backendDevBlocked = backendsError !== true && backendView?.devBlocked === true;
  /**
   * 出网那一行能不能动：L2b 断不了网，所以它上面这一行不可操作并给出原因；
   * wsb / qemu 照常。**已存的值不动**——只是不让编辑（换回能断网的后端时选择还在）。
   */
  const networkRow = allowNetworkRow(backend, t);
  /** 错误行：在途调用的失败原话优先（更新），其次是状态机停在 error 时的 message。
      用户中途「关闭」取消启动时主进程回「启动已取消」——如实显示，它解释了为什么
      沙箱回到了未启动；下一次动作即清掉。 */
  const errorLine = actionError ?? (status.state === "error" ? status.message : null);
  /**
   * 关闭中的常驻说明（2026-11-13）：收尾不是瞬时的（guest 自己关机 + VM 退，真机 19 秒起步；
   * 刚起就关还要等沙箱登入），以前这段时间什么字也没有，用户以为是卡住了、反复点。
   * 它不是错误，所以走 note 的普通样式，而不是 set-row-error。
   */
  const stoppingNote = status.state === "stopping" ? t.computerUse.stoppingNote : null;
  /** 开发者后端没开时，启动置灰的原因行（与后端行下的警示同一件事，放在按钮旁边再说一次） */
  const devBlockedNote = backendDevBlocked ? t.computerUse.backendDevBlockedStart : null;

  const run = (action: "start" | "stop") => {
    setPending(action);
    setActionError(null);
    setConfirmStop(false);
    const call = action === "start" ? api.computerUse.start() : api.computerUse.stop();
    void call
      .then((result) => {
        if (!result.ok) setActionError(result.error);
      })
      .catch((cause: unknown) => setActionError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => {
        setPending(null);
        // 回执只说这次调用本身；最新状态以 status() 为准（事件可能晚到——兜底轮询也会接住）
        pullSandboxStatus(setStatus);
      });
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
            ) : devBlockedNote !== null ? (
              <span role="status" className="set-row-note">
                {devBlockedNote}
              </span>
            ) : stoppingNote !== null ? (
              <span role="status" className="set-row-note">
                {stoppingNote}
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
            {confirmStop ? (
              /* 第二段：说清代价，再给一次「仍然关闭」。取消是第一序选项（不染 accent），
                 破坏性动作才用 danger——与「清除浏览器数据」同一套行内确认。 */
              <>
                <span className="set-row-hint">{t.computerUse.stopConfirm}</span>
                <PanelButton danger onClick={() => run("stop")}>
                  <Icon name="square" size={13} /> {t.computerUse.stopConfirmAction}
                </PanelButton>
                <PanelButton onClick={() => setConfirmStop(false)}>{t.common.cancel}</PanelButton>
              </>
            ) : (
              <>
                <PanelButton
                  onClick={() => run("start")}
                  disabled={!control.canStart || probeBlocksStart(probeResult) || backendDevBlocked}
                >
                  <Icon name="play" size={13} /> {t.computerUse.start}
                </PanelButton>
                <PanelButton onClick={() => setConfirmStop(true)} disabled={!control.canStop}>
                  <Icon name="square" size={13} /> {t.computerUse.stop}
                </PanelButton>
              </>
            )}
          </span>
        </SettingRow>
        {/* 沙箱归属：多会话时用户要知道现在是谁占着那块桌面（租约状态，每秒刷新）。
            没人持有时说「空闲」；有主时说标题与已持有的时长——用户据此判断要不要等。 */}
        <SettingRow name={t.computerUse.leaseRow} info={t.computerUse.leaseRowInfo}>
          <span className="cu-state">
            <Icon
              name={lease === null ? "circle" : "monitor"}
              size={14}
              style={{ color: lease === null ? "var(--color-text-tertiary)" : "var(--color-accent)" }}
            />
            <span role="status">
              {lease === null
                ? t.computerUse.leaseIdle
                : t.computerUse.leaseBusy(
                    lease.title === "" ? t.computerUse.leaseUntitled : lease.title,
                    Math.floor(lease.heldMs / 60_000),
                    Math.floor(lease.heldMs / 1_000) % 60,
                  )}
            </span>
          </span>
        </SettingRow>
        {/* 生效时机常驻在行底：运行中点了「关」而沙箱还在联网，用户会以为坏了——
            这件事不能只住在 hover 里。后端断不了网时（L2b）行底换成原因，那一行也不可操作：
            否则用户关掉开关、看到「已关」、而它照样联网——那就是设置骗人。 */}
        <SettingRow
          name={t.computerUse.allowNetwork}
          info={networkRow.editable ? t.computerUse.allowNetworkInfo : t.computerUse.allowNetworkInfoLocked}
          below={
            <p className="cu-hint">
              {networkRow.editable ? t.computerUse.allowNetworkBelow : networkRow.reason}
            </p>
          }
        >
          {/* 设计系统里没有 Switch，开关就用两个 Chip（与设置页其它布尔项同一个形状）。
              按钮不因沙箱状态置灰：改的是下次启动时读的 .wsb / VM 参数，运行中也可以先改好 */}
          <span className="set-chips" role="group" aria-label={t.computerUse.allowNetworkAria}>
            <Chip
              active={allowNetwork}
              disabled={!networkRow.editable}
              onClick={() => props.onChange(allowNetworkPatch(true))}
            >
              {t.common.on}
            </Chip>
            <Chip
              active={!allowNetwork}
              disabled={!networkRow.editable}
              onClick={() => props.onChange(allowNetworkPatch(false))}
            >
              {t.common.off}
            </Chip>
          </span>
        </SettingRow>
        {/* 沙箱浏览器：默认 Edge（沙箱自带、零准备成本），Chrome / Brave / Chromium 需要用户先把
            它们映射进去；没放进去时桥会回退 Edge 并在回执里说明。用 Chip 组而不是 select：这个页里
            每一个选项集合都是 Chip 组（语言 / 自动压缩 / 归属），没有裸 <select> 的先例，
            设计系统也不给 select 任何样式。 */}
        <SettingRow
          name={t.computerUse.browser}
          info={t.computerUse.browserInfo}
          below={<p className="cu-hint">{t.computerUse.browserBelow}</p>}
        >
          <span className="set-chips" role="group" aria-label={t.computerUse.browserAria}>
            {COMPUTER_USE_BROWSER_CHOICES.map((choice) => (
              <Chip key={choice} active={browser === choice} onClick={() => props.onChange(browserPatch(choice))}>
                {browserLabel(choice, t.computerUse.browserAuto)}
              </Chip>
            ))}
          </span>
        </SettingRow>
        {/*
          隔离后端：列表由主进程给（`api.computerUse.backends()`）——renderer 不自己硬编码三档。
          开发者后端（qemu）只在 `ORBITA_CU_DEV_BACKENDS` 开着时出现，并带「实验」文字标记；
          已存 qemu 而开关关着时**不改写设置**，而是把它画成选中且锁住的一档 + 行下警示，
          启动按钮同时置灰并说原因（主进程 start 也会拒，这里只是不让人白点一次）。
        */}
        <SettingRow
          name={t.computerUse.backend}
          info={t.computerUse.backendInfo}
          below={
            backendsError ? (
              <p className="set-row-error" role="alert">
                {t.computerUse.backendListFailed}
              </p>
            ) : backendDevBlocked ? (
              <p className="set-row-error" role="alert">
                {t.computerUse.backendDevBlocked}
              </p>
            ) : (
              <>
                <p className="cu-hint">{t.computerUse.backendBelow}</p>
                {/* qemu 在列表里就把代价说清楚（不必等选中后才看到）：镜像自备 + 只有截图/点击/打字 */}
                {backendView?.options.some((option) => option.id === "qemu") && (
                  <p className="cu-hint">{t.computerUse.backendDevNote}</p>
                )}
              </>
            )
          }
        >
          <span className="set-chips" role="group" aria-label={t.computerUse.backendAria}>
            {(backendView?.options ?? []).map((option) => (
              <Chip
                key={option.id}
                active={backend === option.id}
                disabled={option.locked}
                title={
                  option.locked
                    ? backendsError
                      ? t.computerUse.backendListFailed
                      : t.computerUse.backendDevBlocked
                    : undefined
                }
                onClick={() => props.onChange(backendPatch(option.id))}
              >
                {t.computerUse.backendLabels[option.id]}
                {option.experimental ? ` · ${t.computerUse.backendExperimental}` : null}
              </Chip>
            ))}
          </span>
        </SettingRow>
      </SettingGroup>
      <LookGroup canScreenshot={control.canScreenshot} running={status.state === "running"} />
      <GuardGroup />
    </div>
  );
}

/**
 * 安全组（computer use PR4）：急停热键的**真实可用性**。
 *
 * 为什么一定要显示状态：`globalShortcut.register` 被别的应用占用时返回 false 而不是
 * 抛错——只在控制台留一行的话，用户以为急停能用；真出事时按下去什么都没发生。
 * 注册失败的文案要能行动（关掉占用的应用后重启）。
 */
function GuardGroup() {
  const t = useT();
  const [state, setState] = useState<EmergencyStopStatus | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    void api.computerUse
      .emergencyStopState()
      .then((next) => {
        if (alive) setState(next);
      })
      .catch(() => {
        if (alive) setFailed(true);
      });
    return () => {
      alive = false;
    };
  }, []);

  const note = failed
    ? "读取热键状态失败（主进程没有回执）"
    : state === null
      ? undefined
      : state.registered
        ? undefined
        : t.computerUse.emergencyUnavailable(state.error ?? "");

  return (
    <SettingGroup label={t.computerUse.emergencyGroup}>
      <SettingRow
        name={t.computerUse.emergencyHotkey}
        info={t.computerUse.emergencyHotkeyInfo}
        note={
          note === undefined ? undefined : (
            <span role={state !== null && !state.registered ? "alert" : undefined} className="set-row-hint">
              {note}
            </span>
          )
        }
      >
        <span className="set-inline">
          <span className="cu-state">
            <Icon
              name={state?.registered === true ? "shield-check" : "triangle-alert"}
              size={14}
              style={{ color: state?.registered === true ? "var(--color-success)" : "var(--color-danger)" }}
            />
            <code style={{ fontFamily: "var(--font-family-mono)", fontSize: "var(--font-size-sm)" }}>
              {state?.accelerator ?? "Control+Alt+Shift+Escape"}
            </code>
          </span>
          {state?.registered === true && (
            <span className="set-row-hint">
              {/* 生效的组合就是上面那个 code；主选被占用时补一句「已改用哪一个」——
                  用户没有换键入口，至少要一眼看出该记哪个组合（2026-11-28 验收 P2-2） */}
              {state.accelerator === state.preferred
                ? t.computerUse.emergencyRegistered
                : t.computerUse.emergencyFallback(state.preferred, state.accelerator)}
            </span>
          )}
        </span>
      </SettingRow>
    </SettingGroup>
  );
}

/**
 * WSL2 三种状态 → 图标。它只是旁证不是结论，所以只选图标、不额外上色——
 * 颜色留给就绪态与危险态（设计系统：图标 + 文字说话，颜色是第二信号）。
 */
const WSL_VISUALS: Record<WslState, { icon: IconName }> = {
  available: { icon: "check" },
  unavailable: { icon: "circle-off" },
  unknown: { icon: "circle-help" },
};

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
      {/* 指引紧跟在探针那一行下面：它是那一行的结果，也是下面「隔离档位」为什么到不了更高档的原因 */}
      {visual?.kind === "not-ready" && visual.guidance.length > 0 && (
        <ul className="cu-guidance">
          {visual.guidance.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      )}
      {props.result !== null && (
        <SettingRow
          name={t.computerUse.isolationTier}
          info={t.computerUse.isolationTierInfo}
          note={
            props.result.isolationTier === "l2" ? undefined : (
              <span className="set-row-hint">{t.computerUse.tierFallback}</span>
            )
          }
        >
          {/* 档位是机器事实，不是可操作项：图标 + 文字，颜色只是第二信号（不借成功绿，那是就绪的专用色） */}
          <span className="cu-state">
            <Icon name={props.result.isolationTier === "l1" ? "globe" : "shield-check"} size={14} />
            {t.computerUse.tiers[props.result.isolationTier]}
          </span>
        </SettingRow>
      )}
      {/*
        多会话隔离的依赖检查（L2b）。**不可用时必须说原因**：只把开关画灰，用户没任何办法
        处置（缺 Node / 缺服务 / 非 Windows 是三件不同的事）。Node 版本单独一行写出来：
        它是本机最容易踩的那个（MXC 的 native stdio 要 24.21+，而很多发行版还是 24.14）。
      */}
      {props.result !== null && props.result.platformOk && (
        <SettingRow
          name={t.computerUse.isolationSessionRow}
          info={t.computerUse.isolationSessionInfo}
          note={
            props.result.isolationSession.available ? (
              <span className="set-row-hint">
                {t.computerUse.isolationSessionNode(
                  props.result.isolationSession.nodeVersion,
                  props.result.isolationSession.nodeOk,
                )}
              </span>
            ) : (
              <span className="set-row-hint">{props.result.isolationSession.reason}</span>
            )
          }
        >
          <span className="cu-state">
            <Icon
              name={props.result.isolationSession.available ? "shield-check" : "circle-off"}
              size={14}
            />
            {props.result.isolationSession.available
              ? t.computerUse.isolationSessionReady
              : t.computerUse.probeNotReady}
          </span>
        </SettingRow>
      )}
      {/* WSL2 只在 Windows 上有意义；它不是隔离档，所以单独一行、措辞里明说这一点 */}
      {props.result !== null && props.result.platformOk && (
        <SettingRow name={t.computerUse.wsl2} info={t.computerUse.wsl2Info}>
          <span className="cu-state">
            <Icon name={WSL_VISUALS[props.result.wsl2].icon} size={14} />
            {t.computerUse.wsl2States[props.result.wsl2]}
          </span>
        </SettingRow>
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
