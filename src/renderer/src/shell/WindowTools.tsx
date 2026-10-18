import { Icon, type IconName } from "./Icon";
import { useT } from "../locale.ts";

/**
 * 收起态的「窗口工具」组：侧栏开关 + 新任务，嵌在对话卡页头的最左边
 * （mac 红绿灯在它们左边的净空里，由页头的 `--window-tools-inset` 留位）。
 *
 * 收起后没有左侧图标条（2026-10-18 用户裁决），这一组就是侧栏的全部出入口；
 * 左缘的窗口 x 与展开态侧栏顶行的开关同一个位置（几何见 `window-tools.ts`，
 * 由同一套常量保证）。按钮沿用 RailButton 配方——两侧同款同尺寸，开关在
 * 开合之间连大小都不变。
 */
export function WindowTools(props: { onExpand: () => void; onNewTask: () => void }) {
  const t = useT();
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 4, flex: "0 0 auto" }}>
      <RailButton icon="panel-left" title={t.sidebar.expand} onClick={props.onExpand} />
      <RailButton icon="plus" title={t.common.newTask} accent onClick={props.onNewTask} />
    </span>
  );
}

/**
 * 图标条时代的按钮（设计系统 components/navigation/RailButton）：
 * 外框 --titlebar-control（24px，顶部栏公共规定），**tooltip 是它唯一的标签**；
 * 图标尺寸由顶部栏作用域接管（14px）——这里给的是请求值。
 * 当前项用模式选中色（R4-03 修正：明蓝暗黄）；accent 只给 New task 这个主操作
 * （styles.css 的 `.rail-btn[data-accent]` 常显 accent 态）。
 */
export function RailButton(props: {
  icon: IconName;
  title: string;
  active?: boolean;
  accent?: boolean;
  onClick?: () => void;
}) {
  const active = props.active === true;
  const accent = props.accent === true;
  return (
    <button
      type="button"
      className="quiet-control rail-btn"
      title={props.title}
      aria-label={props.title}
      aria-pressed={active || accent ? true : undefined}
      data-accent={accent || undefined}
      onClick={props.onClick}
      style={{
        display: "grid",
        placeItems: "center",
        width: "var(--titlebar-control)",
        height: "var(--titlebar-control)",
        flex: "0 0 auto",
        border: 0,
        borderRadius: "var(--radius-md)",
        cursor: "pointer",
      }}
    >
      <Icon name={props.icon} size={14} />
    </button>
  );
}
