import { useT } from "../../locale.ts";
import { InlineMarks } from "../../shell/InlineMarks";
import { StatusPie } from "../../shell/StatusPie";
import type { PieFill } from "../../shell/status-pie.ts";
import { runStateLabel } from "../notify/completion-notice.ts";
import type { HomeLogGroupId } from "./home-cards.ts";

/** 记录里一行要画的全部数据：状态 / 那一句 / 在哪 / 多久前都由 ChatView 按槽里的实况现算好 */
export interface HomeLogRowView {
  sessionId: string;
  title: string;
  state: PieFill | null;
  /** 此刻在干什么（homeCardLine）；说不出来 = null，那一格留空 */
  line: string | null;
  /** 工作区名或「任务」——只进 tooltip，不占行内位置 */
  where: string;
  /** 多久前；在跑 / 等你不写 */
  time: string | null;
}

/**
 * 首页的「记录」（2026-11-07 方向 N，取代三张等重的会话卡）：按「等你 / 进行中 / 最近」分组的
 * 一行一条的会话列表。版式叫**记录行**：名字（13em）｜一句此刻在干什么（次级墨、单行省略）｜行尾时间；
 * 组名落在左侧的**索引边栏**里，状态饼落在**子午线**上（圆心压线），没有状态的会话是线上的一个小点。
 * 版式登记、几何与理由见 styles.css 的「索引边栏 / 子午线 / 记录行」节。
 *
 * 一行就是一个 `<button>`：键盘可达、Enter / 空格进会话、焦点环走全局 `:focus-visible`；
 * 悬停与选中走 `.option-row` 的同一套配方，不另立一种 hover。
 */
export function HomeLog(props: {
  groups: readonly { group: HomeLogGroupId; rows: readonly HomeLogRowView[] }[];
  loading: boolean;
  onOpen: (sessionId: string) => void;
}) {
  const t = useT();
  if (props.loading) {
    // 列表还在读：三行骨架（安静的灰块，不闪），形状与真行一致，读完不跳
    return (
      <div className="home-log" aria-hidden="true">
        {[0, 1, 2].map((index) => (
          <div key={index} className="log-row log-row-skeleton">
            <span className="log-skel" style={{ width: "62%" }} />
            <span className="log-skel" style={{ width: "88%" }} />
            <span />
          </div>
        ))}
      </div>
    );
  }
  if (props.groups.length === 0) return null;
  return (
    <div className="home-log">
      {props.groups.map((group) => (
        <section key={group.group} className="log-group" data-g={group.group} aria-label={t.homeCard.group[group.group]}>
          <h2 className="log-head">{t.homeCard.group[group.group]}</h2>
          {group.rows.map((row) => (
            <button
              key={row.sessionId}
              type="button"
              className="log-row option-row"
              title={row.where}
              onClick={() => props.onOpen(row.sessionId)}
            >
              <span className="log-name">
                {row.state === null ? (
                  <span className="log-dot" aria-hidden="true" />
                ) : (
                  <StatusPie state={row.state} title={runStateLabel(row.state, t)} />
                )}
                <span className="t">{row.title}</span>
              </span>
              <span className="log-line">{row.line !== null && <InlineMarks text={row.line} />}</span>
              <span className="log-time">{row.time}</span>
            </button>
          ))}
        </section>
      ))}
    </div>
  );
}
