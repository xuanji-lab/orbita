/**
 * 子回报「不打岔」的外部状态：开关（按会话）、攒着的回报、「稍后」收起、阅读信号。
 *
 * **为什么是模块级外部存储而不是 SessionStates 的字段**：开关与攒着的东西要被四处读写——
 * 引擎（子回报到达 / 一轮结束时的投递判定）、对话面（那一行提示）、状态卡（开关与小红点）、
 * 子会话面板（「待讨论」组），而它们不在同一棵 props 链上；信号（输入框有字、对话列不在底部）也来自引擎之外。
 * 判定本身是纯函数（channel-hold.ts），这里只管存、通知与计时。
 *
 * 落盘（localStorage，与状态卡的开合同一档）：
 * - 开关：关着的会话 id 列表（默认开，见 HOLD_OFF_KEY）。
 * - 待投回报：{谁, 哪条}的引用（正文在通道账本里，恢复时回读），到达时记、投递 / 撤回 / 被回答时抹。
 *   这同时补上了此前的缺口：排队队列纯内存，重启 / 刷新就丢子会话的回报。
 */
import { useSyncExternalStore } from "react";
import type { ChannelMessage } from "../../../../shared/channel.ts";
import {
  addHeld,
  decodePending,
  dropAnsweredQuestions,
  encodePending,
  HOLD_POLL_MS,
  readingReason,
  removeHeld,
  shouldAutoRelease,
  shouldHold,
  summarizeHeld,
  type HeldReport,
  type HeldSummary,
  type PendingRef,
  type ReadingReason,
  type ReadingSignals,
} from "./channel-hold.ts";

/**
 * 「不打岔」默认开（2026-11-23 用户：开关给他掌控感，攒着、由他决定什么时候讨论）。
 * 所以落盘的是**关着的会话** id：没记录 = 开。旧的 `.on` 键（上一版默认关时记开着的）不再读。
 */
export const HOLD_OFF_KEY = "orbita.channelHold.off";
export const HOLD_PENDING_KEY = "orbita.channelHold.pending";

export interface HoldStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** 引擎挂进来的能力：读父会话的相位、把攒着的强制投出去、开关打开时把队列里的子回报拉回攒着 */
export interface ChannelHoldHost {
  phaseOf(parentId: string): "idle" | "turn" | "compaction";
  /** 强制投递（不再过攒着的判定）：入队并投。 */
  deliver(parentId: string, items: readonly HeldReport[]): void;
  /** 开关打开时：把父会话排队里还没发的 channel 项拿出来（出队），交给攒着 */
  pullQueued(parentId: string): readonly HeldReport[];
}

export interface HoldView {
  holdOn: boolean;
  held: readonly HeldReport[];
  summary: HeldSummary;
  /** 此刻为什么先没投（开关关着时才有意义）；null = 没在读 */
  reading: ReadingReason | null;
}

const EMPTY_SUMMARY = summarizeHeld([]);
const EMPTY_HELD: readonly HeldReport[] = [];

