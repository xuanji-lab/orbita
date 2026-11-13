import { PIE_FRACTION, wedgePath, type PieFill } from "./status-pie.ts";

/**
 * 会话运行态的状态饼（2026-10-30，取代三节竖条）：1/3 蓝 = 在跑，2/3 橙 = 在等你，
 * 满绿 = 跑完没看，满红 = 出错没看。**静态，无动效**。竖条 3px 宽、每节 4px 高，
 * 侧栏里读不出是哪一档；饼 10px，份数靠面积读，颜色是第二信号（title 补文字）。
 * 颜色走 styles.css 的 `.status-pie[data-fill]`（token，不写裸色），这里只画形状。
 */
export function StatusPie(props: { state: PieFill; title?: string | undefined; className?: string }) {
  const fraction = PIE_FRACTION[props.state];
  return (
    <svg
      className={`status-pie${props.className === undefined ? "" : ` ${props.className}`}`}
      data-fill={props.state}
      viewBox="0 0 10 10"
      width={10}
      height={10}
      role={props.title === undefined ? undefined : "img"}
      aria-label={props.title}
      aria-hidden={props.title === undefined ? true : undefined}
    >
      {props.title !== undefined && <title>{props.title}</title>}
      {fraction === 1 ? (
        <circle cx="5" cy="5" r="4.25" fill="currentColor" />
      ) : (
        <>
          <circle cx="5" cy="5" r="4.25" fill="none" stroke="currentColor" strokeWidth="1.5" />
          <path d={wedgePath(fraction)} fill="currentColor" />
        </>
      )}
    </svg>
  );
}
