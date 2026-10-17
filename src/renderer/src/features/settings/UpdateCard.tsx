import "./update-view.css";
import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import type { UpdaterSnapshot, UpdateState } from "@shared/updater";
import { api } from "../../api";
import { Icon, type IconName } from "../../shell/Icon";
import { useT } from "../../locale.ts";
import { SettingGroup, SettingRow } from "./SettingRow";
import { formatBytes, progressAmount, progressPercent } from "./update-format.ts";

/**
 * 设置 › 通用 › 「软件更新」分组（原型定稿 2026-10-18）。
 *
 * 七态一行：状态用「图标 + 文字」讲，颜色只是第二信号；行右 hem 只放当前唯一的主操作
 * （accent 只给「下载」与「重启以安装」这两步真正推进更新的动作）。机器事实（版本号、
 * MB 数）一律等宽字体。
 *
 * 状态不在这里推导：主进程的 Updater 是唯一真值，每次变化推一份**完整快照**
 * （updater:state），这里整份替换；挂载时先拉一次（updater:get）。
 */
export function UpdateCard() {
  const t = useT();
  const x = t.settings.update;
  const [snapshot, setSnapshot] = useState<UpdaterSnapshot | null>(null);
  /** 「更新内容」默认收着：一行状态是默认形态，细节想看了再展开 */
  const [notesOpen, setNotesOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void api.updater
      .get()
      .then((loaded) => {
        if (!cancelled) setSnapshot(loaded);
      })
      .catch(() => undefined);
    const off = api.updater.onState((next) => setSnapshot(next));
    return () => {
      cancelled = true;
      off();
    };
  }, []);

  const currentVersion = snapshot?.currentVersion ?? "";
  // 快照还没到（或桥不在）时不猜：入口置灰、版本号留空，等真值到了再画
  const supported = snapshot?.supported === true;
  const state: UpdateState = snapshot?.state ?? { kind: "idle" };

  /** 状态行：图标 + 文字。tone 只有「出错」一档——成功不染色，图标与文字已经是状态 */
  let statusIcon: IconName | null = null;
  let statusSpin = false;
  let statusText: ReactNode = x.idleHint;
  let statusTone: "quiet" | "error" = "quiet";
  /** 出错的机器原话进 title：界面上说人话，鼠标停上去能拿到诊断用的原文 */
  let statusDetail: string | null = null;
  /** 行底整幅的一格：下载进度条 / 展开的更新内容 */
  let below: ReactNode = null;
  /** 更新说明；没有就不显示展开器（原型第 8 条） */
  let notes: string | null = null;
  let action: { label: string; icon?: IconName; accent: boolean; disabled?: boolean; onClick: () => void } = {
    label: x.checkNow,
    icon: "refresh-cw",
    accent: false,
    disabled: true,
    onClick: () => undefined,
  };

  if (!supported) {
    statusText = x.unsupported;
  } else if (state.kind === "idle") {
    // 出厂形态：只说「后台会自己查」，主操作是手动查一次
    action = { label: x.checkNow, icon: "refresh-cw", accent: false, onClick: () => void api.updater.check() };
  } else if (state.kind === "checking") {
    statusIcon = "loader-circle";
    statusSpin = true;
    statusText = x.checking;
    // 检查中不给第二次点击（按钮留着位置，避免行在检查前后跳一下）
    action = { label: x.checkNow, accent: false, disabled: true, onClick: () => undefined };
  } else if (state.kind === "up-to-date") {
    statusIcon = "circle-check";
    statusText = x.upToDate;
    action = { label: x.checkAgain, accent: false, onClick: () => void api.updater.check() };
  } else if (state.kind === "available") {
    const release = state.release;
    statusIcon = "download";
    statusText = (
      <>
        {x.versionLead} <Mono>{release.version}</Mono> {x.availableMid}
        {release.size === null ? null : (
          <>
            {" · "}
            <Mono>{formatBytes(release.size)}</Mono>
          </>
        )}
      </>
    );
    notes = release.releaseNotes;
    if (notes !== null && notesOpen) below = <ReleaseNotes text={notes} />;
    action = { label: x.download, icon: "download", accent: true, onClick: () => void api.updater.download() };
  } else if (state.kind === "downloading") {
    statusIcon = "loader-circle";
    statusSpin = true;
    statusText = (
      <>
        {x.downloadingLead} <Mono>{state.release.version}</Mono>
        {x.downloadingMid} <Mono>{progressAmount(state.progress.transferred, state.progress.total)}</Mono>
      </>
    );
    const percent = progressPercent(state.progress.percent);
    below = (
      <div className="upd-progress" role="progressbar" aria-label={x.updates} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(percent)}>
        <div className="upd-progress-fill" style={{ width: `${percent}%` }} />
      </div>
    );
    // 取消之后退回 available，安装包留着可再下
    action = { label: x.cancel, accent: false, onClick: () => void api.updater.cancel() };
  } else if (state.kind === "downloaded") {
    statusIcon = "circle-check";
    statusText = (
      <>
        {x.versionLead} <Mono>{state.version}</Mono> {x.readyMid}
      </>
    );
    action = { label: x.restart, icon: "rotate-ccw", accent: true, onClick: () => void api.updater.install() };
  } else {
    statusIcon = "triangle-alert";
    statusTone = "error";
    statusText =
      state.stage === "download" ? x.downloadFailed : state.stage === "install" ? x.installFailed : x.checkFailed;
    statusDetail = state.message;
    // 重试按失败的那一步走：检查 / 下载 / 安装各自可重入
    action = {
      label: x.retry,
      icon: "refresh-cw",
      accent: false,
      onClick: () =>
        void (state.stage === "download"
          ? api.updater.download()
          : state.stage === "install"
            ? api.updater.install()
            : api.updater.check()),
    };
  }

  return (
    <SettingGroup label={x.group}>
      <SettingRow name={x.currentVersion}>
        <span className="upd-status">
          <Mono>{currentVersion}</Mono>
        </span>
      </SettingRow>
      <SettingRow
        name={x.updates}
        note={
          <>
            <span className="upd-status" data-tone={statusTone} title={statusDetail ?? undefined}>
              {statusIcon !== null && <Icon name={statusIcon} size={13} spin={statusSpin} />}
              {statusText}
            </span>
            {notes !== null && (
              <button
                type="button"
                className="upd-notes-toggle"
                aria-expanded={notesOpen}
                onClick={() => setNotesOpen(!notesOpen)}
              >
                <Icon name="chevron-down" size={12} />
                {x.whatsNew}
              </button>
            )}
          </>
        }
        below={below}
      >
        <button
          type="button"
          className={action.accent ? "upd-btn btn-accent" : "upd-btn quiet-control"}
          disabled={action.disabled === true}
          onClick={action.onClick}
        >
          {action.icon !== undefined && <Icon name={action.icon} size={14} />}
          {action.label}
        </button>
      </SettingRow>
    </SettingGroup>
  );
}

/** 版本号、字节数这类机器事实：等宽字体（设计系统 *Type roles* 之外的内容档） */
function Mono(props: { children: ReactNode }) {
  return <span className="upd-mono">{props.children}</span>;
}

/**
 * 更新内容：一条一行。主进程给的已经是纯文本（一行一条），这里只负责把它拆成**条目**
 * 而不是一段文本——行首图标（原型下一版要配的那个）落进 `.upd-note` 这一行的图标位即可，
 * 不必再动结构。
 */
function ReleaseNotes(props: { text: string }) {
  const lines = props.text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  return (
    <ul className="upd-notes">
      {lines.map((line, index) => (
        // 说明是静态文本，不会重排，用下标当 key 是安全的
        <li className="upd-note" key={index}>
          {line}
        </li>
      ))}
    </ul>
  );
}
