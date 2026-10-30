import { useState } from "react";
import { MEMORY_VECTOR_MODELS, type MemoryVectorModel, type MemoryVectorSettings } from "@shared/memory";
import { api } from "../../api";
import { Chip } from "../../shell/Chip";
import { Icon } from "../../shell/Icon";
import { useT } from "../../locale.ts";
import { SettingGroup, SettingRow } from "../settings/SettingRow";
import "../settings/settings-view.css";
import { useVectorStatus } from "./useMemory.ts";
import { vectorFileView } from "./vector-view.ts";
import "./memory.css";

/** 模型的产品名（专名，不翻译）。 */
const MODEL_NAMES: Record<MemoryVectorModel["id"], string> = {
  "embeddinggemma-2": "EmbeddingGemma-2",
  "qwen3-embedding-0.6b": "Qwen3-Embedding-0.6B",
};

const IDLE_CHOICES = [1, 5, 15, 30] as const;

function megabytes(bytes: number): string {
  return `${Math.round(bytes / 1_000_000)} MB`;
}

/**
 * 向量模型页（记忆库 › 管理）：先认这台电脑（芯片、内存、电池）给出推荐，再管本地
 * 向量召回的开关、模型、文件、推理程序与补算。默认关闭；模型文件首次启用时下载
 * （2026-10-29 用户拍板方案 A：推理程序随安装包、模型按需下载）。
 * 云端向量服务是后续版本——这里只在推荐文案里说明，不画一个点不动的选项。
 */
