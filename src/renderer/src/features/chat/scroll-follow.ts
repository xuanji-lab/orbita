/**
 * 聊天转录的显式跟随态（Latest | Reading）——纯模块，不依赖 React / DOM，可被
 * `node --test` 直接加载。
 *
 * 为什么不再用「每次 commit 只要 follow 为真就贴底」：那个布尔值的唯一写入口是
 * scroll 事件，而 scroll 事件分不清是用户滚动还是我们自己赋值 scrollTop 的余波。
 * 用户上滚离开底部后，一次测高 / 内容长高 / 程序化贴底触发的 scroll 就可能把
 * 视口拉回底部——人正在读历史，屏幕自己跳走。显式两态把「谁有权改跟随」写清楚：
 *
 * - 只有**用户意图窗口**内的滚动（wheel / touchmove / keydown / 滚动条 pointerdown，
 *   见 `noteFollowIntent`）与「没捕获到意图、但位置确实离底」的兜底能进入 Reading；
 * - Latest → Reading 之后，**任何**程序化滚动都不会把状态改回 Latest；
 * - 只有用户意图窗口内滚回底部（`isAtBottom`，40px 容差）才恢复 Latest。
 *
 * 意图窗口的时长（TTL）：滚动事件在默认动作之后才派发，窗口要盖住「事件已到、
 * 滚动还没落地」的那一两帧；同时也覆盖一次带惯性的滚轮 / 触摸手势。1.2 s 是
 * 够用又不至于把用户已经停下后的程序化滚动误判成用户滚动的量级。
 *
 * 时间一律由调用方传入（`now`），模块本身不读时钟——测试可以精确控制时序。
 */
import { isAtBottom } from "./scroll.ts";

export type FollowState = "latest" | "reading";

/** 用户意图窗口时长：盖住「意图事件已到、滚动还没派发」的几帧，也盖住一次惯性手势 */
export const FOLLOW_INTENT_TTL_MS = 1200;

/**
 * 程序化改 scrollTop 之后的静默期：这段时间里位置离底不当作「用户滚走了」。
 * 我们自己贴底时 ends at bottom，正常不会触发；但分页锚定 / 测高可能把位置
 * 留在离底处，那一下的 scroll 事件不是用户意图。
 */
export const PROGRAMMATIC_GRACE_MS = 250;

/** 程序化「滚到底」（回底按钮 / 切会话）的动画窗口：窗口内到不了底不改态，也不抢动画 */
export const JUMP_WINDOW_MS = 1500;

/**
 * 用户意图的方向。钉底与「往下滚」同向——用户往下滚时不暂停贴底，否则正好在
 * 底部轻滚一下就会让内容在视口外长 1.2 s 再跳回来。
 */
export type FollowIntentDirection = "up" | "down" | "unknown";

export interface FollowTracker {
  state: FollowState;
  /** 用户意图窗口截止时刻（ms） */
  intentUntil: number;
  /** 意图窗口内已经收到过滚动事件：位置已经表过态，钉底可以恢复 */
  intentSettled: boolean;
  /** 本次意图的方向（`noteFollowIntent` 写入） */
  intentDirection: FollowIntentDirection;
  /** 最近一次程序化改 scrollTop 的时刻（ms） */
  pinnedAt: number;
  /** 程序化回底动画窗口截止时刻（ms） */
  jumpUntil: number;
}

export interface ScrollSnapshot {
  scrollTop: number;
  /** 视口高度（clientHeight） */
  viewportHeight: number;
  /** 内容高度（scrollHeight） */
  scrollHeight: number;
}

export function createFollowTracker(): FollowTracker {
  return {
    state: "latest",
    intentUntil: 0,
    intentSettled: false,
    intentDirection: "unknown",
    pinnedAt: 0,
    jumpUntil: 0,
  };
}

/**
 * 记一次用户滚动意图（捕获阶段的 wheel / touchmove / keydown / 滚动条 pointerdown）。
 * 不改跟随态——意图只说明「接下来的滚动是用户干的」，位置由随后的滚动事件说话。
 * 向下意图同时清掉「暂停钉底」的效果（见 `mayPinToBottom`）。
 */
export function noteFollowIntent(
  tracker: FollowTracker,
  now: number,
  direction: FollowIntentDirection = "unknown",
): void {
  tracker.intentUntil = now + FOLLOW_INTENT_TTL_MS;
  tracker.intentSettled = false;
  tracker.intentDirection = direction;
}

/** 无条件恢复 Latest（切会话 / 发送新消息）：即时贴底，不设动画窗口 */
export function forceFollowLatest(tracker: FollowTracker): void {
  tracker.state = "latest";
  tracker.intentUntil = 0;
  tracker.intentSettled = false;
  tracker.intentDirection = "unknown";
  tracker.jumpUntil = 0;
}

/**
 * 无条件进入 Reading（跳转到某条历史 / 回退预演切点）：程序化定位之后，贴底逻辑
 * 不得在下一帧把视口拉回底部；用户滚回底部自然恢复 Latest。
 */
