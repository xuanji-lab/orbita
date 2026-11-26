import { createContext, useContext } from "react";

/**
 * 星系上能点的东西各去哪（2026-11-24 设计审查 R1：星系可看不可点）。App 提供，New Task 页的大星系与右栏星系图共用：
 * - 碎石（一条会话）→ 打开那条会话；
 * - 行星（子智能体）→ 打开星系设计面板，停在那颗行星；
 * - 主星（主智能体）→ 打开星系设计面板的主星页；
 * - 「全部 N 条会话」（键盘 / 读屏入口，平时视觉隐藏）→ 打开右栏编排面板的树状图（回旧会话的正门）。
 * 没有提供者（单智能体形态）时星系照旧只是图。
 */
export interface GalaxyActions {
  openSession: (sessionId: string) => void;
  openPlanet: (workspaceId: string, planetId: string) => void;
  openStar: (workspaceId: string) => void;
  openTree: () => void;
}

export const GalaxyActionsContext = createContext<GalaxyActions | null>(null);

export function useGalaxyActions(): GalaxyActions | null {
  return useContext(GalaxyActionsContext);
}

/** 设计面板要停在哪颗天体上：nonce 每次点击 +1，同一颗连点两次也会重新落位 */
export type DesignerFocus = { kind: "star"; nonce: number } | { kind: "planet"; id: string; nonce: number };
