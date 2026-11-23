/**
 * 音视频产物的「点名」过滤（纯模块，`node --test` 可直接加载）。
 *
 * agent 的轮尾扫描把本轮脚本窗口内落盘的音视频**全部**报上来——一条 TTS 流水线会留下成品、拼接分段、静音垫、
 * 试音样本十几个文件，全列出来是误报（不是每个都是「交给用户的」）。所以卡片只显示**这一轮回答里点了名**的：
 * 正文里出现了文件名（basename）或完整路径。分段与试音没被提到就不出现；点名与否由用户读到的话决定，
 * 不靠猜哪个是「最终的」。
 */
import type { MediaArtifact } from "../../../../shared/revert.ts";

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

/** 回答正文里点了名的音视频（按 artifacts 原顺序、路径去重）；正文空 / 没人被点名 = 空 */
export function namedMedia(artifacts: readonly MediaArtifact[], answerText: string): MediaArtifact[] {
  const text = norm(answerText);
  if (text.trim() === "") return [];
  const seen = new Set<string>();
  const out: MediaArtifact[] = [];
  for (const artifact of artifacts) {
    const path = norm(artifact.path);
    if (seen.has(path)) continue;
    const name = path.slice(path.lastIndexOf("/") + 1);
    if (mentions(text, path) || mentions(text, name)) {
      seen.add(path);
      out.push(artifact);
    }
  }
  return out;
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
