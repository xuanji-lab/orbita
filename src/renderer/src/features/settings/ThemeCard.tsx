import { selectableThemes, type SettingsPatch, type ThemePreference } from "@shared/settings";
import { Icon } from "../../shell/Icon";
import { useSettingTip } from "./InfoTip";
import { useT } from "../../locale.ts";
import type { Messages } from "../../messages-en.ts";

/**
 * 需要说明的只有三档：System 是唯一「选了不知道会落在哪」的一档，纸面两档要说清
 * 只有浅色。说明挂在卡片自己身上（悬停 / 键盘聚焦），不另放 info 图标——卡片的
 * 对半缩略窗已经说了一半。名字与说明都跟界面语言走（messages-*.ts 的 themes）。
 */
function themeTip(value: ThemePreference, t: Messages): string | undefined {
  if (value === "system") return t.themes.systemTip;
  if (value === "copybook") return t.themes.copybookTip;
  if (value === "typescript") return t.themes.typescriptTip;
  return undefined;
}

/** `data-theme-preview` 认除 system 之外的每个真实主题；System 卡的缩略窗对半拼 light + black */
type PreviewTheme = Exclude<ThemePreference, "system">;

/**
 * Theme 行的预览卡组：每张卡画一份缩略窗（壳色 + 侧栏 + 面板 + accent 发送点），
 * 用**各自主题**的 token 画——不是当前主题的（见 ThemeThumb 与
 * `Orbita Design System/tokens/colors.css` 的 `[data-theme-preview]` 选择器）。
 * 只有 Theme 这一行用它，不拆成多个导出。
 *
 * 可选档位过 `selectableThemes(experimental)`：实验开关关闭时纸面两档
 * （copybook / typescript）不出现在选择卡里。**已存的主题不受影响**——恰好
 * 存着这两档之一的用户主题照常应用，只是没有选中卡可看（不崩、不退回
 * system），开关打开即恢复可选。
 */
export function ThemePicker(props: {
  value: ThemePreference;
  /** 实验功能开关（设置原值）：纸面两档挂它后面 */
  experimental: boolean;
  onChange: (patch: SettingsPatch) => void;
}) {
  const t = useT();
  return (
    <div className="theme-grid" role="group" aria-label={t.settings.theme}>
      {selectableThemes(props.experimental).map((value) => (
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
  const t = useT();
  const tipText = themeTip(props.value, t);
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
        <span className="theme-card-name">{t.themes[props.value]}</span>
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
