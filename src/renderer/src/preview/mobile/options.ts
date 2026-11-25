import { LANGUAGES, type Language } from "../../../../shared/settings.ts";

/**
 * 手机端设计稿的 URL 参数（2026-11-25）。只在 preview.html 上、带 `surface=mobile` 时生效；
 * 其余参数缺省或写错都退回一个确定的画面，不读本机数据。
 *
 *   preview.html?surface=mobile&screen=list&scene=full&device=android&theme=light&lang=zh
 *
 * - screen：pair（配对）/ list（会话清单）/ chat（对话）/ overview（总览图）/ sheet（某一屏的全部状态排一行）
 * - scene：清单的三档量 empty / typical / full
 * - state：pair 的 empty / expired / offline；chat 的 typical / full / loading / reconnecting / reply-running / waiting
 * - device：android（412×915）/ ipad（iPad mini 竖屏 744×1133）
 * - theme：light / black（玄）
 * - compare=desktop：手机旁边放一份同主题的桌面预览（同屏对照）
 * - tall=1：清单不裁到屏高，整列画出来（看满载时下面的工作区）
 */

export const MOBILE_SCREENS = ["pair", "list", "chat", "overview", "sheet"] as const;
export type MobileScreen = (typeof MOBILE_SCREENS)[number];
export const MOBILE_SCENES = ["empty", "typical", "full"] as const;
export type MobileScene = (typeof MOBILE_SCENES)[number];
export const PAIR_STATES = ["empty", "expired", "offline"] as const;
export type PairState = (typeof PAIR_STATES)[number];
export const CHAT_STATES = ["typical", "full", "waiting", "loading", "reconnecting", "reply-running"] as const;
export type ChatState = (typeof CHAT_STATES)[number];
export const MOBILE_DEVICES = ["android", "ipad"] as const;
export type MobileDevice = (typeof MOBILE_DEVICES)[number];
export const MOBILE_THEMES = ["light", "black"] as const;
export type MobileTheme = (typeof MOBILE_THEMES)[number];

export interface MobileOptions {
  screen: MobileScreen;
  /** sheet 要排的那一屏 */
  sheetOf: Exclude<MobileScreen, "sheet" | "overview">;
  scene: MobileScene;
  pairState: PairState;
  chatState: ChatState;
  device: MobileDevice;
  theme: MobileTheme;
  language: Language;
  compare: boolean;
  tall: boolean;
}

function pick<T extends string>(values: readonly T[], raw: string | null, fallback: T): T {
  return (values as readonly string[]).includes(raw ?? "") ? (raw as T) : fallback;
}

/** 不是手机设计稿（没有 surface=mobile）→ null，预览照常起桌面 App */
export function parseMobileOptions(search: string): MobileOptions | null {
  const query = new URLSearchParams(search);
  if (query.get("surface") !== "mobile") return null;
  const screen = pick(MOBILE_SCREENS, query.get("screen"), "list");
  const state = query.get("state");
  return {
    screen,
    sheetOf: pick(["pair", "list", "chat"] as const, query.get("of"), "list"),
    scene: pick(MOBILE_SCENES, query.get("scene"), "typical"),
    pairState: pick(PAIR_STATES, state, "empty"),
    chatState: pick(CHAT_STATES, state, "typical"),
    device: pick(MOBILE_DEVICES, query.get("device"), "android"),
    theme: pick(MOBILE_THEMES, query.get("theme"), "light"),
    language: pick(LANGUAGES, query.get("lang"), "zh"),
    compare: query.get("compare") === "desktop",
    tall: query.get("tall") === "1",
  };
}
