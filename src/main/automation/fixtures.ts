/** 自动化测试共用的夹具（只被 *.test.ts 引用） */
import type { Automation } from "../../shared/automation.ts";

export function makeAutomation(patch: Partial<Automation> & { id: string }): Automation {
  return {
    title: `任务 ${patch.id}`,
    prompt: "看一眼日志",
    schedule: { kind: "interval", unit: "minute", every: 15 },
    target: { kind: "new_session", workspaceId: null },
    mode: "plan",
    status: "active",
    createdBy: { kind: "user" },
    nextRunAt: 1_000,
    runs: [],
    runCount: 0,
    consecutiveFailures: 0,
    createdAt: 1,
    updatedAt: 1,
    ...patch,
  };
}
