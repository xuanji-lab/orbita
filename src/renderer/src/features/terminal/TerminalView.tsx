/**
 * 一个 tab 的 xterm 视图。**视图是可以随便拆的**：收起面板、切面板、切 tab、
 * renderer 整页刷新都会卸载/重建这个组件，PTY 与缓冲都在主进程——重挂载时
 * create（幂等）→ 量尺寸 → snapshot 重放 → 接续事件流，sequence 去重。
 * 杀 PTY 永远不是这里的职责（那是面板的关 tab 动作）。
 */
import { useEffect, useRef } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import type { TerminalInfo } from "@shared/terminal";
import { api } from "../../api.ts";
import { useT } from "../../locale.ts";
import { CONSERVATIVE_CONPTY_BUILD, readTerminalMetrics, readTerminalTheme } from "./terminal-theme.ts";

// 字体、字号、行高都是 token（--font-family-mono / --font-size-terminal / --line-height-terminal），
// 在 effect 里运行时读——不在这里写数字
const TERMINAL_SCROLLBACK = 5000;
/** 与全局滚动条同宽（styles.css 的 *::-webkit-scrollbar width: 8px） */
const TERMINAL_SCROLLBAR_WIDTH = 8;

export function TerminalView(props: {
  terminalId: string;
  /** 创建请求带的工作区目录（cwd 失效由主进程回退 homedir） */
  cwd: string | null;
  /** 挂载时 tab 就已经是退出态（重挂载恢复）：snapshot 画完后补一行退场提示 */
  exited: number | null;
  active: boolean;
  /**
   * create 回来了（PTY 已起，或幂等收到现状）：面板据此把「创建中」的转圈 tab
   * 换成真 tab。视图已卸载（tab 在创建途中被关）就不报——不会把关掉的 tab 复活。
   */
  onCreated: (info: TerminalInfo) => void;
}) {
  const t = useT();
  const hostRef = useRef<HTMLDivElement | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  // 回调走 ref：视图 effect 只认 terminalId，父组件换回调不该重建 xterm
  const onCreatedRef = useRef(props.onCreated);
  onCreatedRef.current = props.onCreated;

  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return;
    const terminal = new Terminal({
      cursorBlink: true,
      convertEol: true,
      // ConPTY 已经负责终端行布局；固定保守 build 让 xterm.js 走 Windows 兼容路径，
      // 避免 resize / 回车时与 ConPTY 重复重排导致光标上跳（调研 1.4/2.6 节）
      reflowCursorLine: false,
      fontFamily: getComputedStyle(document.documentElement).getPropertyValue("--font-family-mono").trim(),
      ...readTerminalMetrics(),
      scrollback: TERMINAL_SCROLLBACK,
      // 滚动条宽：xterm 6 取 overviewRuler.width，缺省 14px——比全局 8px 细条粗出
      // 一截（2026-10-19 用户：「这个滑块也太粗了吧，怎么没有复用语义」）。
      // 我们不画概览标尺装饰，这个宽度只用来定滚动条
      overviewRuler: { width: TERMINAL_SCROLLBAR_WIDTH },
      theme: readTerminalTheme(),
      ...(api.platform === "win32" ? { windowsPty: { backend: "conpty" as const, buildNumber: CONSERVATIVE_CONPTY_BUILD } } : {}),
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(host);
    fitRef.current = fit;

    const fitNow = (): void => {
      try {
        // 隐藏中的 tab 与收起中的面板会量到 0×0：禁止把 PTY 缩成 FitAddon 的最小
        // 2×1，否则 Windows ConPTY 会重排屏幕、交互光标跳动
        if (host.clientWidth <= 0 || host.clientHeight <= 0) return;
        fit.fit();
        void api.terminal.resize(props.terminalId, terminal.cols, terminal.rows).catch(() => undefined);
      } catch {
        // 字体尚未完成测量时忽略；下一次布局变化会再试
      }
    };
    const observer = new ResizeObserver(fitNow);
    observer.observe(host);
    // 首帧同步测量一次，create 直接用真实行列，避免 80×24 → 实际尺寸的二次重排
    fitNow();
    const raf = requestAnimationFrame(fitNow);

    // 主题换档（system 跟随系统 / 手动切档）重读调色板
    const themeObserver = new MutationObserver(() => {
      terminal.options.theme = readTerminalTheme();
    });
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

    const writeExitNotice = (exitCode: number): void => {
      terminal.write(`\r\n\x1b[90m${t.terminal.exitNotice(exitCode)}\x1b[0m\r\n`);
    };

    // ---- 输出管线：restore 先行，sequence 去重，画完就 ack（背压放行下一批）----
    let disposed = false;
    let restoring = true;
    let lastRendered = 0;
    const pendingOutputs: { sequence: number; data: string }[] = [];
    let pendingExit: number | null = null;
    const renderOutput = (sequence: number, data: string): void => {
      if (sequence <= lastRendered) {
        void api.terminal.ackOutput(props.terminalId, sequence).catch(() => undefined);
        return;
      }
      terminal.write(data, () => {
        if (disposed) return;
        lastRendered = sequence;
        void api.terminal.ackOutput(props.terminalId, sequence).catch(() => undefined);
      });
    };
    const finishRestore = (): void => {
      restoring = false;
      [...pendingOutputs].sort((a, b) => a.sequence - b.sequence).forEach((event) => renderOutput(event.sequence, event.data));
      pendingOutputs.length = 0;
      if (pendingExit !== null) writeExitNotice(pendingExit);
    };

    const unsubscribe = api.terminal.onEvent((event) => {
      if (event.type === "output" && event.event.terminalId === props.terminalId) {
        if (restoring) pendingOutputs.push({ sequence: event.event.sequence, data: event.event.data });
        else renderOutput(event.event.sequence, event.event.data);
        return;
      }
      if (event.type === "exit" && event.terminalId === props.terminalId) {
        if (restoring) pendingExit = event.exitCode;
        else writeExitNotice(event.exitCode);
      }
    });

    // 键入原样透传（含控制字符——Ctrl+C 是 \x03，不是协议动作）
    const inputDisposable = terminal.onData((data) => {
      void api.terminal.input(props.terminalId, data).catch(() => undefined);
    });

    void (async () => {
      try {
        // create 幂等：重挂载同一 id 直接回现状，PTY 不动
        const info = await api.terminal.create({
          terminalId: props.terminalId,
          cols: Math.max(terminal.cols, 1),
          rows: Math.max(terminal.rows, 1),
          ...(props.cwd !== null && props.cwd !== "" ? { cwd: props.cwd } : {}),
        });
        if (disposed) return;
        onCreatedRef.current(info);
        fitNow();
        const snapshot = await api.terminal.snapshot(props.terminalId);
        terminal.write(snapshot.output, () => {
          if (disposed) return;
          lastRendered = snapshot.sequence;
          void api.terminal.ackOutput(props.terminalId, snapshot.sequence).catch(() => undefined);
          finishRestore();
          terminal.focus();
        });
      } catch (error) {
        if (disposed) return;
        restoring = false;
        const message = error instanceof Error ? error.message : String(error);
        terminal.write(`\r\n\x1b[31m${t.terminal.spawnFailed(message)}\x1b[0m\r\n`);
      }
    })();
    // 挂载时 tab 就已是退出态（没有活的 exit 事件会再来）：snapshot 后补提示
    if (props.exited !== null) pendingExit = props.exited;

    return () => {
      disposed = true;
      observer.disconnect();
      themeObserver.disconnect();
      inputDisposable.dispose();
      unsubscribe();
      cancelAnimationFrame(raf);
      terminal.dispose();
      fitRef.current = null;
    };
    // terminalId 是这个视图的身份；cwd / exited 变化不重建视图（cwd 只在首次 create 生效）
  }, [props.terminalId]);

  return (
    <div
      ref={hostRef}
      className={`terminal-view${props.active ? "" : " is-inactive"}`}
      style={{ height: "100%", minHeight: 0 }}
    />
  );
}
