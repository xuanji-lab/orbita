/**
 * 意图系统（实验功能 intent-system）开轮装配的判定核 —— 纯模块，可被 `node --test` 直接加载。
 *
 * 谁才跑召回：**只有根会话里用户亲口说的话**。
 * - 子会话（meta.parentId 有值）一律不带 intent：intent-lab 的 QA 库不收子会话，
 *   召回也不该替子会话花钱；
 * - 通道信封（text 能被 parseChannelPrompt 解出）不是用户的话：子→父投递经
 *   renderer 的 agentSubmit 进来、父也是根会话，但拿信封去召回（q 不是原话）是错的；
 * - 收尾扫描的机器提问不是用户意图，不召回（也不 /ingest）；
 * - **backfill 的条件比 intent 宽**：只要根会话就带（通道轮也带）。backfill 的
 *   使命是两本账对齐——信封轮在 pi 本子里同样是一条真实消息，父会话此前若有
 *   失败尾巴，这轮不带就会漏补记。
 */
import { parseChannelPrompt } from "../../shared/channel.ts";
import { isClosingScanText } from "../../shared/closing-scan.ts";
import { pendingBackfillFromRecords } from "../../shared/intent-recall.ts";
import type { IntentTurnContext } from "../../shared/agent-ipc.ts";
import type { IntentRecallModels } from "../../shared/intent-lab.ts";
import type { SessionRecord } from "../../shared/session.ts";

export interface IntentEnvInput {
  /** 实验功能 intent-system 的全局开关（关了整条链路不碰，行为与 main 一字不差） */
  experimentOn: boolean;
  /** 会话级开关（meta.intentEnabled；缺席 = 跟随设置里的新会话默认）。
   *  开 = 即便新会话默认关，这条会话也跑召回；关 = 这一问不召回但照常 /ingest 攒历史 */
  sessionIntentEnabled?: boolean;
  /** intent-lab 服务地址（effectiveIntentSettings 已解好缺省） */
  baseUrl: string;
  /** 按渠道解析好的 /recall models 覆盖；undefined = 不带字段（跟随服务端配置） */
  models?: IntentRecallModels;
  /** 会话 meta（load 不到为 null——新根会话首条 submit 时 meta 尚未建，视为根会话） */
  meta: { title: string; parentId?: string } | null;
  /** 会话转录（load 不到为 null） */
  transcript: readonly SessionRecord[] | null;
  /** 这一轮提交的正文（判定通道信封 / 机器提问） */
  text: string;
}

/** 组装 submit / interrupt 命令的 intent / backfill / ingest 字段；不带就返回空对象。 */
export interface IntentTurnEnv {
  intent?: IntentTurnContext;
  backfill?: string[];
  /** true = 这轮回答完要 /ingest（根会话 + 用户亲口说的话 + 意图系统有效开着） */
  ingest: boolean;
}

export function intentTurnEnv(input: IntentEnvInput): IntentTurnEnv {
  if (!input.experimentOn) return { ingest: false };
  // 会话级覆写：手动开过的会话优先于新会话默认关；没碰过的跟随默认
  const sessionOn = input.sessionIntentEnabled ?? true;
  const isChild = input.meta?.parentId !== undefined;
  const root = !isChild;
  const isChannelEnvelope = parseChannelPrompt(input.text) !== null;
  const userSpeech = !isChannelEnvelope && !isClosingScanText(input.text) && input.text.trim() !== "";
  const out: IntentTurnEnv = { ingest: false };
  if (root && userSpeech) {
    out.ingest = true;
    // 开关关 = 不召回，但照常存档（历史还要攒）；intent 不带
    if (sessionOn) {
      out.intent = {
        baseUrl: input.baseUrl,
        title: input.meta?.title ?? "",
        ...(input.models !== undefined ? { models: input.models } : {}),
      };
    }
  }
  if (root && input.transcript !== null && sessionOn) {
    const backfill = pendingBackfillFromRecords(input.transcript);
    if (backfill.length > 0) out.backfill = backfill;
  }
  return out;
}
