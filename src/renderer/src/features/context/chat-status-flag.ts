/**
 * 「状态」卡的原型开关（2026-11-22）：localStorage `orbita.proto.chatStatus` = off | on，缺席 = off（= 改前，#522 现状）。
 * 设置 › 外观里那一行切它；同一窗口里的别处靠一个窗口事件跟着变。原型定了转成真功能时，这个开关整个删掉。
 */
import { useCallback, useEffect, useState } from "react";

const KEY = "orbita.proto.chatStatus";
const EVENT = "orbita:proto-chat-status";

function read(): boolean {
  try {
    return localStorage.getItem(KEY) === "on";
  } catch {
    return false;
  }
}

export function useChatStatusFlag(): [boolean, (on: boolean) => void] {
  const [on, setOn] = useState(read);
  useEffect(() => {
    const sync = (): void => setOn(read());
    window.addEventListener(EVENT, sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(EVENT, sync);
      window.removeEventListener("storage", sync);
    };
  }, []);
  const set = useCallback((next: boolean) => {
    try {
      localStorage.setItem(KEY, next ? "on" : "off");
    } catch {
      // 存不下就只在这次会话里生效
    }
    setOn(next);
    window.dispatchEvent(new Event(EVENT));
  }, []);
  return [on, set];
}

/** 输入框上方的状态条（另一条线）点一下：打开状态卡并定位到那个子会话所在的步骤（原型只留接口） */
export const STATUS_FOCUS_EVENT = "orbita:status-focus";
export interface StatusFocusDetail {
  /** 子会话 id；缺席 = 只打开卡 */
  childId?: string;
}
export function requestStatusFocus(detail: StatusFocusDetail): void {
  window.dispatchEvent(new CustomEvent<StatusFocusDetail>(STATUS_FOCUS_EVENT, { detail }));
}
