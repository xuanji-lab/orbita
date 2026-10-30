import { useMemo, useState } from "react";
import { Icon } from "../../shell/Icon";
import {
  PanelButton,
  PanelIconButton,
  RightPanelFrame,
} from "../../shell/RightPanel";
import { useT } from "../../locale.ts";
import type { ProviderDto } from "@shared/provider";
import type {
  Automation,
  AutomationCreateInput,
  AutomationMode,
  AutomationOutcome,
  AutomationPatch,
  AutomationSchedule,
} from "../../../../shared/automation.ts";
import {
  SCHEDULE_PRESETS,
  defaultScheduleForm,
  describeSchedule,
  endFormFrom,
  endFromForm,
  formFromSchedule,
  formatWhen,
  modelOptionValue,
  parseModelOption,
  previewTimes,
  scheduleFromForm,
  type EndForm,
  type ScheduleForm,
} from "./automation-view.ts";

/** 新建时从模板带来的预填；没有就是空白表单 */
export interface AutomationSeed {
  title: string;
  prompt: string;
  schedule: AutomationSchedule;
  maxRuns?: number;
}

const UNITS = ["minute", "hour", "day"] as const;

/**
 * 新建 / 编辑子页：返回箭头 + 面包屑，字段依次是标题、指令、调度（预设 + 对应输入 + 运行时间预览）、结束、
 * 每次运行去哪（新开会话 / 投回原会话，后者只对对话里建的开放）、模型、权限（Skip / Plan，没有 Manual）。
 * 校验在提交时做，不对的字段给一句话；主进程的回话（上限、名额等）原样显示在表单下方。
 */
