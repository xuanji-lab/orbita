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
import { InfoTip } from "./InfoTip";
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
import { THINKING_LEVELS } from "@shared/thinking";
import { COMMIT_TRAILER, prAttributionLine } from "@shared/attribution";
import { effectiveLanguage, LANGUAGES, themeLanguage, type Language } from "@shared/settings";

/** 语言芯片上写各自的自称（English / 中文）：找自己语言的人认的是自称，这两个词不翻译 */
const LANGUAGE_NAMES: Record<Language, string> = { en: "English", zh: "中文" };
import { defaultThinkingLevel } from "@shared/model-defaults";
import { modelThinkingLevels } from "../chat/thinking-choice.ts";
import { useT } from "../../locale.ts";

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
] as const satisfies readonly { id: string; icon: IconName }[];

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
  const t = useT();
  const active = SETTINGS_TABS.find((tab) => tab.id === props.tab) ?? SETTINGS_TABS[0];
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
          {t.settings.tabs[active.id]}
        </strong>
      </header>

      {props.tab === "migration" ? (
        // Migration 自带滚动区与底栏（Import 在底栏，不随内容滚走），占住第二行整格
        <MigrationView
          workspaces={props.workspaces}
          onImported={props.onImported}
          onOpenProviders={() => props.onTab("providers")}
        />
      ) : props.tab === "browser" ? (
        <div className="scroll" style={{ minHeight: 0, padding: "var(--space-6) var(--space-5)" }}>
          <BrowserSettings />
        </div>
      ) : props.tab === "providers" ? (
        // Providers 是主从两栏，铺满内容面：厂商列表贴着面板左缘，两栏各自内部滚动
        <ProvidersView onChange={props.onProvidersChange} />
      ) : (
        <div className="scroll" style={{ minHeight: 0, padding: "var(--space-6) var(--space-5)" }}>
          <General settings={props.settings} providers={props.providers} onChange={props.onSettingsChange} />
        </div>
      )}
    </div>
  );
}

/**
 * 「退回继承」菜单的公共形状：Task title model / Sub-session model 的模型与思考档
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
  const t = useT();
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
      label: t.settings.sameAsSession,
      hint: t.settings.sameAsSessionHint,
      inherited: titleModel === undefined,
      // null 而不是 undefined：补丁里的 undefined 是「这个键没改」，选不回默认
      onSelect: () => props.onChange({ titleModel: null }),
    },
    modelMenuItems({
      t,
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
      label: t.settings.sameAsParent,
      hint: t.settings.sameAsParentHint,
      inherited: subSessionModel === undefined,
      onSelect: () => props.onChange({ subSessionModel: null, subSessionThinking: null }),
    },
    modelMenuItems({
      t,
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
            label: t.settings.modelDefault,
            hint: t.thinkingLevel(subSessionThinkingModel.fallback, subSessionThinkingModel.modelId),
            inherited: subSessionThinking === undefined,
            onSelect: () => props.onChange({ subSessionThinking: null }),
          },
          (subSessionThinkingModel.supported ?? THINKING_LEVELS).map((level) => ({
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
          <ThemePicker value={props.settings.theme} onChange={props.onChange} />
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
          它们调的都是「agent 怎么干活」，并成一组 */}
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
          name={t.settings.titleModel}
          info={t.settings.titleModelInfo}
        >
          {/* 触发芯片不带图标：跟底栏的模型芯片同形，模型 id 本身就是内容 */}
          <Menu
            items={titleModelItems}
            searchable
            trigger={({ open, toggle }) => (
              <Chip
                active={open}
                title={
                  titleModel === undefined
                    ? t.settings.titleModelTip
                    : `${titleModel.providerId} · ${titleModel.modelId}`
                }
                onClick={toggle}
                chevron
              >
                {titleModel?.modelId ?? t.settings.sameAsSession}
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
            <Menu
              items={subSessionModelItems}
              searchable
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
      </SettingGroup>
      <SettingGroup label={t.settings.data}>
        <DataDirectoryRow />
      </SettingGroup>
    </div>
  );
}

/**
 * 分组：标题与侧栏的节点标题同一个处理（`.section-label`，mono、micro、大写加字距，
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
  children: React.ReactNode;
}) {
  const t = useT();
  return (
    <div className="set-row">
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
 * 设置 › 浏览器（受管浏览器，main/browser/sandbox.ts）。单独一页而不是 General 里的一行：
 * 浏览器以后还会长出别的设置（登录状态导入、证书、下载位置…），先把位置占对。
 * 第一刀只有一件事：清除全部数据——持久化了用户的登录态，就必须给一个退出的口子。
 */
function BrowserSettings() {
  const t = useT();
  return (
    <div className="set-page">
      <SettingGroup label={t.settings.browserDownloads}>
        <DownloadDirectoryRow />
      </SettingGroup>
      <SettingGroup label={t.settings.browserData}>
        <ClearBrowserDataRow />
      </SettingGroup>
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
function ClearBrowserDataRow() {
  const t = useT();
  const [phase, setPhase] = useState<"idle" | "confirming" | "clearing" | "done">("idle");
  const [error, setError] = useState<string | null>(null);

  const clear = () => {
    setPhase("clearing");
    setError(null);
    void api.browser
      .clearData()
      .then(() => setPhase("done"))
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