export function createChannelHoldStore(options: {
  storage: HoldStorage | null;
  now: () => number;
  /** 测试里关掉：计时由测试直接调 tick(now) */
  startTimer?: boolean;
}) {
  const { storage, now } = options;
  const startTimer = options.startTimer !== false;

  const readOff = (): Set<string> => {
    try {
      const raw = storage?.getItem(HOLD_OFF_KEY) ?? null;
      const parsed: unknown = raw === null ? [] : JSON.parse(raw);
      return new Set(Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : []);
    } catch {
      return new Set();
    }
  };
  const off = readOff();
  const pending = new Map<string, PendingRef[]>();
  for (const [parentId, refs] of decodePending(safeGet(storage, HOLD_PENDING_KEY))) pending.set(parentId, [...refs]);
  const held = new Map<string, readonly HeldReport[]>();
  const lastReading = new Map<string, ReadingReason | null>();

  // 阅读信号
  const drafts = new Set<string>();
  const viewing = new Map<string, { scrolledUp: boolean }>();
  let focused = true;
  let lastActivityAt: number | null = null;

  let host: ChannelHoldHost | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  const listeners = new Set<() => void>();
  let views = new Map<string, HoldView>();

  const emit = (): void => {
    views = new Map();
    for (const listener of listeners) listener();
  };

  function safeGet(target: HoldStorage | null, key: string): string | null {
    try {
      return target?.getItem(key) ?? null;
    } catch {
      return null;
    }
  }
  const writeOff = (): void => {
    try {
      storage?.setItem(HOLD_OFF_KEY, JSON.stringify([...off]));
    } catch {
      // 存不下就只在这次运行里生效
    }
  };
  const writePending = (): void => {
    try {
      storage?.setItem(HOLD_PENDING_KEY, encodePending(pending));
    } catch {
      // 存不下就只在这次运行里生效（风险：此时重启会丢攒着的回报，与改动前一致）
    }
  };

  const signalsOf = (parentId: string): ReadingSignals => {
    const seen = viewing.get(parentId);
    return {
      windowFocused: focused,
      draftNonEmpty: drafts.has(parentId),
      viewed: seen !== undefined,
      scrolledUp: seen?.scrolledUp === true,
      lastActivityAt,
    };
  };
  const readingOf = (parentId: string, at: number): ReadingReason | null => readingReason(signalsOf(parentId), at);

  const anyHeld = (): boolean => [...held.values()].some((list) => list.length > 0);
  const stopTimerIfIdle = (): void => {
    if (timer !== null && !anyHeld()) {
      clearInterval(timer);
      timer = null;
    }
  };
  const ensureTimer = (): void => {
    if (!startTimer || timer !== null || host === null) return;
    timer = setInterval(() => tick(now()), HOLD_POLL_MS);
  };

  function release(parentId: string): void {
    const items = held.get(parentId) ?? EMPTY_HELD;
    if (items.length === 0 || host === null) return;
    held.delete(parentId);
    lastReading.delete(parentId);
    emit();
    stopTimerIfIdle();
    host.deliver(parentId, items);
  }

  /** 复查：阅读原因变了就通知界面；满足自动投递就投。测试直接调它。 */
  function tick(at: number): void {
    let dirty = false;
    for (const [parentId, list] of [...held]) {
      if (list.length === 0) continue;
      const reading = readingOf(parentId, at);
      if (lastReading.get(parentId) !== reading) {
        lastReading.set(parentId, reading);
        dirty = true;
      }
      const phase = host?.phaseOf(parentId) ?? "turn";
      if (shouldAutoRelease({ holdOn: !off.has(parentId), phase, reading, held: list })) {
        release(parentId);
        dirty = false; // release 已经通知过
      }
    }
    if (dirty) emit();
    stopTimerIfIdle();
  }

  const self = {
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    getView(parentId: string | null): HoldView | null {
      if (parentId === null) return null;
      const cached = views.get(parentId);
      if (cached !== undefined) return cached;
      const list = held.get(parentId) ?? EMPTY_HELD;
      const view: HoldView = {
        holdOn: !off.has(parentId),
        held: list,
        summary: list.length === 0 ? EMPTY_SUMMARY : summarizeHeld(list),
        reading: list.length === 0 ? null : readingOf(parentId, now()),
      };
      views.set(parentId, view);
      return view;
    },

    isHoldOn: (parentId: string): boolean => !off.has(parentId),

    /** 此刻用户在读 / 在写吗（读真实信号；与攒着的东西有没有无关） */
    reading: (parentId: string): ReadingReason | null => readingOf(parentId, now()),

    setHoldOn(parentId: string, next: boolean): void {
      if (!off.has(parentId) === next) return;
      if (next) off.delete(parentId);
      else off.add(parentId);
      writeOff();
      // 打开的那一刻，排队里还没发的子回报也一并改成攒着，否则它们会在这一轮结束时照旧投出去
      if (next && host !== null) {
        const pulled = host.pullQueued(parentId);
        if (pulled.length > 0) {
          for (const item of pulled) held.set(parentId, addHeld(held.get(parentId) ?? EMPTY_HELD, item));
          ensureTimer();
        }
      }
      emit();
      // 关掉：攒着的按「在不在读」重新判一次，不必等下个节拍
      if (!next) tick(now());
    },

    /** 子回报到达 / 入队时记账（落盘引用）；已记过的不重复 */
    track(parentId: string, item: HeldReport): void {
      const refs = pending.get(parentId) ?? [];
      if (refs.some((ref) => ref.messageId === item.id)) return;
      pending.set(parentId, [...refs, { childId: item.childId, messageId: item.id, childWorkbench: item.childWorkbench }]);
      writePending();
    },

    /** 投出 / 撤回 / 被回答：抹掉落盘引用，同时从攒着里移出 */
    untrack(parentId: string, ids: readonly string[]): void {
      const set = new Set(ids);
      const refs = pending.get(parentId);
      if (refs !== undefined) {
        const rest = refs.filter((ref) => !set.has(ref.messageId));
        if (rest.length === 0) pending.delete(parentId);
        else pending.set(parentId, rest);
        writePending();
      }
      const list = held.get(parentId);
      if (list !== undefined) {
        const rest = removeHeld(list, set);
        if (rest !== list) {
          if (rest.length === 0) held.delete(parentId);
          else held.set(parentId, rest);
          emit();
          stopTimerIfIdle();
        }
      }
    },

    /** 先攒着 */
    hold(parentId: string, items: readonly HeldReport[]): void {
      if (items.length === 0) return;
      let list = held.get(parentId) ?? EMPTY_HELD;
      for (const item of items) list = addHeld(list, item);
      held.set(parentId, list);
      lastReading.set(parentId, readingOf(parentId, now()));
      emit();
      ensureTimer();
    },

    /** 用户直接回答了这个子会话：它早先的 question 不必再留着 */
    settleAnswered(parentId: string, childId: string, answeredAt: number): void {
      const list = held.get(parentId);
      if (list === undefined) return;
      const rest = dropAnsweredQuestions(list, childId, answeredAt);
      if (rest === list) return;
      const dropped = list.filter((item) => !rest.includes(item)).map((item) => item.id);
      self.untrack(parentId, dropped);
    },

    /** 「现在讨论」：攒着的全部强制投给父会话 */
    release,

    tick,

    attachHost(next: ChannelHoldHost): () => void {
      host = next;
      if (anyHeld()) ensureTimer();
      return () => {
        if (host === next) host = null;
        if (timer !== null) {
          clearInterval(timer);
          timer = null;
        }
      };
    },

    /**
     * 启动时把落盘引用恢复成攒着的（recovered：不自动投）。loader 回读通道账本；
     * 读不到的（会话已删 / 账本没了）抹掉。同一条已经在攒着的不重复。
     */
    async restore(loader: (parentId: string, childId: string) => Promise<readonly ChannelMessage[]>): Promise<void> {
      const snapshot = [...pending];
      for (const [parentId, refs] of snapshot) {
        const childIds = [...new Set(refs.map((ref) => ref.childId))];
        const ledgers = new Map<string, readonly ChannelMessage[]>();
        await Promise.all(
          childIds.map(async (childId) => {
            ledgers.set(childId, await loader(parentId, childId).catch(() => []));
          }),
        );
        const lost: string[] = [];
        const restored: HeldReport[] = [];
        for (const ref of refs) {
          const ledger = ledgers.get(ref.childId) ?? [];
          const message = ledger.find((entry) => entry.id === ref.messageId);
          if (message === undefined) {
            lost.push(ref.messageId);
            continue;
          }
          // 该子会话的 question 之后父已经回过（收件箱代回复）：不必再留
          const answered =
            message.kind === "question" &&
            ledger.some((entry) => entry.from === "parent" && entry.kind === "reply" && entry.createdAt > message.createdAt);
          if (answered) {
            lost.push(ref.messageId);
            continue;
          }
          restored.push({ id: ref.messageId, childId: ref.childId, childWorkbench: ref.childWorkbench, message, recovered: true });
        }
        if (lost.length > 0) self.untrack(parentId, lost);
        if (restored.length > 0) self.hold(parentId, restored);
      }
    },

    /* ───── 阅读信号的写入口 ───── */
    setDraft(sessionId: string, nonEmpty: boolean): void {
      if (drafts.has(sessionId) === nonEmpty) return;
      if (nonEmpty) drafts.add(sessionId);
      else drafts.delete(sessionId);
      if (held.has(sessionId)) emit();
    },
    /** 聊天面挂上 / 卸下这条会话；scrolledUp = 往上翻着；null = 不再被看着 */
    setViewing(sessionId: string, state: { scrolledUp: boolean } | null): void {
      const before = viewing.get(sessionId);
      if (state === null) {
        if (before === undefined) return;
        viewing.delete(sessionId);
      } else {
        if (before?.scrolledUp === state.scrolledUp) return;
        viewing.set(sessionId, state);
      }
      if (state !== null) lastActivityAt = now();
      if (held.has(sessionId)) emit();
    },
    noteActivity(at: number): void {
      lastActivityAt = at;
    },
    setWindowFocused(next: boolean): void {
      if (focused === next) return;
      focused = next;
      if (next) lastActivityAt = now();
      if (anyHeld()) emit();
    },
  };
  return self;
}

