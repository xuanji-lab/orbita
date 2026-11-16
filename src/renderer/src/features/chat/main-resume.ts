/**
 * 主智能体对话里「断过」那一行（设计第 6 件，图 5-resume-after）：应用退出 / 崩了再打开后，
 * 一行灰字说清断了多久、几件接着做了、几件没接上。数据在主智能体档案的 resumes 里（不进转录，见 MainAgentProfile）。
 * 只说最近一次、且你回来之后还没说过话的那一次：说过话就算看过了，不再挂着。
 */
import type { MainAgentResume } from "@shared/main-agent";

export interface ResumeLineText {
  line: (from: string, to: string, resumed: number, stopped: number) => string;
}

/** 要画的那一次；lastUserAt = 主智能体对话里你最后一句话的时刻（没有 = 0） */
export function pendingResume(resumes: readonly MainAgentResume[] | undefined, lastUserAt: number): MainAgentResume | null {
  const latest = resumes?.[resumes.length - 1];
  if (latest === undefined || latest.at <= lastUserAt) return null;
  return latest;
}

/** 时刻写成 HH:MM（本地时间；跨天时前面带月-日） */
export function clock(at: number, now: number): string {
  const date = new Date(at);
  const pad = (n: number): string => String(n).padStart(2, "0");
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  return new Date(now).toDateString() === date.toDateString() ? time : `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${time}`;
}

export function resumeLine(resume: MainAgentResume, now: number, text: ResumeLineText): string {
  return text.line(clock(resume.from, now), clock(resume.at, now), resume.resumed.length, resume.stopped.length);
}
