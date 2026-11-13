/**
 * 「这台机器上没有 latexmk」的引导卡 —— 编译条上方那一块说明，只在项目已识别、
 * 探测失败（`probe.ok === false`）时出现。
 *
 * 三件事必须同时在场，否则用户只能自己猜：
 *
 * 1. **找过哪里**：`probe.searched` 是探测真正走过的目录（PATH 各段 + 常见安装根）。
 *    只写「没找到」会让人以为我们根本没去看装好的地方。
 * 2. **怎么装**：官方下载页（TeX Live / MacTeX），**不自动下载**——装 TeX 是几个 GB
 *    的系统级动作，该由用户自己决定。
 * 3. **装完之后**：重新检测（作废探测缓存）与指定位置（已有的非标准安装）。
 *
 * 不弹窗、不阻塞面板：它是文件面板里的一张卡，项目别的事照常能做。
 */
import { useState } from "react";
import { Icon } from "../../shell/Icon";
import { useT } from "../../locale.ts";
import type { LatexProbeResult } from "@shared/latex";

/** TeX Live 的官方入口（Windows / Linux；macOS 那一页指向 MacTeX） */
const DOWNLOAD_URL = "https://tug.org/texlive/";

export function LatexSetupCard(props: {
  probe: LatexProbeResult;
  /** 「重新检测」/「指定位置」在跑 */
  busy: boolean;
  /** 选到的文件跑不起来时的路径（不写设置） */
  invalidPath: string | null;
  onRefresh: () => void;
  onLocate: () => void;
}) {
  const t = useT();
  const { probe, busy } = props;
  // 找过的目录可能有二三十条（PATH 就很长）：列表自己滚，不把卡片撑成半屏
  const [open, setOpen] = useState(false);

  return (
    <section className="latex-setup" aria-label={t.latex.setup.title}>
      <div className="latex-setup-head">
        <Icon name="octagon-x" size={14} style={{ color: "var(--color-danger)" }} />
        <span className="latex-setup-title">{t.latex.setup.title}</span>
      </div>
      <p className="latex-setup-body">{t.latex.setup.body}</p>

      <button
        type="button"
        className="latex-setup-paths-toggle"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
      >
        <Icon name={open ? "chevron-down" : "chevron-right"} size={12} />
        {t.latex.setup.lookedIn(probe.searched.length)}
      </button>
      {open && (
        <ul className="latex-setup-paths">
          {probe.searched.length === 0 ? (
            <li className="latex-setup-path">{t.latex.setup.noPaths}</li>
          ) : (
            probe.searched.map((path) => (
              <li key={path} className="latex-setup-path" title={path}>
                {path}
              </li>
            ))
          )}
        </ul>
      )}
      <p className="latex-setup-body">{t.latex.setup.whereNote}</p>

      {props.invalidPath !== null && (
        <p className="latex-setup-invalid">{t.latex.setup.invalidFile(props.invalidPath)}</p>
      )}

      <div className="latex-setup-actions">
        {/* 外链照仓里现成的走法：拦掉默认行为交给 window.open，主进程送进内置浏览器 */}
        <a
          className="latex-setup-action"
          href={DOWNLOAD_URL}
          onClick={(event) => {
            event.preventDefault();
            window.open(DOWNLOAD_URL);
          }}
        >
          <Icon name="download" size={12} />
          {t.latex.setup.openDownload}
        </a>
        <button type="button" className="quiet-control latex-setup-action" onClick={props.onRefresh} disabled={busy}>
          <Icon name="refresh-cw" size={12} spin={busy} />
          {busy ? t.latex.setup.checking : t.latex.setup.redetect}
        </button>
        <button type="button" className="quiet-control latex-setup-action" onClick={props.onLocate} disabled={busy}>
          <Icon name="folder-open" size={12} />
          {t.latex.setup.locate}
        </button>
      </div>
    </section>
  );
}
