import Svg, { Circle, Path } from "react-native-svg";
import type { MobileSessionState } from "../../../src/shared/mobile.ts";
import type { Theme } from "../theme/theme.ts";

type PieFill = Exclude<MobileSessionState, "idle">;

/** 与桌面 status-pie.ts 同一套份数：1/3 在跑、2/3 等你、满圆跑完 / 出错 */
const FRACTION: Readonly<Record<PieFill, number>> = { running: 1 / 3, waiting: 2 / 3, done: 1, failed: 1 };

/** 与桌面 `wedgePath` 同一个算法（viewBox 0 0 10 10，从 12 点顺时针） */
function wedgePath(fraction: number, r = 4.25): string {
  const a = fraction * 2 * Math.PI;
  const x = 5 + r * Math.sin(a);
  const y = 5 - r * Math.cos(a);
  return `M5 5V${(5 - r).toFixed(2)}A${r} ${r} 0 ${fraction > 0.5 ? 1 : 0} 1 ${x.toFixed(2)} ${y.toFixed(2)}z`;
}

/**
 * 会话运行态的状态饼（桌面 StatusPie 的手机版）：静态，无动效；颜色是第二信号，读屏靠 label。
 * `stale`：断线时颜色退成三级灰——颜色是「此刻」的信号，断线时它已经不是此刻。
 */
export function StatusPie(props: { state: PieFill; theme: Theme; stale?: boolean; label?: string }) {
  const { color } = props.theme;
  const tone = props.stale
    ? color.textTertiary
    : props.state === "running"
      ? color.info
      : props.state === "waiting"
        ? color.warning
        : props.state === "done"
          ? color.success
          : color.danger;
  const fraction = FRACTION[props.state];
  return (
    <Svg width={10} height={10} viewBox="0 0 10 10" accessibilityLabel={props.label}>
      {fraction === 1 ? (
        <Circle cx="5" cy="5" r="4.25" fill={tone} />
      ) : (
        <>
          <Circle cx="5" cy="5" r="4.25" fill="none" stroke={tone} strokeWidth="1.5" />
          <Path d={wedgePath(fraction)} fill={tone} />
        </>
      )}
    </Svg>
  );
}
