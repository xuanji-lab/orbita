/**
 * 按**会话自己的 meta** 拼一轮的开工上下文。
 *
 * 两个消费者都是「无人值守、替用户把一句话送进一条已有会话」：自动化的 this_session
 * （automation/launch.ts 的 deliverAutomationRun）与手机的「回一句」。两处原先会各拼一遍
 * piSessionFile / 模型 / 权限档 / 思考档，漏一项就是静默换档——所以收成这一个函数。
 *
 * 纯模块：不 import electron，可被 `node --test` 直接加载。
 */
import type { SubmitAgentInput } from "../../shared/agent-ipc.ts";
import type { SessionMeta } from "../../shared/session.ts";

export type ResumeTurnContext =
  | { ok: true; input: SubmitAgentInput }
  /** 这条会话没有 pi 本子（只读的导入会话、本子落地之前建的）：续不了 */
  | { ok: false; reason: "unresumable" };

/**
 * 用会话 meta 里的 piSessionFile / 模型 / 权限档 / 思考档 resume 一轮——它还是那条会话，不是新开的。
 * **不替用户改档**：manual 档会停在审批上，但那是用户在电脑上选的档，无人值守也照它走。
 * 手机发来的只有 sessionId 与那句话，别的一律从这里取，不从网络收。
 */
export function resumeTurnContext(meta: SessionMeta, text: string): ResumeTurnContext {
  if (meta.piSessionFile === null) return { ok: false, reason: "unresumable" };
  return {
    ok: true,
    input: {
      sessionId: meta.id,
      cwd: meta.cwd,
      workspaceId: meta.workspaceId,
      resume: { piSessionFile: meta.piSessionFile },
      providerId: meta.providerId,
      modelId: meta.modelId,
      mode: meta.mode,
      thinkingLevel: meta.thinkingLevel,
      text,
    },
  };
}
