/**
 * 产物的「点名」判定（纯模块，`node --test` 可直接加载）。
 *
 * 文件账、旁路扫描报上来的网页 / 文档 / 音视频都只是**候选**：agent 顺手 edit 了一个 skill 的 SKILL.md、
 * 一条 TTS 流水线留下十几个分段与试音、别的会话同一时段写了网页——全列出来是误报（不是每个都是「交给用户的」）。
 * 所以卡片只显示**这一轮最终回答里点了名**的：正文里出现了文件名（basename）或完整路径。
 * 点名与否由用户读到的话决定，不靠猜哪个是「最终的」。工具声明的产物（slides_* / doc_open / 导出 / show_image）
 * 本身就是声明，不走这里（process-rows.ts 的 turnOutputs）。
 */
import type { MediaArtifact } from "./revert.ts";

function norm(text: string): string {
  return text.replace(/\\/g, "/").toLowerCase();
}

function isNameChar(char: string | undefined): boolean {
  return char !== undefined && /[A-Za-z0-9_]/.test(char);
}

/**
 * 文本里有没有以「整个名字」出现的 `needle`：前一个字符不能是 ASCII 字母数字 / `_` / `-` / `.`
 * （`george.mp3` 不算 `wang_george.mp3` 的提及），后一个不能是字母数字 / `_`，也不能是紧跟字母数字的 `.`
 * （`a.mp3` 不算 `a.mp3.bak`）。前后是中文 / 空格 / 标点 / `*` / 反引号都算边界。
 */
function mentions(haystack: string, needle: string): boolean {
  if (needle === "") return false;
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) return false;
    const before = haystack[at - 1];
    const after = haystack[at + needle.length];
    const afterNext = haystack[at + needle.length + 1];
    const beforeOk = before === undefined || !(isNameChar(before) || before === "-" || before === ".");
    const afterOk = !isNameChar(after) && !(after === "." && isNameChar(afterNext));
    if (beforeOk && afterOk) return true;
    from = at + 1;
  }
}

/** 这条路径在回答里点名了吗（basename 带边界判断，或完整路径；大小写与反斜杠不敏感） */
export function mentionsPath(answerText: string, path: string): boolean {
  const text = norm(answerText);
  if (text.trim() === "") return false;
  const full = norm(path);
  return mentions(text, full) || mentions(text, full.slice(full.lastIndexOf("/") + 1));
}

/** 回答正文里点了名的路径（按原顺序、去重）；正文空 / 没人被点名 = 空 */
export function namedPaths(paths: readonly string[], answerText: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const path of paths) {
    const key = norm(path);
    if (seen.has(key) || !mentionsPath(answerText, path)) continue;
    seen.add(key);
    out.push(path);
  }
  return out;
}

/** 回答正文里点了名的音视频（按 artifacts 原顺序、路径去重）；正文空 / 没人被点名 = 空 */
export function namedMedia(artifacts: readonly MediaArtifact[], answerText: string): MediaArtifact[] {
  const named = new Set(namedPaths(artifacts.map((artifact) => artifact.path), answerText).map(norm));
  const seen = new Set<string>();
  return artifacts.filter((artifact) => {
    const key = norm(artifact.path);
    if (!named.has(key) || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** 秒 → `3:51` / `1:02:03`（卡片上的时长；非有限数 / ≤ 0 回 null = 不显示） */
export function formatDuration(seconds: number | undefined): string | null {
  if (seconds === undefined || !Number.isFinite(seconds) || seconds <= 0) return null;
  const total = Math.max(1, Math.round(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}
