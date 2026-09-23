import { THEME_PREFERENCES, type SettingsPatch, type ThemePreference } from "@shared/settings";
import { Icon } from "../../shell/Icon";

const THEME_LABELS: Record<ThemePreference, string> = {
  system: "System",
  light: "Light",
  dark: "Warm",
  black: "Ink",
};

/** `data-theme-preview` 只认三个真实主题；System 卡的缩略窗对半拼 light + black */
type PreviewTheme = "light" | "dark" | "black";

/**
 * Theme 行的预览卡组：替换原来的四个 Chip。每张卡画一份缩略窗（壳色 + 侧栏 + 面板 +
 * accent 发送点），用**各自主题**的 token 画——不是当前主题的（见 ThemeThumb 与
 * `Orbita Design System/tokens/colors.css` 的 `[data-theme-preview]` 选择器）。
 * 只有 Theme 这一行用它，不拆成多个导出。
 */
export function ThemePicker(props: {
  value: ThemePreference;
  onChange: (patch: SettingsPatch) => void;
}) {
  return (
    <div className="theme-grid" role="group" aria-label="Theme">
      {THEME_PREFERENCES.map((value) => {
        const selected = props.value === value;
        return (
          <button
            key={value}
            type="button"
            className="theme-card"
            aria-pressed={selected}
            title={THEME_LABELS[value]}
            onClick={() => props.onChange({ theme: value })}
          >
            <span className="theme-card-check" aria-hidden="true">
              <Icon name="check" size={11} strokeWidth={2.5} />
            </span>
            <span className="theme-card-thumb">
              {value === "system" ? (
                <>
                  <ThemeThumb theme="light" half />
                  <ThemeThumb theme="black" half />
                </>
              ) : (
                <ThemeThumb theme={value} />
              )}
            </span>
            <span className="theme-card-name">{THEME_LABELS[value]}</span>
          </button>
        );
      })}
    </div>
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
