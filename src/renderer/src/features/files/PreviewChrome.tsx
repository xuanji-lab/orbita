import { Icon, type IconName } from "../../shell/Icon";
import { PanelButton, PanelLine } from "../../shell/RightPanel";
import { useT } from "../../locale.ts";

/**
 * 预览体上的两种共用外壳：**提示带**（一段说明 + 尾部出口）与**空态**（一句说明 +
 * 主按钮）。它们原来写在 FilePreviewPane.tsx 里，分段预览（RangeTextPreview）也要用
 * 同两条外壳——抽出来不让两处各长一份样式细节。
 */
export interface PreviewNoticeAction {
  label: string;
  icon?: IconName;
  onClick: () => void;
}

/**
 * 提示带：左侧若干句说明（可多行、只在列内折行），右侧一组出口钉在行的右血线上
 * （`.row-trailing`）。出口是文字键而不是 PanelButton：它们是提示带里的次级出路，
 * 不该和空态的主按钮争视觉重量。
 */
export function PreviewNotice(props: {
  messages: readonly string[];
  actions: readonly PreviewNoticeAction[];
  /**
   * 钉在滚动容器顶部：分段预览默认落在日志末尾，提示带按普通流排就落在 3 千万像素
   * 之外——“已打开末尾”与“开头 / 50% / 结尾”四个出口用户一个也看不到。
   */
  sticky?: boolean;
}) {
  return (
    <div className="file-preview-notice" data-sticky={props.sticky === true ? "true" : undefined}>
      <div className="file-preview-notice-text">
        {props.messages.map((message) => (
          <PanelLine key={message}>{message}</PanelLine>
        ))}
      </div>
      <div className="file-preview-notice-actions row-trailing">
        {props.actions.map((action) => (
          <button key={action.label} type="button" className="file-preview-notice-action" onClick={action.onClick}>
            {action.icon !== undefined && <Icon name={action.icon} size={12} strokeWidth={1.8} />}
            {action.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/** binary / too-large / 空文件的空态：一句说明 + 用默认应用打开 */
export function EmptyPreview(props: { message: string; onOpenDefault: () => void }) {
  const t = useT();
  return (
    <div className="file-preview-empty">
      <Icon name="file" size={24} style={{ color: "var(--color-text-tertiary)" }} />
      <PanelLine>{props.message}</PanelLine>
      <PanelButton onClick={props.onOpenDefault}>
        <Icon name="external-link" size={14} />
        {t.files.openDefault}
      </PanelButton>
    </div>
  );
}
