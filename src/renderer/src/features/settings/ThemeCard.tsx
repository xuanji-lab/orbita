import { THEME_PREFERENCES, type SettingsPatch, type ThemePreference } from "@shared/settings";
import { Icon } from "../../shell/Icon";
import { useSettingTip } from "./InfoTip";

const THEME_LABELS: Record<ThemePreference, string> = {
  system: "System",
  light: "Light",
  dark: "Warm",
  black: "Ink",
  manuscript: "Manuscript",
  typescript: "Typescript",
};

/**
 * 只有 System 需要说明：它是唯一「选了不知道会落在哪」的一档。说明挂在卡片自己身上
 * （悬停 / 键盘聚焦），不另放 info 图标——卡片的对半缩略窗已经说了一半。
 */
const THEME_TIPS: Partial<Record<ThemePreference, string>> = {
  system: "Follows your desktop's light or dark appearance · dark lands on Ink",
  manuscript: "Green-grid manuscript paper (稿纸) with red pen marks · light only",
  typescript: "A typewritten page with a red margin line, the English 稿纸 · light only",
};

/** `data-theme-preview` 认除 system 之外的每个真实主题；System 卡的缩略窗对半拼 light + black */
type PreviewTheme = Exclude<ThemePreference, "system">;

/**
 * Theme 行的预览卡组：每张卡画一份缩略窗（壳色 + 侧栏 + 面板 + accent 发送点），
 * 用**各自主题**的 token 画——不是当前主题的（见 ThemeThumb 与
 * `Orbita Design System/tokens/colors.css` 的 `[data-theme-preview]` 选择器）。
 * 只有 Theme 这一行用它，不拆成多个导出。
 */
export function ThemePicker(props: {
  value: ThemePreference;
  onChange: (patch: SettingsPatch) => void;
}) {
  return (
    <div className="theme-grid" role="group" aria-label="Theme">
      {THEME_PREFERENCES.map((value) => (
        <ThemeCard
          key={value}
          value={value}
          selected={props.value === value}
          onSelect={() => props.onChange({ theme: value })}
        />
      ))}
    </div>
  );
}

/** 一张卡。单独成组件是因为 System 卡要挂悬停说明（hook 不能在 map 里调） */
function ThemeCard(props: { value: ThemePreference; selected: boolean; onSelect: () => void }) {
  const tipText = THEME_TIPS[props.value];
  const tip = useSettingTip<HTMLButtonElement>(tipText);
  const anchor = tipText === undefined ? {} : tip.anchor;
  return (
    <>
      <button
        type="button"
        className="theme-card"
        aria-pressed={props.selected}
        onClick={props.onSelect}
        {...anchor}
      >
        <span className="theme-card-check" aria-hidden="true">
          <Icon name="check" size={11} strokeWidth={2.5} />
        </span>
        <span className="theme-card-thumb">
          {props.value === "system" ? (
            <>
              <ThemeThumb theme="light" half />
              <ThemeThumb theme="black" half />
            </>
          ) : (
            <ThemeThumb theme={props.value} />
          )}
        </span>
        <span className="theme-card-name">{THEME_LABELS[props.value]}</span>
      </button>
      {tipText !== undefined && tip.layer}
    </>
  );
}

/** 缩略窗内部的一份画法：侧栏 + 面板（两条灰线 + accent 发送点） */
function ThemeThumb(props: { theme: PreviewTheme; half?: boolean }) {
  return (
    <span
      className={props.half === true ? "theme-thumb theme-thumb-half" : "theme-thumb"}
      data-theme-preview={props.theme}
    >
      <span className="theme-thumb-side" />
      <span className="theme-thumb-main">
        <span className="theme-thumb-panel">
          <span className="theme-thumb-line" />
          <span className="theme-thumb-line theme-thumb-line-short" />
          <span className="theme-thumb-dot" />
        </span>
      </span>
    </span>
  );
}