export function forceReading(tracker: FollowTracker): void {
  tracker.state = "reading";
  tracker.intentUntil = 0;
  tracker.intentSettled = false;
  tracker.intentDirection = "unknown";
  tracker.jumpUntil = 0;
}

/**
 * 程序化「滚到底」动画（回底按钮）：直接进 Latest，并在动画窗口内锁住状态
 * （smooth 滚动途中的 scroll 事件不能把状态改成 Reading，否则动画到不了底）。
 * 钉底不受这个窗口限制：真在流式输出时提前钉到底，等于把动画收个尾。
 */
export function noteFollowJump(
  tracker: FollowTracker,
  now: number,
  durationMs: number = JUMP_WINDOW_MS,
): void {
  forceFollowLatest(tracker);
  tracker.jumpUntil = now + durationMs;
}

/** 我们自己写了 scrollTop（钉底 / 分页锚定）：记下时刻，给「位置离底」的兜底判定一个静默期 */
export function notePinnedScroll(tracker: FollowTracker, now: number): void {
  tracker.pinnedAt = now;
}

/**
 * 处理一次 scroll 事件，返回新的跟随态。规则：
 *
 * 1. 意图窗口内：按位置表态——贴底 → Latest，离底 → Reading；
 * 2. 程序化回底动画窗口内：到不了底不改态（动画还在走）；
 * 3. 窗口外：Reading 永远不会被改回 Latest；Latest 下位置离底且不在程序化静默期，
 *    按用户滚动处理（兜底没捕获到意图的路径，例如滚动条拖动的事件未派发到元素上）。
 *
 * 内容长高不改 scrollTop、不派发 scroll；滚动锚定在贴底时保持贴底——两者都不会
 * 误伤 Latest。Reading 下的任何程序化滚动（跳转、测高、分页锚定）都停在 Reading。
 */
export function noteFollowScroll(
  tracker: FollowTracker,
  snapshot: ScrollSnapshot,
  now: number,
): FollowState {
  const atBottom = isAtBottom(snapshot.scrollTop, snapshot.viewportHeight, snapshot.scrollHeight);
  if (now < tracker.intentUntil) {
    tracker.intentSettled = true;
    tracker.state = atBottom ? "latest" : "reading";
    return tracker.state;
  }
  if (now < tracker.jumpUntil) {
    if (atBottom) tracker.state = "latest";
    return tracker.state;
  }
  if (
    tracker.state === "latest" &&
    !atBottom &&
    now - tracker.pinnedAt > PROGRAMMATIC_GRACE_MS
  ) {
    tracker.state = "reading";
  }
  return tracker.state;
}

/**
 * 这次 commit 该不该把 scrollTop 钉到底。
 *
 * - Reading 一律不钉——这是整个显式状态要保证的事；
 * - 用户意图已到、滚动事件还没来、且意图是「往上」/方向不明时先不钉：等位置
 *   说话，否则会把用户的上滚吃掉。向下意图不暂停（钉底与用户意图同向）。
 */
export function mayPinToBottom(tracker: FollowTracker, now: number): boolean {
  if (tracker.state !== "latest") return false;
  if (
    now < tracker.intentUntil &&
    !tracker.intentSettled &&
    tracker.intentDirection !== "down"
  ) {
    return false;
  }
  return true;
}

/** 当前是否在跟随（Reading 时新内容只提示、不拉回） */
export function isFollowing(tracker: FollowTracker): boolean {
  return tracker.state === "latest";
}

/** 让聊天面纵向滚动的按键（PageUp/Down、Home/End、上下方向键、空格） */
const SCROLL_INTENT_KEYS: ReadonlySet<string> = new Set([
  "PageUp",
  "PageDown",
  "Home",
  "End",
  "ArrowUp",
  "ArrowDown",
  " ",
  "Spacebar",
]);

/**
 * 这次 keydown 算不算「用户要滚聊天面」：是滚动键、没有 ctrl/meta/alt、焦点不在
 * 可编辑元素里（INPUT / TEXTAREA / contentEditable / SELECT——输入框里的方向键是光标）。
 * 返回意图方向；null = 不接管。
 */
export function scrollIntentDirection(
  key: string,
  target: { tagName: string; isContentEditable: boolean },
  modifiers: { ctrl: boolean; meta: boolean; alt: boolean; shift: boolean },
): FollowIntentDirection | null {
  if (!SCROLL_INTENT_KEYS.has(key)) return null;
  if (modifiers.ctrl || modifiers.meta || modifiers.alt) return null;
  const tag = target.tagName.toUpperCase();
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable) return null;
  if (key === "PageUp" || key === "ArrowUp" || key === "Home") return "up";
  if ((key === " " || key === "Spacebar") && modifiers.shift) return "up";
  return "down";
}

/**
 * pointerdown 是不是落在滚动条上（Chromium 把事件派给滚动容器本身，偏移量超出
 * client 区域）。参数摊平、不碰 DOM，方便测试。
 */
export function isScrollbarPointer(
  onScroller: boolean,
  offsetX: number,
  offsetY: number,
  clientWidth: number,
  clientHeight: number,
): boolean {
  if (!onScroller) return false;
  return offsetX > clientWidth || offsetY > clientHeight;
}
