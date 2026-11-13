import { readCommandCard, readOpenPanel, type CommandCardData } from "../../../../shared/builtin-command.ts";
import { Icon } from "../../shell/Icon";
import type { IconName } from "../../shell/Icon";
import { FEATURE_ICON } from "../../shell/feature-icons.ts";
import { requestOpenPanel } from "../../shell/open-panel.ts";
import { useT } from "../../locale.ts";
import { fileLabel } from "./builtin-commands.ts";

const CARD_ICON: Readonly<Record<CommandCardData["kind"], IconName>> = {
  slides: FEATURE_ICON.slides,
  doc: FEATURE_ICON.doc,
  export: "download",
};

/**
 * 内置命令的完成卡（图标 + 标题 + 副标题 + 「在右栏打开」）。
 * 数据来自工具结果的 `details.card`；点击经 `requestOpenPanel` 让 App 切面板并打开该文件。
 * 卡片坏了（details 形状不对）= 不画，过程行本身还在。
 */
export function CommandCard(props: { details: unknown }) {
  const t = useT();
  const card = readCommandCard(props.details);
  if (card === null) return null;
  // 导出卡打开的是导出产物所在目录之外的东西，不开面板——只显示路径
  const hint = card.kind === "export" ? null : (readOpenPanel(props.details) ?? { kind: card.kind === "slides" ? "slides" : "files", path: card.path });
  const open = (): void => {
    if (hint !== null) requestOpenPanel({ ...hint, force: true });
  };
  return (
    <button type="button" className="command-card" onClick={open} disabled={hint === null} aria-label={card.title}>
      <span className="command-card-icon">
        <Icon name={CARD_ICON[card.kind]} size={20} strokeWidth={1.6} />
      </span>
      <span className="command-card-text">
        <span className="command-card-title">{card.title}</span>
        <span className="command-card-sub">{card.subtitle ?? fileLabel(card.path)}</span>
      </span>
      {hint !== null && (
        <span className="command-card-open">
          {t.chat.commandCardOpen}
          <Icon name="panel-right" size={14} strokeWidth={1.8} />
        </span>
      )}
    </button>
  );
}