export type ChannelHoldStore = ReturnType<typeof createChannelHoldStore>;

function browserStorage(): HoldStorage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

/** 全应用一份 */
export const channelHold: ChannelHoldStore = createChannelHoldStore({
  storage: browserStorage(),
  now: () => Date.now(),
});

/**
 * 装全局的活动信号监听：键盘 / 滚轮 / 按下 / 选中文字都算「用户刚动过」，
 * 窗口失焦 / 回前台更新「窗口在前台」。返回卸载函数。
 */
export function installReadingListeners(store: ChannelHoldStore, target: Window = window): () => void {
  const touch = (): void => store.noteActivity(Date.now());
  const syncFocus = (): void => store.setWindowFocused(target.document.hasFocus() && target.document.visibilityState === "visible");
  const onSelection = (): void => {
    const selection = target.getSelection();
    if (selection !== null && !selection.isCollapsed) touch();
  };
  syncFocus();
  const options = { capture: true, passive: true } as const;
  target.addEventListener("keydown", touch, options);
  target.addEventListener("wheel", touch, options);
  target.addEventListener("pointerdown", touch, options);
  target.document.addEventListener("selectionchange", onSelection);
  target.addEventListener("focus", syncFocus);
  target.addEventListener("blur", syncFocus);
  target.document.addEventListener("visibilitychange", syncFocus);
  return () => {
    target.removeEventListener("keydown", touch, options);
    target.removeEventListener("wheel", touch, options);
    target.removeEventListener("pointerdown", touch, options);
    target.document.removeEventListener("selectionchange", onSelection);
    target.removeEventListener("focus", syncFocus);
    target.removeEventListener("blur", syncFocus);
    target.document.removeEventListener("visibilitychange", syncFocus);
  };
}

/** 订阅某个父会话的攒着状态；没有会话（首页）返回 null */
export function useChannelHold(parentId: string | null): HoldView | null {
  return useSyncExternalStore(channelHold.subscribe, () => channelHold.getView(parentId));
}

/** 路由判定：这条回报现在该先攒着吗（读真实信号） */
export function holdNow(store: ChannelHoldStore, parentId: string, forced: boolean): boolean {
  return shouldHold({ holdOn: store.isHoldOn(parentId), reading: store.reading(parentId), forced });
}
