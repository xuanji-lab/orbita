/**
 * PTY 输出管线 —— 16ms 批量 + ACK 背压 + 积压上限。**纯模块**：不 import electron
 * 也不 import node-pty，发批走注入的 `send`，node --test 用 mock 计时器直接测。
 *
 * 为什么要有这条管线：`ls -R /` 一类的高吞吐输出会把 renderer 淹掉——xterm 的
 * `write` 是异步排干的，来一批写一批只会让队列无限涨。所以同一时刻只放**一批**
 * 在飞：runtime 等 renderer 画完（ack）才发下一批；攒着的输出超 1MB 就丢弃并插
 * 一行黄色标记，宁可丢字也不堆内存。
 */
import type { TerminalOutputEvent } from "../shared/terminal.ts";

/** 批量窗口：一帧一条（60fps ≈ 16ms），renderer 一次 write 画完一批 */
export const OUTPUT_FLUSH_DELAY_MS = 16;

/** 单终端攒批的字符上限：超过就丢并插标记（UTF-16 code unit 计） */
export const MAX_PENDING_OUTPUT_CHARS = 1_000_000;

interface TerminalPipelineState {
  pending: string;
  droppedChars: number;
  nextSequence: number;
  /** 在飞批的序号；null = 没有（可以冲新批） */
  inFlight: number | null;
  timer: ReturnType<typeof setTimeout> | null;
  /** 进程已退出、等输出排空后要发的 exit code；null = 没在等 */
  exitPending: number | null;
}

export class OutputPipeline {
  private readonly send: (event: TerminalOutputEvent) => void;
  private readonly onExitEmitted: (terminalId: string, exitCode: number) => void;
  private readonly state = new Map<string, TerminalPipelineState>();

  constructor(
    send: (event: TerminalOutputEvent) => void,
    onExitEmitted: (terminalId: string, exitCode: number) => void,
  ) {
    this.send = send;
    this.onExitEmitted = onExitEmitted;
  }

  /** 注册一个终端（pty 起来时） */
  track(terminalId: string): void {
    if (this.state.has(terminalId)) return;
    this.state.set(terminalId, {
      pending: "",
      droppedChars: 0,
      nextSequence: 1,
      inFlight: null,
      timer: null,
      exitPending: null,
    });
  }

  /** PTY onData：攒批。已有在飞批时只攒不发（背压），等 ack 来了再冲 */
  enqueue(terminalId: string, data: string): void {
    const terminal = this.state.get(terminalId);
    if (terminal === undefined) return;
    const remaining = MAX_PENDING_OUTPUT_CHARS - terminal.pending.length;
    if (remaining <= 0) {
      terminal.droppedChars += data.length;
    } else {
      terminal.pending += data.length > remaining ? data.slice(0, remaining) : data;
      if (data.length > remaining) terminal.droppedChars += data.length - remaining;
    }
    if (terminal.timer === null) {
      terminal.timer = setTimeout(() => this.flush(terminalId), OUTPUT_FLUSH_DELAY_MS);
    }
  }

  /**
   * renderer 画完一批。认「>=」：renderer 重挂载后 ack 的是快照的 sequence，
   * 可能比在飞批新——按等号比会把背压永远卡死（刷新后输出再不来）。
   */
  acknowledge(terminalId: string, sequence: number): void {
    const terminal = this.state.get(terminalId);
    if (terminal === undefined || terminal.inFlight === null || sequence < terminal.inFlight) return;
    terminal.inFlight = null;
    this.flush(terminalId);
    this.emitExitWhenDrained(terminalId);
  }

  /**
   * PTY exit：exit 事件攒到输出排空才发（经 onExitEmitted 交出去）——renderer
   * 不能把「已退出」画在尾部输出前面。已排空当场发；还在排就挂着，等最后一次
   * ack 冲出来。返回 true = 本管线接手了这条退出（当场或稍后发）。
   */
  exit(terminalId: string, exitCode: number): boolean {
    const terminal = this.state.get(terminalId);
    if (terminal === undefined) return false;
    terminal.exitPending = exitCode;
    // 冲一次：echo 少的命令此刻多半已经排空
    this.flush(terminalId);
    this.emitExitWhenDrained(terminalId);
    return true;
  }

  /** 杀终端：冲一次尾巴、撤计时器、丢状态。之后的输出（不应再有）整个不要 */
  drop(terminalId: string): void {
    const terminal = this.state.get(terminalId);
    if (terminal === undefined) return;
    this.flush(terminalId);
    if (terminal.timer !== null) clearTimeout(terminal.timer);
    this.state.delete(terminalId);
  }

  /** 应用退出：全部计时器撤掉（进程回收交给 shutdown 流程） */
  dispose(): void {
    for (const [terminalId, terminal] of this.state) {
      if (terminal.timer !== null) clearTimeout(terminal.timer);
      this.state.delete(terminalId);
    }
  }

  /** 在飞批为空时把攒的输出冲出去（带序号）；有在飞批就继续等 ack */
  private flush(terminalId: string): void {
    const terminal = this.state.get(terminalId);
    if (terminal === undefined) return;
    if (terminal.timer !== null) {
      clearTimeout(terminal.timer);
      terminal.timer = null;
    }
    if (terminal.inFlight !== null) return;
    if (terminal.pending === "" && terminal.droppedChars === 0) return;
    // 丢字标记插在尾部（黄色 ANSI）：用户看到的是「输出太快，断在这儿」而不是静默缺字
    const lossMarker =
      terminal.droppedChars > 0
        ? `\r\n\x1b[33m[orbita：终端输出过快，已丢弃 ${terminal.droppedChars} 个字符]\x1b[0m\r\n`
        : "";
    const data = terminal.pending + lossMarker;
    terminal.pending = "";
    terminal.droppedChars = 0;
    const sequence = terminal.nextSequence;
    terminal.nextSequence += 1;
    terminal.inFlight = sequence;
    this.send({ terminalId, sequence, data });
  }

  private emitExitWhenDrained(terminalId: string): void {
    const terminal = this.state.get(terminalId);
    if (terminal === undefined || terminal.exitPending === null) return;
    if (terminal.inFlight !== null || terminal.pending !== "" || terminal.droppedChars > 0) return;
    const exitCode = terminal.exitPending;
    terminal.exitPending = null;
    // 退出已如实送达：这条终端的管线状态到头了，撤掉（快照缓冲在主进程，不受影响）
    this.state.delete(terminalId);
    this.onExitEmitted(terminalId, exitCode);
  }
}
