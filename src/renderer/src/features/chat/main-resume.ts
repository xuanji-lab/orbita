/**
 * 主智能体对话里「断过」那一行（设计第 6 件，图 5-resume-after）：应用退出 / 崩了再打开后，
 * 一行灰字说清断了多久、几件接着做了、几件没接上。数据在主智能体档案的 resumes 里（不进转录，见 MainAgentProfile）。
 * 画在对话流里，和过程行同一个样子；数据仍只在档案里（旧版读转录不认识新记录类型，写进转录会让回滚出错）。
 */
import type { MainAgentResume } from "@shared/main-agent";

export interface ResumeLineText {
  line: (from: string, to: string, resumed: number, stopped: number) => string;
}

/** 并成一行的几次「断过」（时间正序，至少一次） */
export type ResumeGroup = readonly MainAgentResume[];

/**
 * 每一次「断过」放在对话流的哪里：按时间插在它之后的第一条用户消息前面；之后没有用户消息的放在对话末尾。
 * 全部留着（事后翻得到）——它是过程里的一行，不是要你处理的提示。
 * **相邻的并成一行**（2026-11-17 主会话：用户一天重启很多次，每次一行会越攒越多）：两次断过之间没有任何用户消息
 * 或回答（boundaries = 用户消息与回答的时刻），就是相邻。两次之间什么都没接上（没有活在跑）的本来就不记（主进程 resumeOf），
 * 这里也再挡一道（resumed 与 stopped 都空的不画）。
 */
export function placeResumes(
  resumes: readonly MainAgentResume[] | undefined,
  users: readonly { id: string; timestamp: number }[],
  boundaries: readonly number[] = [],
): { beforeUser: ReadonlyMap<string, readonly ResumeGroup[]>; atEnd: readonly ResumeGroup[] } {
  const marks = [...users.map((user) => user.timestamp), ...boundaries].sort((a, b) => a - b);
  const sorted = [...(resumes ?? [])]
    .filter((resume) => resume.resumed.length > 0 || resume.stopped.length > 0)
    .sort((a, b) => a.at - b.at);
  const groups: MainAgentResume[][] = [];
  for (const resume of sorted) {
    const last = groups.at(-1);
    const previous = last?.at(-1);
    if (last !== undefined && previous !== undefined && !marks.some((mark) => mark > previous.at && mark <= resume.at)) last.push(resume);
    else groups.push([resume]);
  }
  const beforeUser = new Map<string, ResumeGroup[]>();
  const atEnd: ResumeGroup[] = [];
  for (const group of groups) {
    const latest = group[group.length - 1] as MainAgentResume;
    const next = users.find((user) => user.timestamp > latest.at);
    if (next === undefined) atEnd.push(group);
    else beforeUser.set(next.id, [...(beforeUser.get(next.id) ?? []), group]);
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
