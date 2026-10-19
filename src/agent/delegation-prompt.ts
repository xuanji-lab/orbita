/**
 * 派发前对齐 + 放行档验收闭环两段系统提示词（2026-10-18 用户裁决，合作者逐字定稿）。
 *
 * 抽成模块的理由与 prompt-narration.ts 同：runtime.ts 顶层有副作用（读 parentPort、
 * 没有就退出进程），提示词的拼装契约测试 import 不了它——段落生成放这里，测试直接
 * 测这个纯函数。
 *
 * 两条决定（合作者原话）：
 * - **先对齐再派**：agent 主动提出派发方案（不等用户催），但不能先派再说；方案要引导
 *   用户确认任务类型、每块的模型，给默认值，让用户一句话就能确认。
 * - **只有 skip 档自主闭环**：放行档（新任务默认档）确认之后验收、打回、审查、裁决
 *   全程自主，不再打扰用户；manual / plan 档同样先对齐、确认后照常派发，但不自动派
 *   审查——验收结果与「要不要审查」交回用户决定。child 两段都不带（它不能再派，
 *   给它讲怎么验收只会诱导它调不存在的工具）。
 */
import type { AvailableModel } from "../shared/available-models.ts";
import type { PermissionMode } from "../shared/permission.ts";

/**
 * 「确认后自主跑验收闭环」段。只给 skip 档的 root：用户确认派发方案后，验收、返工、
 * 独立审查、逐条裁决都不再回头问用户（放行档的承诺）。
 */
export const AUTO_VERIFICATION_GUIDELINE = `<orbita-auto-verification>
The user runs this task in "skip" mode: once they have confirmed a delegation plan, carry it through
without asking again. A sub-session's done report is a claim, not a result. When it arrives, re-run the
checks yourself (typecheck, tests, and the app itself for UI changes); if they fail, send it back with
reply_subsession and the failing output, at most 3 rounds, then tell the user honestly. Verification
never runs in the sub-session that did the work — re-running checks, screenshots and reviews go to a
different sub-session; the implementer only takes fixes to what it wrote. Once checks pass
and the change is non-trivial (several files or runtime behaviour), delegate an independent review on the
model the user confirmed: give only the goal and the bar, not the implementation or the implementer's
conclusions; the reviewer verifies against code, sources and runs, attaches evidence to every finding,
treats zero checks as not passed, says "not found" rather than "does not exist", and edits nothing.
Decide each finding yourself and send fixes back. Keep at most 3 sub-sessions running: if the plan has
more parts, start the first three, queue the rest, and start the next only after one reports. Run
implementation that touches the same files sequentially. Keep the loop going across turns: after
delegating, end the turn instead of polling — each round is advanced by the sub-sessions' reports. While
waiting you may do work the sub-sessions are not doing, but never take over a part you already delegated.
Task briefs keep the existing requirements (the user's own words, the goal, the constraints, the done
criteria, where the output goes), and carry over the parts and hard constraints the user confirmed
during alignment verbatim. Report to the user only after every sub-session has reported and all findings
are settled: what was checked, what the review found, and what you decided.
</orbita-auto-verification>`;

/**
 * 「派发前对齐」段：root 任何档位都有。
 *
 * **不再铺开可选模型清单**（2026-10-19 用户裁决）：清单是用户自己配的，逐条列出
 * 既长（本机 16 条、含 3 组重名）又不通用（换个人配的模型全不同）。改成两条
 * 真正会改变方案的事实：
 *   - **默认落点**：不点名 model 时子会话落到哪（设了 subSessionModel 就它，否则同父）；
 *   - **看图能力**：哪些 model id 能吃图片输入（只有它是硬约束：截图验收块必须用它）。
 * 要指定别的型号时用用户自己给的 id（delegate 传不存在的 id 会报错并列出全部可用）。
 */
export interface SubSessionModelFacts {
  /** 本会话当前的模型 id：没设 subSessionModel 时子会话沿用它 */
  sessionModelId: string;
  /** 设置里的子会话模型 id（设了它优先于同父）；缺席 = 没设 */
  subSessionModelId?: string;
}

export function delegationAlignmentGuideline(
  mode: PermissionMode,
  models: readonly AvailableModel[],
  facts: SubSessionModelFacts,
): string {
  const modeNote =
    mode === "skip"
      ? 'Mode: in "skip" mode, once the user confirms, carry the plan through without asking again — ' +
        "verification and review run on their own (see below)."
      : 'Mode: in "manual" and "plan" mode, still align first and then delegate as confirmed, but do ' +
        "not start a review on your own: report the verification result and offer an independent review " +
        "in one line (default: not started), so the user can decide whether a review is wanted. Either " +
        "way, verification never runs in the sub-session that did the work.";
  return `<orbita-delegation>
When a request is big enough to split across sub-sessions, propose the plan before delegating — never
delegate first and explain later. In one message, guide the user to confirm:
1. The task type (research/exploration, implementation, verifying a running app, review, writing…) and
   how you would split it. Ask them to confirm or correct it. Split at alignment time: one block per
   deliverable (different files, a different question, or something to verify get their own sub-session);
   changes to the same files run sequentially.
2. For each part, the model and thinking level you recommend, with a one-line reason (e.g. a block that
   must read screenshots needs a model that accepts image input; a review block wants stronger
   reasoning). Do not ask an open "which model?" — recommend the default stated below, or a specific
   model id when you have a concrete reason for it. Never invent a model id: if you are unsure which
   ids the user has configured, ask.
3. The done criteria, and what happens after they confirm.
4. At most three questions, each with your default, so a plain "ok" is enough to start.
Delegate only after an explicit go-ahead. If you have already shown the plan and defaults, a vague
"up to you" or "go ahead" counts as approval; if you have not shown a plan yet, or the reply questions
the split, confirm once with the concrete default. Do small, one-step work yourself without a proposal.
If the work later needs to go beyond what was confirmed (another part, a different model, wider scope),
ask first.
${modeNote}
${renderSubSessionModelFacts(models, facts)}
</orbita-delegation>`;
}

/**
 * 子会话模型的两条事实：默认落点 + 能吃图片输入的 model id。
 *
 * 不铺清单的理由见 `delegationAlignmentGuideline` 的注释。空清单（没配好 provider）
 * 与「没有声明 vision 的模型」在这里同义：看图那行如实写「没有声明」，不猜。
 */
function renderSubSessionModelFacts(
  models: readonly AvailableModel[],
  facts: SubSessionModelFacts,
): string {
  const fallback =
    facts.subSessionModelId === undefined
      ? `this session's model (${facts.sessionModelId})`
      : `the configured sub-session model (${facts.subSessionModelId})`;
  const vision = models.filter((model) => model.imageInput === true).map((model) => model.modelId);
  const visionLine =
    vision.length === 0
      ? "No configured model is declared as accepting image input."
      : `Models that accept image input: ${vision.join(", ")}.`;
  return [
    "Sub-session models: a sub-session runs on the model you name in delegate; with no model named it",
    `inherits ${fallback}.`,
    visionLine,
    "Name a model only when you have a reason; otherwise leave the default in place.",
  ].join("\n");
}
