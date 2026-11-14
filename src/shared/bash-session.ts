/**
 * 交还句柄的 bash 会话 —— 一条协议、两种读者。
 *
 * **一条协议**：
 * - 签到点（agent/bash-observe.ts）在工具结果尾部写一行
 *   `[orbita] kind=detached session=b1 elapsed=302s lifetime=14400s | …`，表示「命令还在跑，
 *   控制权已回到模型」，并带上这条会话的寿命上限（界面活行的「上限」读它）；
 * - 结束时 runtime 把一条**终态工具记录**写回对话（同一条 toolCallId、details 带
 *   `orbitaBash`），渲染层据此把那一行从「已 12:34」翻成「退出 0 · 共 6:40」。
 *
 * 生产与解析放在同一个文件里，是为了让格式只有一处真源——改前缀却忘了改解析，
 * 界面上那一行会静默退回成普通 bash 行。
 *
 * **两种读者**：模型读竖线后的英文散文；renderer 只解析竖线前的键值与 details。
 * 本文件在 `src/shared/`：主进程 / renderer / agent 三个进程共用，**禁引 node 内置**。
 */

/**
 * 会话的结束原因。`lifetime` 是「跑满 4 小时寿命上限被兜底杀掉」，与用户 / 模型主动停
 * （`stop`）、用户停轮（`abort`）、应用退出（`shutdown`）分开说：界面上只有上限那一种是
 * 「意外没了」（警示色），其余都是人做的决定。
 */
export type BashSessionEndReason = "lifetime" | "stop" | "abort" | "shutdown";

/**
 * 一条后台命令的落定事实。挂在终态 tool item 的 `details` 上（键见
 * `BASH_RESULT_DETAILS_KEY`），与 agent 侧产出的那条 progress 是同一份。
 *
 * **秒**而不是毫秒：这份数据只为界面事实槽与一句话文案存在，毫秒精度在
 * 「共 6:40」这种画法里没有意义。
 */
export interface BashResultMeta {
  /** 会话 id（b1 / b2…）：与 detach 那一行关联的键 */
  sessionId: string;
  /** 自然退出 = finished；被停 / 寿命 / 停轮 / 退出应用 = killed */
  status: "finished" | "killed";
  exitCode: number | null;
  /** 从 spawn 到结束（含签到前那段） */
  elapsedSeconds: number;
  endReason?: BashSessionEndReason;
  /** 命令全文：完成行展开时顶部的命令专位用它（渲染层拿不到原 toolCall 入参时） */
  command: string;
}

/** details 上挂落定事实的键。**加前缀**：details 是共享空间，别的工具也可能写它 */
export const BASH_RESULT_DETAILS_KEY = "orbitaBash";

/** 从工具结果的 details 里认出落定事实；形状不对一律当没有（不猜）。 */
export function bashResultMetaOf(details: unknown): BashResultMeta | null {
  if (typeof details !== "object" || details === null) return null;
  const raw = (details as Record<string, unknown>)[BASH_RESULT_DETAILS_KEY];
  if (typeof raw !== "object" || raw === null) return null;
  const meta = raw as Record<string, unknown>;
  const sessionId = typeof meta["sessionId"] === "string" ? meta["sessionId"] : "";
  if (!/^b\d+$/.test(sessionId)) return null;
  const status = meta["status"];
  if (status !== "finished" && status !== "killed") return null;
  const exitCode = typeof meta["exitCode"] === "number" ? meta["exitCode"] : null;
  const elapsedSeconds = typeof meta["elapsedSeconds"] === "number" ? meta["elapsedSeconds"] : 0;
  const endReason = meta["endReason"];
  const result: BashResultMeta = {
    sessionId,
    status,
    exitCode,
    elapsedSeconds: Math.max(0, elapsedSeconds),
    command: typeof meta["command"] === "string" ? meta["command"] : "",
  };
  if (endReason === "lifetime" || endReason === "stop" || endReason === "abort" || endReason === "shutdown") {
    result.endReason = endReason;
  }
  return result;
}

/**
 * 交还提示行的前言（竖线之左）。elapsed = 从 spawn 到交还已经跑了多久（秒）。
 * `lifetime` = 这条会话的寿命上限（秒）：界面活行的「· 上限 4:00:00」读它。
 * 上限缺席（旧记录 / 会话表没给）时不写这个键，界面也就不显示那一段。
 */
export function detachedNoticeHeader(
  sessionId: string,
  elapsedSeconds: number,
  lifetimeSeconds?: number,
): string {
  const elapsed = Math.max(0, Math.round(elapsedSeconds));
  const lifetime =
    lifetimeSeconds === undefined || !Number.isFinite(lifetimeSeconds) || lifetimeSeconds <= 0
      ? ""
      : ` lifetime=${Math.round(lifetimeSeconds)}s`;
  return `[orbita] kind=detached session=${sessionId} elapsed=${elapsed}s${lifetime}`;
}

/** 从交还提示里认出的会话、已跑时长与寿命上限 */
export interface DetachedNotice {
  sessionId: string;
  elapsedSeconds: number;
  /** 寿命上限（秒）。旧记录没有这一段，界面不画「上限」 */
  lifetimeSeconds?: number;
}

/**
 * 从工具结果文本里认出交还的会话。
 *
 * 只认 `b<数字>`：会话 id 由会话表铸造（bash-sessions.ts 的 `b1` / `b2`…），
 * 别的形状一律当没认出来——宁可这一行退回普通 bash 行，也不要拿半个字符串去查表。
 * `elapsed=` 缺席时按 0（旧记录）：秒针从交还那一刻起跳，至少不会编造。
 */
export function parseDetachedNotice(text: string): DetachedNotice | null {
  const match = /\[orbita\] kind=detached session=(b\d+)(?: elapsed=(\d+)s)?(?: lifetime=(\d+)s)?/.exec(text);
  if (match === null) return null;
  const lifetimeSeconds = Number(match[3] ?? "0");
  return {
    sessionId: match[1] ?? "",
    elapsedSeconds: Number(match[2] ?? "0"),
    ...(lifetimeSeconds > 0 ? { lifetimeSeconds } : {}),
  };
}

/** 从工具结果文本里认出交还的会话 id（parseDetachedNotice 的薄封装）。 */
export function parseDetachedSessionId(text: string): string | null {
  return parseDetachedNotice(text)?.sessionId ?? null;
}

/** 时长画法：`45s` / `6m40s` / `1h05m`。给一句话文案用，不给界面秒针用。 */
export function formatBashDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return `${minutes}m${String(seconds).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
}

/**
 * 结束那一刻写给模型看的一行（工具结果尾部）。模型读得到「为什么结束了」，
 * 不必再猜；渲染层不解析它（事实在 details 里）。
 */
export function bashResultNotice(meta: BashResultMeta): string {
  const elapsed = formatBashDuration(meta.elapsedSeconds * 1000);
  const reason =
    meta.status === "finished"
      ? `exit ${meta.exitCode === null ? "unknown" : meta.exitCode}`
      : meta.endReason === "lifetime"
        ? "terminated (lifetime limit)"
        : meta.endReason === "stop"
          ? "stopped"
          : meta.endReason === "abort"
            ? "stopped with the turn"
            : "stopped (app shutting down)";
  return `[orbita] bash session ${meta.sessionId} finished · ${reason} · ${elapsed}`;
}
