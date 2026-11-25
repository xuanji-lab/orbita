import Svg, { Circle, Ellipse, Line, Path, Polygon, Polyline, Rect } from "react-native-svg";
import type { ReactElement } from "react";
import { ICON_ELEMENTS, type IconName, type IconTag } from "../theme/icons.gen.ts";

export type { IconName };

/** lucide 单色线图标（与桌面同一份 lucide-static@1.33.0 文件），描边色由调用方给 token 色 */
export function Icon(props: { name: IconName; size?: number; color: string; strokeWidth?: number }) {
  const size = props.size ?? 16;
  return (
    <Svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={props.color}
      strokeWidth={props.strokeWidth ?? 1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {ICON_ELEMENTS[props.name].map(([tag, attrs], index) => element(tag, attrs, index))}
    </Svg>
  );
}

function element(tag: IconTag, attrs: Readonly<Record<string, string>>, key: number): ReactElement {
  switch (tag) {
    case "path":
      return <Path key={key} d={attrs["d"] ?? ""} />;
    case "circle":
      return <Circle key={key} cx={attrs["cx"]} cy={attrs["cy"]} r={attrs["r"]} />;
    case "rect":
      return (
        <Rect key={key} x={attrs["x"]} y={attrs["y"]} width={attrs["width"]} height={attrs["height"]} rx={attrs["rx"]} ry={attrs["ry"]} />
      );
    case "line":
      return <Line key={key} x1={attrs["x1"]} y1={attrs["y1"]} x2={attrs["x2"]} y2={attrs["y2"]} />;
    case "polyline":
      return <Polyline key={key} points={attrs["points"] ?? ""} />;
    case "polygon":
      return <Polygon key={key} points={attrs["points"] ?? ""} />;
    case "ellipse":
      return <Ellipse key={key} cx={attrs["cx"]} cy={attrs["cy"]} rx={attrs["rx"]} ry={attrs["ry"]} />;
  }
}
