/**
 * 清单 `orbita.workflow` 的解析（Orbita 的清单扩展，约定见 shared/plugin.ts 的 PluginWorkflowStep）。
 *
 * `.claude-plugin/plugin.json` 顶层的 `orbita` 对象，Claude Code 会把它当未知键丢掉，不影响它加载。
 * workflow 只是**给人看的**「这个插件怎么做事」：数组顺序即步骤顺序，每步 `{ title, skill?, detail?, output?, wait? }`，
 * 不执行、不校验产出文件是否存在。写得不对的步骤跳过并记一条问题（不整块丢，也不静默）。
 *
 * **纯函数**（不读盘）：安装前预览与详情页走同一份解析。
 */
import type { PluginProblem, PluginWorkflowStep } from "../../shared/plugin.ts";
import type { PluginWaitKind } from "../../shared/plugin-board.ts";

/** 步骤数与各字段的长度上限：清单是不可信输入，详情页会逐步骤渲染（超长的截断、不报错）。 */
export const WORKFLOW_MAX_STEPS = 50;
const TITLE_MAX = 120;
const TEXT_MAX = 400;

interface SkillRef {
  slug: string;
  name: string;
}

export function parseWorkflow(
  manifest: Record<string, unknown>,
  skills: readonly SkillRef[],
  problems: PluginProblem[],
): PluginWorkflowStep[] {
  const orbita = manifest["orbita"];
  if (typeof orbita !== "object" || orbita === null || Array.isArray(orbita)) return [];
  const raw = (orbita as Record<string, unknown>)["workflow"];
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    problems.push({ kind: "workflow-invalid", detail: "orbita.workflow: not an array" });
    return [];
  }
  if (raw.length > WORKFLOW_MAX_STEPS) {
    problems.push({ kind: "workflow-invalid", detail: `orbita.workflow: more than ${WORKFLOW_MAX_STEPS} steps, the rest are ignored` });
  }
  const steps: PluginWorkflowStep[] = [];
  raw.slice(0, WORKFLOW_MAX_STEPS).forEach((entry, index) => {
    const where = `orbita.workflow[${index}]`;
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      problems.push({ kind: "workflow-invalid", detail: `${where}: not an object` });
      return;
    }
    const step = entry as Record<string, unknown>;
    const title = typeof step["title"] === "string" ? step["title"].trim() : "";
    if (title === "") {
      problems.push({ kind: "workflow-invalid", detail: `${where}: title is required` });
      return;
    }
    const skill = optionalText(step["skill"], `${where}.skill`, problems, TITLE_MAX);
    steps.push({
      title: clip(title, TITLE_MAX),
      skill,
      skillSlug: skill === null ? null : matchSkill(skills, skill),
      detail: optionalText(step["detail"], `${where}.detail`, problems, TEXT_MAX),
      output: optionalText(step["output"], `${where}.output`, problems, TEXT_MAX),
      wait: parseWait(step["wait"], `${where}.wait`, problems),
    });
  });
  return steps;
}

/** `wait`：只认 "board" / "chat"；不写 / null → null；别的值记问题、当没写。 */
function parseWait(value: unknown, where: string, problems: PluginProblem[]): PluginWaitKind | null {
  if (value === undefined || value === null) return null;
  if (value === "board" || value === "chat") return value;
  problems.push({ kind: "workflow-invalid", detail: `${where}: must be "board" or "chat"` });
  return null;
}

/** 先按 slug、再按 SKILL.md 头里的 name 对本插件的技能（`/skill:` 点名同一口径）；对不上返回 null。 */
function matchSkill(skills: readonly SkillRef[], target: string): string | null {
  return (skills.find((skill) => skill.slug === target) ?? skills.find((skill) => skill.name === target))?.slug ?? null;
}

/** 可选文本字段：没写 / 空串 → null；写了不是字符串 → null 并记问题。 */
function optionalText(value: unknown, where: string, problems: PluginProblem[], max: number): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") {
    problems.push({ kind: "workflow-invalid", detail: `${where}: not a string` });
    return null;
  }
  const trimmed = value.trim();
  return trimmed === "" ? null : clip(trimmed, max);
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
