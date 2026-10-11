/**
 * 终端面板的 contextBridge 面 —— 四层契约的第 3 层。
 * 校验在主进程（shared/terminal.ts 的形状闸 + 夹取 + service 的存在性检查），
 * renderer 传什么都不信。事件（output / exit）走单一 `terminal:event` 推送通道，
 * `onEvent` 与其它域的 `on` + 大写开头订阅同款：同步返回退订函数。
 */
import { ipcRenderer } from "electron";
import { terminalChannels, type TerminalCreateRequest, type TerminalEvent, type TerminalInfo, type TerminalSnapshot } from "../../shared/terminal.ts";

export const terminalApi = {
  /** 开一个终端（幂等：id 已知直接回现状）。cwd 缺席或失效由主进程回退 homedir */
  create: (request: TerminalCreateRequest): Promise<TerminalInfo> =>
    ipcRenderer.invoke(terminalChannels.create, request),
  /** 现存终端清单（面板重挂载 / 整页刷新后收养孤儿 tab 用） */
  list: (): Promise<TerminalInfo[]> => ipcRenderer.invoke(terminalChannels.list),
  /** 快照重放材料（先画它再接事件流，sequence 去重） */
  snapshot: (terminalId: string): Promise<TerminalSnapshot> =>
    ipcRenderer.invoke(terminalChannels.snapshot, terminalId),
  /** 键入 */
  input: (terminalId: string, data: string): Promise<void> =>
    ipcRenderer.invoke(terminalChannels.input, terminalId, data),
  /** 行列变化（xterm fit 之后同步给 PTY） */
  resize: (terminalId: string, cols: number, rows: number): Promise<void> =>
    ipcRenderer.invoke(terminalChannels.resize, terminalId, cols, rows),
  /** 一批输出画完了（背压：runtime 同一时刻只放一批在飞） */
  ackOutput: (terminalId: string, sequence: number): Promise<void> =>
    ipcRenderer.invoke(terminalChannels.ackOutput, terminalId, sequence),
  /** 关 tab：杀 PTY 并丢弃缓冲 */
  kill: (terminalId: string): Promise<void> => ipcRenderer.invoke(terminalChannels.kill, terminalId),
  /** 主进程推送（output / exit），返回退订函数 */
  onEvent: (listener: (event: TerminalEvent) => void): (() => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, payload: TerminalEvent): void => listener(payload);
    ipcRenderer.on(terminalChannels.event, wrapped);
    return () => ipcRenderer.removeListener(terminalChannels.event, wrapped);
  },
} as const;
