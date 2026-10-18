import "./update-view.css";
import { Fragment, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { recentReleaseTitle, releaseTagUrl } from "@shared/updater";
import type { RecentReleasesResult, UpdateNote, UpdaterSnapshot, UpdateState } from "@shared/updater";
import { api } from "../../api";
import { Icon, isIconName, type IconName } from "../../shell/Icon";
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
 *
 * 「当前版本」与「所有版本」两行行尾都只有一个展开三角，**整行是一个 disclosure 按钮**
 * （点行上任何位置开合，键盘 Tab + Enter/Space 同样）：点开就在下方就地看内容
 * （本版说明 / 最近几个版本），GitHub 外链出口放在展开体底部（按钮外面）。
 * 三角占 12px（= .upd-btn 的右内边距），尾部文字的右缘因此落在同一条线上。
 * 「更新」那一行不动：那里有真操作按钮（accent 只给「下载」与「重启以安装」）。
 *
 * 状态不在这里推导：主进程的 Updater 是唯一真值，每次变化推一份**完整快照**
 * （updater:state），这里整份替换；挂载时先拉一次（updater:get）。
 *
 * 两个 GitHub 地址都由快照里的 `releasesUrl` 拼（owner/repo 的真源在 package.json 的
 * build.publish），最近版本列表走 `updater:recentReleases`（主进程侧 10 分钟缓存），
 * 界面里不再写第二份仓址。
 */
export function UpdateCard() {
  const t = useT();
  const x = t.settings.update;
  const [snapshot, setSnapshot] = useState<UpdaterSnapshot | null>(null);
  /** 「更新内容」默认收着：一行状态是默认形态，细节想看了再展开 */
  const [notesOpen, setNotesOpen] = useState(false);
  /** 「本版更新内容」同样默认收着（两个展开器各管各的：一个是待装的，一个是已装的） */
  const [currentOpen, setCurrentOpen] = useState(false);
  /** 「最近几个版本」同样默认收着（点开才去打 GitHub API） */
  const [recentOpen, setRecentOpen] = useState(false);

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
  /** 已装上的这一版的说明（装完重启后从 userData 读回的那份）；没有就不画这行展开器 */
  const currentNotes = snapshot?.currentNotes ?? null;
  /** Release 页基址；拿不到（publish 没写 owner/repo）就连两个入口一起不画 */
  const releasesUrl = snapshot?.releasesUrl ?? null;
  const tagUrl = releasesUrl === null ? null : releaseTagUrl(releasesUrl, currentVersion);

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
  let notes: readonly UpdateNote[] | null = null;
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
    if (notes !== null && notesOpen) below = <ReleaseNotes notes={notes} />;
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
      {currentNotes === null ? (
        // 这一版没有说明：不是可开合的行，保持纯文本行（不画三角、不可点）
        <SettingRow name={x.currentVersion}>
          <span className="upd-current">
            <Mono>{currentVersion}</Mono>
          </span>
        </SettingRow>
      ) : (
        <DisclosureRow
          name={x.currentVersion}
          panelId="upd-current-notes"
          expanded={currentOpen}
          onToggle={() => setCurrentOpen(!currentOpen)}
          trailing={
            <span className="upd-current">
              <Mono>{currentVersion}</Mono>
              <Caret />
            </span>
          }
        >
          <ReleaseNotes notes={currentNotes} />
          {/* 外链出口在展开体底部（按钮外面）：想看完整 Release 页从这里走 */}
          {tagUrl !== null && <ReleaseFooter url={tagUrl}>{x.viewOnGitHub}</ReleaseFooter>}
        </DisclosureRow>
      )}
      <SettingRow
        name={x.updates}
        note={
          <>
            <span className="upd-status" data-tone={statusTone} title={statusDetail ?? undefined}>
              {statusIcon !== null && <Icon name={statusIcon} size={13} spin={statusSpin} />}
              {/*
               * 状态文字整体包在一个 span 里：**它是普通文字，不是一堆 flex 项**。
               * .upd-status 是 inline-flex，之前文字、<Mono>、" · " 各自算一个匿名 flex 项，
               * 项与项之间加 6px 的 gap、而每项首尾的空格被吞掉——于是「is available· 14.8 MB」
               * （圆点前没了空格）、「Downloading 0.1.16 … 6.3 MB」（省略号前多出 6px）。
               * 现在字间距只来自文案里的空格，屏幕上的样子与文案逐字一致。
               */}
              <span>{statusText}</span>
            </span>
            {notes !== null && (
              <button
                type="button"
                className="upd-link"
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
      {releasesUrl !== null && (
        <DisclosureRow
          name={x.allVersions}
          panelId="upd-recent-releases"
          expanded={recentOpen}
          onToggle={() => setRecentOpen(!recentOpen)}
          trailing={<Caret />}
        >
          <RecentReleasesList />
          {/* 更多历史版本去 GitHub：展开体底部的外链出口（与「当前版本」同款） */}
          <ReleaseFooter url={releasesUrl}>{x.viewAllOnGitHub}</ReleaseFooter>
        </DisclosureRow>
      )}
    </SettingGroup>
  );
}

/**
 * Release 页的入口（展开体底部的「在 GitHub 上查看本版 / 查看全部版本」两处）。
 *
 * **外链照仓里现成的走法**：`<a href>` + 拦掉默认行为交给 `window.open`——主进程的
 * setWindowOpenHandler 把网页送进内置浏览器（index.ts 的 openLink；同 SettingsView 的
 * PR 号链接）。不为此新开一条 IPC：外链有一条现成的路，再加一条就是两个写入者。
 */
function ReleaseLink(props: { url: string; children: ReactNode }) {
  return (
    <a
      className="upd-link"
      href={props.url}
      onClick={(event) => {
        event.preventDefault();
        window.open(props.url);
      }}
    >
      <Icon name="external-link" size={12} />
      {props.children}
    </a>
  );
}

/** 展开体底部的外链出口：安静一行，左缘与展开的内容对齐 */
function ReleaseFooter(props: { url: string; children: ReactNode }) {
  return (
    <div className="upd-expand-footer">
      <ReleaseLink url={props.url}>{props.children}</ReleaseLink>
    </div>
  );
}

/**
 * 行即开关的一行（「当前版本」「所有版本」）：**整行是一个 disclosure 按钮**，点行上任何
 * 位置都开合；键盘 Tab 到它、Enter / Space 同样能开合（原生 button 自带的）。
 *
 * 展开体在按钮**外面**：里面的 GitHub 外链不能嵌进 button（无效的嵌套交互元素），
 * 而且 `below` 那一格本来就不属于左名 / 右簇任何一列。面板的 id 常驻（收起时用 `hidden`），
 * `aria-controls` 才总有着落；收起时不渲染子节点——“点开才拉”的列表因此每次展开重挂载。
 *
 * 按钮自己就是 .set-row 那套两列网格的同一份模板：左名 / 右簇的几何与普通行逐像素一致
 * （右簇仍钉在右血线）。hover 走 .quiet-control 的配方；内边距拿回来当 hover 底的外扩，
 * 负外边距把内容框钉回原来的位置，所以右缘几何不动。
 */
function DisclosureRow(props: {
  name: string;
  panelId: string;
  expanded: boolean;
  onToggle: () => void;
  trailing: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="set-row upd-disclosure">
      <button
        type="button"
        className="upd-row-toggle quiet-control"
        aria-expanded={props.expanded}
        aria-controls={props.panelId}
        onClick={props.onToggle}
      >
        <span className="set-row-head">
          <span className="set-row-name">{props.name}</span>
        </span>
        <span className="set-row-ctl">{props.trailing}</span>
      </button>
      <div className="upd-disclosure-body" id={props.panelId} hidden={!props.expanded}>
        {props.expanded ? props.children : null}
      </div>
    </div>
  );
}

/**
 * 行尾的展开三角（两处同形）：**不是按钮**——整行才是，它只是这一行的开合指示。
 *
 * 图标名与尺寸照「家务活模型」两行的 Chip chevron（chevron-down / 11 / stroke 2），
 * 展开时翻 180°，过渡与仓里其它 chevron 同一档（`--duration-fast`）。它宽
 * var(--space-3) = .upd-btn 的右内边距：尾部文字右缘落在同一条线上的那把尺子。
 */
function Caret() {
  return (
    <span className="upd-caret" aria-hidden="true">
      <Icon name="chevron-down" size={11} strokeWidth={2} />
    </span>
  );
}

/**
 * 「所有版本」展开体：最近几个版本（主进程打 GitHub API + 10 分钟缓存，见
 * main/updater/recent-releases.ts）。**点开才拉**——挂载即请求一次，收起再展开是重挂载。
 *
 * 四个形态：拉取中 / 失败（一句人话 + 重试）/ 空（仓里只有 Draft 时就是这样）/ 列表。
 * 失败不画成空列表：「获取失败」与「还没有已发布的版本」是两件事。
 */
function RecentReleasesList() {
  const x = useT().settings.update;
  const [result, setResult] = useState<RecentReleasesResult | null>(null);
  /** 重试计数：递增一次就重跑一轮请求（依赖数组把它变成显式触发器） */
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setResult(null);
    void api.updater
      .recentReleases()
      .then((next) => {
        if (!cancelled) setResult(next);
      })
      .catch(() => {
        if (!cancelled) setResult({ ok: false, message: "" });
      });
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  if (result === null) return <div className="upd-recent-quiet">{x.recentLoading}</div>;
  if (!result.ok) {
    return (
      <div className="upd-recent-quiet">
        <span title={result.message === "" ? undefined : result.message}>{x.recentFailed}</span>
        <button type="button" className="upd-link" onClick={() => setAttempt(attempt + 1)}>
          {x.retry}
        </button>
      </div>
    );
  }
  if (result.releases.length === 0) return <div className="upd-recent-quiet">{x.recentEmpty}</div>;
  return (
    <div className="upd-recent">
      {result.releases.map((release) => {
        // 标题与版本号相同时只画一次（判同在纯函数里，有测试；见 shared/updater.ts）
        const title = recentReleaseTitle(release);
        return (
          <a
            key={release.tag}
            className="upd-recent-row"
            href={release.htmlUrl}
            onClick={(event) => {
              event.preventDefault();
              window.open(release.htmlUrl);
            }}
          >
            <span className="upd-recent-name">
              <Mono>{release.version}</Mono>
              {title !== null && <span className="upd-recent-title">{title}</span>}
            </span>
            <span className="upd-recent-date">{release.publishedAt.slice(0, 10)}</span>
          </a>
        );
      })}
    </div>
  );
}

/** 版本号、字节数这类机器事实：等宽字体（设计系统 *Type roles* 之外的内容档） */
function Mono(props: { children: ReactNode }) {
  return <span className="upd-mono">{props.children}</span>;
}

/**
 * 更新说明的逐条版式（待装的「更新内容」与已装的「本版更新内容」共用一份）：
 * 左侧图标列（原型版式 B，2026-10-18 用户选定）。每条占两格——图标列一格、
 * 正文列一格；图标一律 currentColor + tertiary，只当条目符号。条目之间的细分隔线由
 * CSS 画在图标轨道上（行间空隙正中），最后一条不画。
 *
 * 图标名来自 Release 正文的 `[icon:名字]` 前缀（解析见 main/updater/notes.ts），
 * **名字不在 Icon.tsx 的表里就当没图标**（发布时写错字不该崩，也不该画一个空图标）：
 * 那一行的图标格留空，正文列照旧对齐。
 */
function ReleaseNotes(props: { notes: readonly UpdateNote[] }) {
  return (
    <div className="upd-notes">
      <div className="upd-notes-rail">
        {props.notes.map((note, index) => (
          // 说明是静态文本，不会重排，用下标当 key 是安全的
          <Fragment key={index}>
            <span className="upd-note-icon">
              {note.icon !== null && isIconName(note.icon) && <Icon name={note.icon} size={14} />}
            </span>
            <span>{note.text}</span>
          </Fragment>
        ))}
      </div>
    </div>
  );
}