export function AutomationEditView(props: {
  /** null = 新建 */
  automation: Automation | null;
  seed: AutomationSeed | null;
  workspaceId: string | null;
  providers: readonly ProviderDto[];
  now: number;
  create: (input: AutomationCreateInput) => Promise<AutomationOutcome>;
  update: (id: string, patch: AutomationPatch) => Promise<AutomationOutcome>;
  remove: (id: string) => Promise<AutomationOutcome>;
  onBack: () => void;
}) {
  const t = useT();
  const a = t.automation;
  const { automation } = props;
  const editing = automation !== null;
  const initialSchedule = useMemo<ScheduleForm>(
    () =>
      automation !== null
        ? formFromSchedule(automation.schedule, props.now)
        : props.seed !== null
          ? formFromSchedule(props.seed.schedule, props.now)
          : defaultScheduleForm(props.now),
    // 只在打开这一页时算一次：编辑中途 now 在走，不该把用户填到一半的表单冲掉
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  const [title, setTitle] = useState(automation?.title ?? props.seed?.title ?? "");
  const [prompt, setPrompt] = useState(automation?.prompt ?? props.seed?.prompt ?? "");
  const [form, setForm] = useState<ScheduleForm>(initialSchedule);
  const [end, setEnd] = useState<EndForm>(() =>
    endFormFrom(automation ?? (props.seed?.maxRuns !== undefined ? { maxRuns: props.seed.maxRuns } : null), props.now),
  );
  const [deliver, setDeliver] = useState<"new_session" | "this_session">(automation?.target.kind ?? "new_session");
  const [model, setModel] = useState(
    automation?.providerId !== undefined && automation.modelId !== undefined
      ? modelOptionValue(automation.providerId, automation.modelId)
      : "",
  );
  const [mode, setMode] = useState<AutomationMode>(automation?.mode ?? "skip");
  const [error, setError] = useState<{ field: string; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [armed, setArmed] = useState(false);

  /** 只有在对话里建的才有「原会话」可投回（主进程同一条规则再核一次） */
  const canSendBack = automation?.createdBy.kind === "agent";
  const followsSession = deliver === "this_session";

  // 运行时间预览：表单现在这样填，接下来会在什么时候跑
  const parsed = scheduleFromForm(form, props.now);
  const endParsed = endFromForm(end, props.now);
  const preview = parsed.ok
    ? previewTimes(parsed.schedule, props.now, 3, endParsed.ok && endParsed.until !== null ? endParsed.until : undefined)
    : [];

  const modelOptions = useMemo(() => {
    const groups = props.providers.map((provider) => ({
      id: provider.id,
      name: provider.displayName,
      models: provider.models.declared.map((m) => m.id),
    }));
    const known = groups.some((group) => group.id === automation?.providerId && group.models.includes(automation?.modelId ?? ""));
    return { groups, missing: !known && model !== "" ? model : null };
  }, [props.providers, automation, model]);

  const set = (patch: Partial<ScheduleForm>): void => setForm((current) => ({ ...current, ...patch }));

  const submit = async (): Promise<void> => {
    setError(null);
    const trimmed = title.trim();
    if (trimmed === "") return setError({ field: "title", text: a.edit.errors.title });
    if (prompt.trim() === "") return setError({ field: "prompt", text: a.edit.errors.prompt });
    // 编辑时只有真改过调度才提交（once 已过点的任务，不动调度也能改标题）
    const scheduleDirty = JSON.stringify(form) !== JSON.stringify(initialSchedule);
    if (!editing || scheduleDirty) {
      if (!parsed.ok) return setError({ field: "schedule", text: a.edit.errors[parsed.error] });
    }
    if (!endParsed.ok) return setError({ field: "end", text: a.edit.errors[endParsed.error] });
    const pair = model === "" ? null : parseModelOption(model);
    setBusy(true);
    let outcome: AutomationOutcome;
    if (automation === null) {
      if (!parsed.ok) return setBusy(false);
      outcome = await props.create({
        workspaceId: props.workspaceId,
        title: trimmed,
        prompt: prompt.trim(),
        schedule: parsed.schedule,
        mode,
        ...(pair === null ? {} : pair),
        ...(endParsed.maxRuns === null ? {} : { maxRuns: endParsed.maxRuns }),
        ...(endParsed.until === null ? {} : { until: endParsed.until }),
      });
    } else {
      const patch: AutomationPatch = {
        title: trimmed,
        prompt: prompt.trim(),
        mode,
        maxRuns: endParsed.maxRuns,
        until: endParsed.until,
        providerId: pair === null ? null : pair.providerId,
        modelId: pair === null ? null : pair.modelId,
        ...(scheduleDirty && parsed.ok ? { schedule: parsed.schedule } : {}),
        ...(deliver !== automation.target.kind ? { deliver } : {}),
      };
      outcome = await props.update(automation.id, patch);
    }
    setBusy(false);
    if (!outcome.ok) return setError({ field: "server", text: outcome.error });
    props.onBack();
  };

  const remove = async (): Promise<void> => {
    if (automation === null) return;
    if (!armed) {
      setArmed(true);
      return;
    }
    setBusy(true);
    const outcome = await props.remove(automation.id);
    setBusy(false);
    if (!outcome.ok) return setError({ field: "server", text: outcome.error });
    props.onBack();
  };

  const fieldError = (field: string): React.ReactNode =>
    error?.field === field ? (
      <p className="auto-error" role="alert">
        {error.text}
      </p>
    ) : null;

  return (
    <RightPanelFrame
      contentKey={`edit:${automation?.id ?? "new"}`}
      header={
        <>
          <PanelIconButton title={a.edit.back} onClick={props.onBack}>
            <Icon name="chevron-left" size={16} strokeWidth={2} />
          </PanelIconButton>
          <strong className="cap-title">
            {a.title} › {automation?.title ?? a.edit.crumbNew}
          </strong>
        </>
      }
      footer={
        <div className="auto-form-foot">
          {editing && (
            <PanelButton danger disabled={busy} onClick={() => void remove()}>
              <Icon name="trash-2" size={14} /> {armed ? a.actions.deleteConfirm(automation?.title ?? "") : a.edit.delete}
            </PanelButton>
          )}
          <span className="auto-grow" />
          <PanelButton onClick={props.onBack} disabled={busy}>
            {a.edit.cancel}
          </PanelButton>
          <button type="button" className="btn-accent auto-save" disabled={busy} onClick={() => void submit()} style={SAVE_STYLE}>
            {busy ? a.edit.saving : editing ? a.edit.save : a.edit.create}
          </button>
        </div>
      }
    >
      <div className="auto-form">
        <label className="auto-field">
          <span className="auto-label">{a.edit.title}</span>
          <input
            className="text-field"
            value={title}
            maxLength={40}
            placeholder={a.edit.titlePlaceholder}
            onChange={(event) => setTitle(event.target.value)}
          />
          {fieldError("title")}
        </label>

        <label className="auto-field">
          <span className="auto-label">{a.edit.prompt}</span>
          <textarea
            className="text-field"
            rows={5}
            value={prompt}
            placeholder={a.edit.promptPlaceholder}
            onChange={(event) => setPrompt(event.target.value)}
          />
          <span className="auto-hint">{followsSession ? a.edit.promptHintBound : a.edit.promptHint}</span>
          {fieldError("prompt")}
        </label>

        <div className="auto-field">
          <span className="auto-label">{a.edit.schedule}</span>
          <div className="auto-pills" role="group" aria-label={a.edit.schedule}>
            {SCHEDULE_PRESETS.map((preset) => (
              <button
                key={preset}
                type="button"
                className="quiet-control auto-pill"
                aria-pressed={form.preset === preset}
                onClick={() => set({ preset })}
              >
                {a.edit.presets[preset]}
              </button>
            ))}
          </div>
          <ScheduleInputs form={form} set={set} />
          {parsed.ok ? (
            <p className="auto-preview">
              {a.edit.preview(
                [
                  describeSchedule(parsed.schedule, a, props.now),
                  preview.length > 0 ? a.next(formatWhen(preview[0] ?? props.now, props.now, a)) : a.edit.previewNone,
                  ...preview.slice(1).map((at) => formatWhen(at, props.now, a)),
                ].join(" · "),
              )}
            </p>
          ) : (
            <p className="auto-hint">{a.edit.errors[parsed.error]}</p>
          )}
          {fieldError("schedule")}
        </div>

        <div className="auto-field">
          <span className="auto-label">{a.edit.end}</span>
          <div className="auto-pills" role="group" aria-label={a.edit.end}>
            {(["never", "count", "date"] as const).map((value) => (
              <button
                key={value}
                type="button"
                className="quiet-control auto-pill"
                aria-pressed={end.mode === value}
                onClick={() => setEnd({ ...end, mode: value })}
              >
                {value === "never" ? a.edit.endNever : value === "count" ? a.edit.endCount : a.edit.endDate}
              </button>
            ))}
          </div>
          {end.mode === "count" && (
            <div className="auto-inline">
              <input
                className="text-field auto-num"
                type="number"
                min={1}
                value={end.count}
                aria-label={a.edit.endCount}
                onChange={(event) => setEnd({ ...end, count: Number(event.target.value) })}
              />
              {a.edit.endCountSuffix}
            </div>
          )}
          {end.mode === "date" && (
            <div className="auto-inline">
              <input
                className="text-field"
                type="date"
                value={end.date}
                aria-label={a.edit.endDate}
                onChange={(event) => setEnd({ ...end, date: event.target.value })}
              />
            </div>
          )}
          {fieldError("end")}
        </div>

        <div className="auto-field">
          <span className="auto-label">{a.edit.deliver}</span>
          <div className="auto-pills" role="group" aria-label={a.edit.deliver}>
            <button
              type="button"
              className="quiet-control auto-pill"
              aria-pressed={deliver === "new_session"}
              onClick={() => setDeliver("new_session")}
            >
              {a.edit.deliverNew}
            </button>
            <button
              type="button"
              className="quiet-control auto-pill"
              aria-pressed={deliver === "this_session"}
              disabled={!canSendBack}
              title={canSendBack ? undefined : a.edit.deliverBackTip}
              onClick={() => setDeliver("this_session")}
            >
              {a.edit.deliverBack}
            </button>
          </div>
        </div>

        <label className="auto-field">
          <span className="auto-label">{a.edit.model}</span>
          {followsSession ? (
            <span className="auto-hint">{a.edit.modelFollow}</span>
          ) : (
            <select className="text-field" value={model} onChange={(event) => setModel(event.target.value)}>
              <option value="">{a.edit.modelDefault}</option>
              {modelOptions.missing !== null && (
                <option value={modelOptions.missing}>{parseModelOption(modelOptions.missing)?.modelId}</option>
              )}
              {modelOptions.groups.map((group) => (
                <optgroup key={group.id} label={group.name}>
                  {group.models.map((id) => (
                    <option key={id} value={modelOptionValue(group.id, id)}>
                      {id}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          )}
        </label>

        <div className="auto-field">
          <span className="auto-label">{a.edit.mode}</span>
          {followsSession ? (
            <span className="auto-hint">{a.edit.modeFollow}</span>
          ) : (
            <>
              <div className="auto-pills" role="group" aria-label={a.edit.mode}>
                <button type="button" className="quiet-control auto-pill" aria-pressed={mode === "skip"} onClick={() => setMode("skip")}>
                  {a.edit.modeSkip}
                </button>
                <button type="button" className="quiet-control auto-pill" aria-pressed={mode === "plan"} onClick={() => setMode("plan")}>
                  {a.edit.modePlan}
                </button>
              </div>
              <span className="auto-hint">{a.edit.modeHint}</span>
            </>
          )}
        </div>

        {fieldError("server")}
      </div>
    </RightPanelFrame>
  );
}

const SAVE_STYLE = {
  height: "var(--control-height-sm)",
  padding: "0 var(--space-4)",
  border: 0,
  borderRadius: "var(--radius-md)",
  font: "inherit",
  fontSize: "var(--font-size-base)",
  fontWeight: "var(--weight-semibold)",
} satisfies React.CSSProperties;

/** 调度预设对应的那几个输入；换预设不丢另一个预设里填过的值（值都在同一份 form 里） */
function ScheduleInputs(props: { form: ScheduleForm; set: (patch: Partial<ScheduleForm>) => void }) {
  const t = useT();
  const a = t.automation;
  const { form, set } = props;
  const timeInput = (
    <input
      className="text-field"
      type="time"
      value={form.time}
      aria-label={a.edit.timeLabel}
      onChange={(event) => set({ time: event.target.value })}
    />
  );
  switch (form.preset) {
    case "hourly":
      return (
        <div className="auto-inline">
          {a.edit.minuteLabel}
          <input
            className="text-field auto-num"
            type="number"
            min={0}
            max={59}
            value={form.minute}
            aria-label={a.edit.minuteLabel}
            onChange={(event) => set({ minute: Number(event.target.value) })}
          />
        </div>
      );
    case "daily":
    case "weekdays":
      return <div className="auto-inline">{timeInput}</div>;
    case "weekly":
      return (
        <>
          <div className="auto-pills" role="group" aria-label={a.edit.daysLabel}>
            {a.weekdayPills.map((letter, day) => (
              <button
                key={day}
                type="button"
                className="quiet-control auto-day"
                title={a.weekdays[day]}
                aria-label={a.weekdays[day]}
                aria-pressed={form.weekdays.includes(day)}
                onClick={() =>
                  set({
                    weekdays: form.weekdays.includes(day)
                      ? form.weekdays.filter((d) => d !== day)
                      : [...form.weekdays, day].sort((x, y) => x - y),
                  })
                }
              >
                {letter}
              </button>
            ))}
          </div>
          <div className="auto-inline">{timeInput}</div>
        </>
      );
    case "monthly":
      return (
        <div className="auto-inline">
          {a.edit.dayLabel}
          <input
            className="text-field auto-num"
            type="number"
            min={1}
            max={31}
            value={form.monthDay}
            aria-label={a.edit.dayLabel}
            onChange={(event) => set({ monthDay: Number(event.target.value) })}
          />
          {timeInput}
        </div>
      );
    case "once":
      return (
        <div className="auto-inline">
          <input
            className="text-field"
            type="date"
            value={form.date}
            aria-label={a.edit.dateLabel}
            onChange={(event) => set({ date: event.target.value })}
          />
          {timeInput}
        </div>
      );
    case "custom":
      return (
        <div className="auto-inline">
          {a.edit.everyLabel}
          <input
            className="text-field auto-num"
            type="number"
            min={1}
            value={form.every}
            aria-label={a.edit.everyLabel}
            onChange={(event) => set({ every: Number(event.target.value) })}
          />
          <select
            className="text-field"
            value={form.unit}
            aria-label={a.edit.everyLabel}
            onChange={(event) => {
              const unit = UNITS.find((candidate) => candidate === event.target.value);
              if (unit !== undefined) set({ unit });
            }}
          >
            {UNITS.map((unit) => (
              <option key={unit} value={unit}>
                {a.edit.units[unit]}
              </option>
            ))}
          </select>
        </div>
      );
  }
}
