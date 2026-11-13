/**
 * 向量召回的主进程装配 —— **纯模块**（不 import electron，可被 `node --test`
 * 直接测）：设备状态推导、设置生效值、给服务的运行配置、下载源表。
 * powerMonitor / 文件存在性等「只有主进程知道」的事实由调用方采集后传入。
 */
import { join as joinPath } from "node:path";
import {
  DEFAULT_MEMORY_VECTOR_SETTINGS,
  MEMORY_VECTOR_MODELS,
  type MemoryDeviceStatus,
  type MemoryModelFileState,
  type MemoryVectorModel,
  type MemoryVectorServiceConfig,
  type MemoryVectorSettings,
} from "../../shared/memory.ts";

/** 设置生效值：Partial 并入默认（intent 设置同款纪律）。 */
export function effectiveVectorSettings(
  stored: Partial<MemoryVectorSettings> | undefined,
): MemoryVectorSettings {
  return { ...DEFAULT_MEMORY_VECTOR_SETTINGS, ...(stored ?? {}) };
}

/** 8GB 分档线（选型报告 §5：以下建议云端，页面只做推荐文案）。 */
export const DEVICE_MEMORY_LINE_GB = 8;

export function deviceStatusOf(input: {
  chip: string;
  memoryGb: number;
  onBattery: boolean;
  platform: string;
  arch: string;
}): MemoryDeviceStatus {
  return {
    chip: input.chip,
    memoryGb: input.memoryGb,
    onBattery: input.onBattery,
    platform: input.platform,
    arch: input.arch,
    recommend: input.memoryGb >= DEVICE_MEMORY_LINE_GB ? "local" : "cloud",
  };
}

/**
 * 给服务的运行配置：mode=off、模型文件没就绪、二进制没备取 → null（向量整条
 * 链路不碰，行为与没这个功能一致）。就绪 = 文件存在（下载完成即生效）。
 */
export function vectorServiceConfig(input: {
  settings: MemoryVectorSettings;
  /** 模型 GGUF 的绝对路径（<userData>/vector/<file>）；null = 还没下载 */
  ggufPath: string | null;
  binaryPath: string | null;
}): MemoryVectorServiceConfig | null {
  if (input.settings.mode !== "local") return null;
  const model = MEMORY_VECTOR_MODELS.find((candidate) => candidate.id === input.settings.model);
  if (model === undefined || input.ggufPath === null || input.binaryPath === null) return null;
  return {
    model,
    ggufPath: input.ggufPath,
    binaryPath: input.binaryPath,
    idleUnloadMs: Math.max(1, input.settings.idleUnloadMin) * 60_000,
    deferOnBattery: input.settings.deferOnBattery,
  };
}

/**
 * 改向量设置后，在途的模型下载还要不要：关了向量、或换了模型 = 不要了（主进程发
 * cancelModelDownload）。其余改动（空闲卸载、电池推迟）不碰下载。下载**不**因为
 * 「配置同步成 null」取消——模型没下完时配置本来就是 null（2026-10-30 卡在 22%）。
 */
export function vectorChangeCancelsDownload(before: MemoryVectorSettings, after: MemoryVectorSettings): boolean {
  return after.mode !== "local" || after.model !== before.model;
}

/** 模型 GGUF 落盘路径：<userData>/vector/<file>（dir = userData）。 */
export function modelFilePath(model: MemoryVectorModel, userDataDir: string): string {
  return joinPath(userDataDir, "vector", model.file);
}

/** 下载源依序表：HF 直连在前，hf-mirror 兜底（国内可达的成熟镜像）。 */
export function modelDownloadSources(model: MemoryVectorModel): string[] {
  const direct = `https://huggingface.co/${model.repo}/resolve/main/${model.file}`;
  const mirror = `https://hf-mirror.com/${model.repo}/resolve/main/${model.file}`;
  return [direct, mirror];
}

/** vectorSet 的入参校验（renderer 不可信）：只认四个键，值域同设置解析。 */
export function parseVectorPatch(raw: unknown): Partial<MemoryVectorSettings> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("vector patch must be an object");
  }
  const suspect = raw as Record<string, unknown>;
  const out: Partial<MemoryVectorSettings> = {};
  if (suspect.mode !== undefined) {
    if (suspect.mode !== "off" && suspect.mode !== "local") throw new Error("vector mode must be off | local");
    out.mode = suspect.mode;
  }
  if (suspect.model !== undefined) {
    const model = MEMORY_VECTOR_MODELS.find((candidate) => candidate.id === suspect.model);
    if (model === undefined) throw new Error("vector model unknown");
    out.model = model.id;
  }
  if (suspect.idleUnloadMin !== undefined) {
    if (typeof suspect.idleUnloadMin !== "number" || !Number.isFinite(suspect.idleUnloadMin)) {
      throw new Error("vector idleUnloadMin must be a number");
    }
    out.idleUnloadMin = Math.max(1, Math.round(suspect.idleUnloadMin));
  }
  if (suspect.deferOnBattery !== undefined) {
    if (typeof suspect.deferOnBattery !== "boolean") throw new Error("vector deferOnBattery must be a boolean");
    out.deferOnBattery = suspect.deferOnBattery;
  }
  return out;
}

/** 状态页的就地文件状态：文件已落盘时 ready 优先，避免 done 事件丢失 / 旧失败
 * 进度把已可用的模型误报成失败；文件不在才展示最近下载进度或 none。 */
export function modelFileStateOf(input: {
  model: MemoryVectorModel;
  fileExists: boolean;
  download: MemoryModelFileState | null;
}): MemoryModelFileState {
  if (input.fileExists) return { state: "ready", sizeBytes: input.model.sizeBytes };
  return input.download ?? { state: "none" };
}
