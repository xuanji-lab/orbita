import { createContext, useContext } from "react";
// 值 import 走相对路径：node --test 解析不了 @shared 别名
import { GALAXY_TILT } from "../../../../shared/settings.ts";

/**
 * 星系倾角（设置 › 外观 › 星系倾角，度）：App 从设置里读出来往下发，单智能体首页、编排 New Task 页、右栏星系图、
 * 设计面板的轨道预览都从这里取，同一个值（2026-11-24 用户：两边的倾角要 consistent，并且要能自己选）。
 * 没有提供者时（测试、单独渲染）是默认值。
 */
export const GalaxyTiltContext = createContext<number>(GALAXY_TILT.default);

export function useGalaxyTilt(): number {
  return useContext(GalaxyTiltContext);
}
