/**
 * 主智能体对话里「断过」那一行（设计第 6 件，图 5-resume-after）：应用退出 / 崩了再打开后，
 * 一行灰字说清断了多久、几件接着做了、几件没接上。数据在主智能体档案的 resumes 里（不进转录，见 MainAgentProfile）。
 * 画在对话流里，和过程行同一个样子；数据仍只在档案里（旧版读转录不认识新记录类型，写进转录会让回滚出错）。
 */
import type { MainAgentResume } from "@shared/main-agent";

export interface ResumeLineText {
  line: (from: string, to: string, resumed: number, stopped: number) => string;
}

/**
 * 每一次「断过」放在对话流的哪里：按时间插在它之后的第一条用户消息前面；之后没有用户消息的放在对话末尾。
 * 全部留着（事后翻得到），不再「说过话就算看过」——它是过程里的一行，不是要你处理的提示。
 * users = 对话里的用户消息（时间正序）。
 */
export function placeResumes(
  resumes: readonly MainAgentResume[] | undefined,
  users: readonly { id: string; timestamp: number }[],
): { beforeUser: ReadonlyMap<string, readonly MainAgentResume[]>; atEnd: readonly MainAgentResume[] } {
  const beforeUser = new Map<string, MainAgentResume[]>();
  const atEnd: MainAgentResume[] = [];
  for (const resume of [...(resumes ?? [])].sort((a, b) => a.at - b.at)) {
    const next = users.find((user) => user.timestamp > resume.at);
    if (next === undefined) atEnd.push(resume);
    else beforeUser.set(next.id, [...(beforeUser.get(next.id) ?? []), resume]);
  }
  return { beforeUser, atEnd };
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
