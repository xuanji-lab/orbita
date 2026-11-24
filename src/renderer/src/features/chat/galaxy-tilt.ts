import { createContext, useContext, useSyncExternalStore } from "react";
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

/**
 * 星系的方位角（转台，度）与「左右拖动旋转星系」开关：与倾角一样由 App 从设置里读出来往下发，四处同一个值。
 * 没有提供者时是默认（0°、开）。
 */
export interface GalaxyView {
  azimuth: number;
  turntable: boolean;
  /** 缩放（倍，设置里的 galaxyZoom） */
  zoom: number;
}

export const GalaxyViewContext = createContext<GalaxyView>({ azimuth: 0, turntable: true, zoom: 1 });

export function useGalaxyView(): GalaxyView {
  return useContext(GalaxyViewContext);
}

/**
 * 改星系视角（写设置：倾角与设置 › 外观的滑块同一个字段，方位角另一个字段）：星系空白处拖动松手、方向键、双击复位时调它。
 * 没有提供者（测试、设置页的小预览）= null，星系就不接拖动。
 */
export type GalaxyViewSetter = (view: { tilt?: number; azimuth?: number; zoom?: number }) => void;

export const GalaxyTiltSetterContext = createContext<GalaxyViewSetter | null>(null);

export function useGalaxyTiltSetter(): GalaxyViewSetter | null {
  return useContext(GalaxyTiltSetterContext);
}

/**
 * 哪块画布把俯角自动抬高了（屏幕安全布局：子智能体在设置的俯角下装不下时，只对这一块画布抬到刚好装得下）。
 * 每个星系组件挂着时上报自己画在多少度；设置页那一行据此写一句「右栏星系图较窄，自动抬高到 X°」。
 */
export type GalaxySurface = "home" | "page" | "panel";
const raised = new Map<GalaxySurface, number>();
let snapshot: ReadonlyMap<GalaxySurface, number> = new Map();
const listeners = new Set<() => void>();

export function reportElevation(surface: GalaxySurface, tilt: number, actual: number | null): void {
  const before = raised.get(surface);
  if (actual === null || actual <= tilt) raised.delete(surface);
  else raised.set(surface, Math.round(actual));
  if (raised.get(surface) === before) return;
  snapshot = new Map(raised);
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useRaisedSurfaces(): ReadonlyMap<GalaxySurface, number> {
  return useSyncExternalStore(subscribe, () => snapshot);
}
