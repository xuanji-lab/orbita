import { useState } from "react";
import { api } from "../../api";
import { Icon } from "../../shell/Icon";
import { useT } from "../../locale.ts";
import {
  APP_ICONS,
  DEFAULT_APP_ICON,
  type AppIconEntry,
  type AppIconId,
  type AppIconKind,
} from "@shared/app-icon";
import { effectiveLanguage, LANGUAGES, themeLanguage, type AppSettings, type Language, type SettingsPatch } from "@shared/settings";
import { SettingGroup, SettingRow } from "./SettingRow";
import { Segmented } from "./SettingControls";
import { ThemePicker } from "./ThemeCard";
import { appIconUrl, loadAppIconSvg } from "./app-icon-assets.ts";
import { renderAppIconPng } from "./app-icon-render.ts";

/** 语言芯片上写各自的自称（English / 中文）：找自己语言的人认的是自称，这两个词不翻译 */
const LANGUAGE_NAMES: Record<Language, string> = { en: "English", zh: "中文" };

/** 分段筛选：全部 + 三类款式（只管显示哪几组，不落盘） */
type IconFilter = "all" | AppIconKind;
const KINDS: readonly AppIconKind[] = ["basic", "stone", "nebula"];

/**
 * 设置 › 外观：主题与语言（原来在「通用」里），加上应用图标。
 * 应用图标选中后 renderer 画好 PNG 经 `app-icon:apply` 交给主进程换 Dock / 任务栏，成功了才记进设置
 * ——失败时设置与界面都停在原款，错误写在分组下面。
 */
export function AppearanceSettings(props: { settings: AppSettings; onChange: (patch: SettingsPatch) => void }) {
  const t = useT();
  // 单语主题定死的语言（null = 双语主题，听设置）；芯片亮的是实际生效的那一门
  const lockedLanguage = themeLanguage(props.settings.theme);
  const shownLanguage = effectiveLanguage(props.settings.theme, props.settings.language);
  // 后台任务状态位的形态：缺席 = 一行（#488）
  const backgroundStrip = props.settings.backgroundStrip ?? "line";
  return (
    <div className="set-page">
      <SettingGroup label={t.settings.interfaceGroup}>
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
          <Segmented
            label={t.settings.language}
            value={shownLanguage}
            options={LANGUAGES.map((language) => ({ value: language, label: LANGUAGE_NAMES[language] }))}
            disabled={lockedLanguage !== null}
            onChange={(language) => props.onChange({ language })}
          />
          {lockedLanguage !== null && (
            <span className="set-row-hint">
              {lockedLanguage === "zh" ? t.settings.languageLockedZh : t.settings.languageLockedEn}
            </span>
          )}
        </SettingRow>
        <SettingRow name={t.settings.backgroundStrip} info={t.settings.backgroundStripInfo}>
          <Segmented
            label={t.settings.backgroundStripAria}
            value={backgroundStrip}
            options={[
              { value: "line" as const, label: t.settings.backgroundStripLine },
              { value: "capsule" as const, label: t.settings.backgroundStripCapsule },
            ]}
            onChange={(next) => props.onChange({ backgroundStrip: next })}
          />
        </SettingRow>
      </SettingGroup>
      <SettingGroup label={t.settings.appIcon}>
        <AppIconPicker value={props.settings.appIcon ?? DEFAULT_APP_ICON} onChange={props.onChange} />
      </SettingGroup>
    </div>
  );
}

function AppIconPicker(props: { value: AppIconId; onChange: (patch: SettingsPatch) => void }) {
  const t = useT();
  const [filter, setFilter] = useState<IconFilter>("all");
  /** 正在换的那一款：画 PNG + 主进程应用期间，点别的款式无效，避免两次应用交错 */
  const [pending, setPending] = useState<AppIconId | null>(null);
  const [error, setError] = useState<string | null>(null);
  const shown = pending ?? props.value;

  const choose = async (id: AppIconId): Promise<void> => {
    if (pending !== null || id === props.value) return;
    setPending(id);
    setError(null);
    try {
      const png = await renderAppIconPng(await loadAppIconSvg(id), api.platform);
      const result = await api.appIcon.apply({ id, png });
      if (!result.ok) throw new Error(result.error);
      props.onChange({ appIcon: id });
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setPending(null);
    }
  };

  const options: { value: IconFilter; label: string }[] = [
    { value: "all", label: t.settings.appIconAll },
    ...KINDS.map((kind) => ({ value: kind, label: t.settings.appIconKinds[kind] })),
  ];
  return (
    <div className="appicon">
      <Segmented label={t.settings.appIcon} value={filter} options={options} onChange={setFilter} />
      {KINDS.filter((kind) => filter === "all" || filter === kind).map((kind) => (
        <section key={kind} className="appicon-section">
          <h3 className="appicon-kind">{t.settings.appIconKinds[kind]}</h3>
          <div className="appicon-grid" role="group" aria-label={t.settings.appIconKinds[kind]}>
            {APP_ICONS.filter((entry) => entry.kind === kind).map((entry) => (
              <AppIconCard
                key={entry.id}
                entry={entry}
                selected={shown === entry.id}
                onSelect={() => void choose(entry.id)}
              />
            ))}
          </div>
        </section>
      ))}
      <p className="set-row-hint appicon-hint">{t.settings.appIconHint}</p>
      {error !== null && (
        <p className="set-row-error" role="alert">
          {t.settings.appIconFailed(error)}
        </p>
      )}
    </div>
  );
}

function AppIconCard(props: { entry: AppIconEntry; selected: boolean; onSelect: () => void }) {
  const t = useT();
  const name = t.settings.appIconNames[props.entry.key];
  return (
    <button type="button" className="appicon-card" aria-pressed={props.selected} onClick={props.onSelect} title={name}>
      <span className="appicon-thumb">
        <img src={appIconUrl(props.entry.id)} alt="" draggable={false} />
        <span className="appicon-check" aria-hidden="true">
          <Icon name="check" size={12} strokeWidth={2.5} />
        </span>
      </span>
      <span className="appicon-name">
        {name}
        {props.entry.id === DEFAULT_APP_ICON && <span className="appicon-default">{t.settings.appIconDefault}</span>}
      </span>
    </button>
  );
}
