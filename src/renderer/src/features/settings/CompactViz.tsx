import { Icon } from "../../shell/Icon";
import { compactMark } from "./compact-viz.ts";
import { useT } from "../../locale.ts";

/**
 * Auto-compact 的效果预览：整条 = 一个上下文窗口，竖线 = 折叠点（剩 N% 时折叠），
 * 竖线右边的斜纹是折叠时还剩的那一截。它代替了原来那句「remaining context drops to
 * this level」——看条就知道百分比指的是「剩多少」而不是「用了多少」。
 *
 * 纯展示（`aria-hidden`，数值已经由 chips 表达过一遍）；`compaction.enabled === false`
 * 时调用方直接不渲染（SettingsView.tsx 的条件渲染），Off 没有折叠点可画。
 */
export function CompactViz(props: { percent: number }) {
  const t = useT();
  const mark = compactMark(props.percent);
  return (
    <div className="compact-viz" aria-hidden="true">
      <div className="compact-track">
        <span className="compact-used" style={{ width: `${mark.at}%` }} />
        <span className="compact-rest" style={{ width: `${100 - mark.at}%` }} />
        <span className="compact-mark" style={{ left: `${mark.at}%` }}>
          <span className="compact-mark-label" data-align={mark.labelAlign}>
            <Icon name="fold-vertical" size={10} />
            {t.settings.compactLeft(props.percent)}
          </span>
        </span>
      </div>
      <div className="compact-ends">
        <span>{t.settings.compactHistory}</span>
        <span>{t.settings.compactSummary}</span>
      </div>
    </div>
  );
}
