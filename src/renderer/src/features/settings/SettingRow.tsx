/**
 * 设置面的两个行原语（`.set-group` / `.set-row` 语言）。
 *
 * 原本住在 SettingsView.tsx 里，2026-10 更新卡（UpdateCard.tsx）成为第二个消费者时
 * 抽到这里——设计系统的规矩是「同一份样式对象被复制进第二个文件，就该抽出组件，
 * 而不是复制一份」。
 */
import { InfoTip } from "./InfoTip";
import { useT } from "../../locale.ts";

/**
 * 分组：标题与侧栏的节点标题同一个处理（`.section-label`，UI 字、sm、semibold，
 * Migration 同用）。最后一组的最后一行不画底线（`.set-group:last-child` 那条 CSS）。
 */
export function SettingGroup(props: { label: string; children: React.ReactNode }) {
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
 *
 * `below` 是行底整幅的一格（`grid-column: 1 / -1`）：下载进度条、推出的一层更新内容——
 * 它们既不属于左列（名字与状态）也不属于右列（控件）。
 */
export function SettingRow(props: {
  name: string;
  info?: React.ReactNode;
  note?: React.ReactNode;
  below?: React.ReactNode;
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
      {props.below}
    </div>
  );
}
