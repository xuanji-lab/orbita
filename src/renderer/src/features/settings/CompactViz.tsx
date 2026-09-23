import { COMPACTION_PERCENT } from "@shared/settings";
import { COMPACTION_CHOICES, compactPosition } from "./compact-viz.ts";

/**
 * Auto-compact 刻度条：chips 已经是精确输入，这条只是把当前百分比翻译成
 * 「槽上的哪个位置」——纯展示，不可拖拽也不可点击（`aria-hidden`，数值已经由
 * chips 表达过一遍）。`compaction.enabled === false` 时调用方直接不渲染这个
 * 组件（SettingsView.tsx 的条件渲染），不是这里隐藏。
 */
export function CompactViz(props: { percent: number }) {
  return (
    <div className="compact-viz" aria-hidden="true">
      <div className="compact-track">
        {COMPACTION_CHOICES.map((choice) => (
          <span
            key={choice}
            className="compact-tick"
            style={{ left: `${compactPosition(choice) * 100}%` }}
          />
        ))}
        <span className="compact-pos" style={{ left: `${compactPosition(props.percent) * 100}%` }}>
          <span className="compact-pos-label">{props.percent}%</span>
        </span>
      </div>
      <div className="compact-ends">
        <span>{COMPACTION_PERCENT.max}% · compact early</span>
        <span>{COMPACTION_PERCENT.min}% · compact late</span>
      </div>
    </div>
  );
}