export function VectorModelView(props: { choreLabel: string | null; onOpenGeneral: () => void }) {
  const t = useT();
  const vector = useVectorStatus(true);
  const [switchTo, setSwitchTo] = useState<MemoryVectorModel["id"] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const status = vector.status;

  const set = async (patch: Partial<MemoryVectorSettings>): Promise<void> => {
    setProblem(null);
    try {
      await api.memory.vectorSet(patch);
    } catch (cause) {
      setProblem(t.memory.failed(cause instanceof Error ? cause.message : String(cause)));
    }
    vector.reload();
  };
  const startDownload = async (): Promise<void> => {
    setProblem(null);
    try {
      const outcome = await api.memory.vectorDownload();
      if (!outcome.ok) setProblem(t.memory.fileFailed(outcome.error ?? ""));
    } catch (cause) {
      setProblem(t.memory.fileFailed(cause instanceof Error ? cause.message : String(cause)));
    }
    vector.reload();
  };

  if (status === null) {
    return vector.error !== null ? (
      <div className="mem-empty" role="alert">
        <span>{t.memory.loadFailed}</span>
        <button type="button" className="mem-btn" onClick={vector.reload}>
          {t.memory.retry}
        </button>
      </div>
    ) : (
      <p className="mem-empty">{t.common.loading}</p>
    );
  }

  const { settings, device } = status;
  const model = MEMORY_VECTOR_MODELS.find((item) => item.id === settings.model) ?? MEMORY_VECTOR_MODELS[0]!;
  const file = vectorFileView(status.modelFile, vector.download);
  const backfill = vector.backfill?.state === "idle" ? null : (vector.backfill ?? status.backfill);
  const embedded = status.vectors?.entries ?? 0;

  const chooseModel = (id: MemoryVectorModel["id"]): void => {
    if (id === settings.model) return;
    // 已经算过向量：换模型要整库重算，先讲后果再动作
    if (embedded > 0) setSwitchTo(id);
    else void set({ model: id });
  };

  return (
    <>
      <header className="mem-page-head">
        <h2 className="mem-page-title">{t.memory.vector}</h2>
      </header>
      <p className="mem-page-hint">{t.memory.vectorIntro}</p>

      <div className="set-page" style={{ width: "100%" }}>
        <SettingGroup label={t.memory.device}>
          <div className="mem-device">
            <span className="mem-device-line">
              <Icon name="cpu" size={14} strokeWidth={1.8} />
              {t.memory.deviceLine(device.chip, device.memoryGb)}
              <span className="mem-page-hint">· {device.onBattery ? t.memory.onBattery : t.memory.onPower}</span>
            </span>
            <span className="mem-device-note" data-tone={device.recommend === "cloud" ? "warn" : undefined}>
              <Icon name={device.recommend === "cloud" ? "triangle-alert" : "circle-check"} size={13} strokeWidth={1.8} />
              {device.recommend === "cloud" ? t.memory.recommendCloud : t.memory.recommendLocal}
            </span>
          </div>
        </SettingGroup>

        <SettingGroup label={t.memory.localGroup}>
          <SettingRow name={t.memory.mode} info={t.memory.modeInfo}>
            <span className="set-chips" role="group" aria-label={t.memory.mode}>
              <Chip active={settings.mode === "off"} onClick={() => void set({ mode: "off" })}>
                {t.memory.modeOff}
              </Chip>
              <Chip active={settings.mode === "local"} onClick={() => void set({ mode: "local" })}>
                {t.memory.modeLocal}
              </Chip>
            </span>
          </SettingRow>
          <SettingRow
            name={t.memory.model}
            info={t.memory.modelInfo}
            below={
              switchTo !== null ? (
                <div className="mem-confirm">
                  <Icon name="triangle-alert" size={13} strokeWidth={1.8} />
                  <span>{t.memory.switchWarn(embedded)}</span>
                  <span className="row-trailing mem-edit-row">
                    <button type="button" className="mem-btn quiet" onClick={() => setSwitchTo(null)}>
                      {t.memory.cancel}
                    </button>
                    <button
                      type="button"
                      className="mem-btn primary"
                      onClick={() => {
                        const next = switchTo;
                        setSwitchTo(null);
                        void set({ model: next });
                      }}
                    >
                      {t.memory.switchConfirm}
                    </button>
                  </span>
                </div>
              ) : undefined
            }
          >
            <span className="set-chips" role="group" aria-label={t.memory.model}>
              {MEMORY_VECTOR_MODELS.map((item, index) => (
                <Chip
                  key={item.id}
                  active={settings.model === item.id}
                  title={`${megabytes(item.sizeBytes)} · ${index === 0 ? t.memory.modelDefault : t.memory.modelAlt}`}
                  onClick={() => chooseModel(item.id)}
                >
                  {MODEL_NAMES[item.id]}
                </Chip>
              ))}
            </span>
          </SettingRow>
          <SettingRow
            name={t.memory.modelFile}
            note={<span className="set-row-hint">{MODEL_NAMES[model.id]} · {megabytes(model.sizeBytes)}</span>}
            below={
              file.kind === "downloading" ? (
                <div className="mem-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={file.percent}>
                  <i style={{ width: `${file.percent}%` }} />
                </div>
              ) : undefined
            }
          >
            <span className="mem-status">
              {file.kind === "ready" ? (
                <>
                  <Icon name="circle-check" size={13} strokeWidth={1.8} />
                  {t.memory.fileReady}
                </>
              ) : file.kind === "downloading" ? (
                <>
                  <Icon name="loader-circle" size={13} spin />
                  {t.memory.fileDownloading(file.percent)}
                  {file.host !== null && <span className="mem-page-hint">{t.memory.fileFrom(file.host)}</span>}
                </>
              ) : file.kind === "verifying" ? (
                <>
                  <Icon name="loader-circle" size={13} spin />
                  {t.memory.fileVerifying}
                </>
              ) : (
                <>
                  {file.kind === "failed" && <span className="mem-error">{t.memory.fileFailed(file.error)}</span>}
                  {file.kind === "none" && <span className="mem-page-hint">{t.memory.fileNone}</span>}
                  <button type="button" className="mem-btn" onClick={() => void startDownload()}>
                    <Icon name="download" size={12} strokeWidth={1.8} />
                    {t.memory.download(megabytes(model.sizeBytes))}
                  </button>
                </>
              )}
            </span>
          </SettingRow>
          <SettingRow name={t.memory.engine}>
            {status.llamaServer.found ? (
              <span className="mem-status">
                <Icon name="circle-check" size={13} strokeWidth={1.8} />
                {t.memory.engineFound(status.llamaServer.source ?? "")}
              </span>
            ) : (
              <span className="mem-status" data-tone="warn">
                <Icon name="triangle-alert" size={13} strokeWidth={1.8} />
                {t.memory.engineMissing}
                <code className="mem-code">node scripts/fetch-llama.mjs</code>
              </span>
            )}
          </SettingRow>
          <SettingRow name={t.memory.vectors}>
            <span className="mem-status">
              {backfill !== null ? (
                <>
                  <Icon name={backfill.state === "running" ? "loader-circle" : "power"} size={13} spin={backfill.state === "running"} />
                  {backfill.state === "running"
                    ? t.memory.backfillRunning(backfill.done, backfill.total)
                    : t.memory.backfillDeferred(backfill.done, backfill.total)}
                </>
              ) : status.vectors !== null ? (
                t.memory.vectorsLine(status.vectors.entries, status.vectors.dims)
              ) : (
                <span className="mem-page-hint">{t.memory.vectorsNone}</span>
              )}
            </span>
          </SettingRow>
          <SettingRow name={t.memory.idleUnload} info={t.memory.idleInfo}>
            <span className="set-chips" role="group" aria-label={t.memory.idleUnload}>
              {IDLE_CHOICES.map((minutes) => (
                <Chip key={minutes} active={settings.idleUnloadMin === minutes} onClick={() => void set({ idleUnloadMin: minutes })}>
                  {t.memory.minutes(minutes)}
                </Chip>
              ))}
            </span>
          </SettingRow>
          <SettingRow name={t.memory.deferOnBattery} info={t.memory.deferInfo}>
            <span className="set-chips" role="group" aria-label={t.memory.deferOnBattery}>
              <Chip active={!settings.deferOnBattery} onClick={() => void set({ deferOnBattery: false })}>
                {t.common.off}
              </Chip>
              <Chip active={settings.deferOnBattery} onClick={() => void set({ deferOnBattery: true })}>
                {t.common.on}
              </Chip>
            </span>
          </SettingRow>
        </SettingGroup>

        <SettingGroup label={t.memory.chore}>
          <SettingRow name={t.memory.choreRow} info={t.memory.choreInfo}>
            <span className="mem-status" data-tone={props.choreLabel === null ? "warn" : undefined}>
              {props.choreLabel === null ? t.memory.choreUnset : t.memory.choreLine(props.choreLabel)}
              <button type="button" className="mem-btn quiet" onClick={props.onOpenGeneral}>
                {t.memory.openGeneral}
              </button>
            </span>
          </SettingRow>
        </SettingGroup>
      </div>
      {problem !== null && <p className="mem-error">{problem}</p>}
    </>
  );
}
