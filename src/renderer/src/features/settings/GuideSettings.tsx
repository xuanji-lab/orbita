/**
 * 设置 › 新手引导页签：全屏引导的唯一常驻入口。
 * 顶上一句说明 + 主按钮「从头看」（小字写看没看过），下面是整张章节目录——入门篇 / 进阶篇 / 附录三组，
 * 点任意一章全屏打开到那一章的章首页（← 仍能翻回上一章）。
 * 行的长相复用设置页的行（.set-row）与引导左侧目录的等宽章号（.ob-ch-no），不另造。
 */
import { Icon } from "../../shell/Icon";
import { useT } from "../../locale.ts";
import { GUIDE } from "../onboarding/onboarding-pages.ts";
import { guideParts, startIndexOfChapter } from "../onboarding/onboarding-nav.ts";
import { SettingGroup } from "./SettingRow";

export function GuideSettings(props: {
  /** 设置里的 onboardingSeen：只决定按钮下面那行小字，不限制重看 */
  seen: boolean;
  /** 全屏打开引导，从摊平后的第几页开始（0 = 从头） */
  onOpen: (startAt: number) => void;
}) {
  const t = useT();
  const copy = t.onboarding;
  return (
    <div className="set-page">
      <div className="set-guide-head">
        <p className="set-guide-lead">{t.settings.guideLead}</p>
        <div className="set-guide-start">
          <button type="button" className="btn-accent set-guide-btn" onClick={() => props.onOpen(0)}>
            <Icon name="play" size={14} />
            {t.settings.guideStart}
          </button>
          <span className="set-guide-seen">{props.seen ? t.settings.guideSeen : t.settings.guideUnseen}</span>
        </div>
      </div>
      {guideParts(GUIDE).map((group) => (
        <SettingGroup key={group.part} label={copy.parts[group.part].name}>
          {group.chapters.map((chapter) => {
            const text = copy.chapters[chapter.id];
            return (
              <button
                key={chapter.id}
                type="button"
                className="set-row set-guide-row"
                aria-label={t.settings.guideChapterOpen(text.name)}
                onClick={() => props.onOpen(startIndexOfChapter(GUIDE, chapter.id))}
              >
                <span className="ob-ch-no set-guide-no">{chapter.no}</span>
                <span className="set-row-head">
                  <span className="set-row-name">{text.name}</span>
                  <span className="set-row-desc">{text.blurb}</span>
                </span>
                <Icon name="chevron-right" size={16} className="set-guide-go" />
              </button>
            );
          })}
        </SettingGroup>
      ))}
    </div>
  );
}
