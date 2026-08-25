/**
 * 输入卡的按键规则。抽成纯函数只为一件事：**能被测试钉住**。
 *
 * 这条规则踩过坑：中文输入法里 Enter 是「确认候选词」，浏览器照样派发 keydown。
 * 不判组词状态就会把还没上屏的词当成一条消息发出去——用户按的是确认，不是发送。
 */
export interface SubmitKeyEvent {
  key: string;
  shiftKey: boolean;
  /** 输入法组词中。现代浏览器给 `KeyboardEvent.isComposing` */
  isComposing: boolean;
  /** 组词中的历史信号：部分输入法只把 keyCode 置成 229，不置 isComposing */
  keyCode: number;
}

/** Enter 发送；Shift+Enter 换行；**组词中的 Enter 一律不是发送**。 */
export function isSubmitKey(event: SubmitKeyEvent): boolean {
  if (event.key !== "Enter") return false;
  if (event.shiftKey) return false;
  if (event.isComposing) return false;
  if (event.keyCode === 229) return false;
  return true;
}
