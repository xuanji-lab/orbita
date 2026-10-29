/**
 * 提示音记账契约 —— IPC 四层的第 1 层。
 *
 * 为什么要记（2026-10-29 用户实测）：三个根会话各带一串子会话在跑，提示音在
 * 十几分钟里响个不停，用户逐个会话翻都找不到是谁在响。提示音本身不说是谁，
 * 打包版又没有 DevTools，事后只能从会话记录倒推时间线、对不上每一声。
 * 每响一次就在 `<userData>/chime-log.jsonl` 记一行：哪一刻、为什么响、为谁响——
 * 下次再「一直响」，打开这个文件就能逐声对证。
 *
 * 只记**真的响了**的那几声（设置关掉提示音、专注静音时不记）：这本账回答的是
 * 「我听到的那一声是谁」，不是「谁跑完了」（那是未读标记的事）。
 */

/** 为什么响：根会话（连同子会话）整棵跑完 / 专注计时到点 */
export type ChimeReason = "session-settled" | "focus-done";

/** 这一声为谁响的：会话 id 与当时的标题（标题会被改，记下当时的便于对照） */
export interface ChimeSubject {
  id: string;
  title: string;
}

/** `notify:chime-log` 的请求：renderer 响铃那一拍交来；时刻由主进程落笔时打 */
export interface ChimeLogRequest {
  reason: ChimeReason;
  /** 同拍多条只响一声，这一声算在它们所有人头上；专注到点为空 */
  subjects: ChimeSubject[];
}

/** 落盘的一行：请求加主进程打的时刻（ISO 8601 UTC 便于人读，同 SessionMeta 机器事实口径） */
export interface ChimeLogEntry extends ChimeLogRequest {
  at: string;
}
