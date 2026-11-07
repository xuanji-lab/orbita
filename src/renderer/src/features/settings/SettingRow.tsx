/**
 * 设置面的两个行原语（`.set-group` / `.set-row` 语言）。
 *
 * 原本住在 SettingsView.tsx 里，2026-10 更新卡（UpdateCard.tsx）成为第二个消费者时
 * 抽到这里——设计系统的规矩是「同一份样式对象被复制进第二个文件，就该抽出组件，
 * 而不是复制一份」。
 */

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
 * 一条设置：左边是名字与它下面一行说明，右边是控件与它的效果预览。
 *
 * **说明常驻、不进悬停**（2026-10-30）：原来通用页把说明收进名字旁的 ⓘ，语音页把说明
 * 写在名字下面——同一个设置面两种讲法；ⓘ 还要用户先猜「这里有话」再去悬停。统一成
 * 名字 base/500 + 下面一行说明 sm/tertiary，长了就折行，不截断。
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
  return (
    <div className="set-row" ref={props.rowRef}>
      <span className="set-row-head">
        <span className="set-row-name">{props.name}</span>
        {props.info !== undefined && <span className="set-row-desc">{props.info}</span>}
        {props.note}
      </span>
      <div className="set-row-ctl">{props.children}</div>
      {props.below}
    </div>
  );
}
