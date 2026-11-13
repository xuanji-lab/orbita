import { Icon, type IconName } from "./Icon";

/**
 * 空态（2026-10-30，一体化审计「空态」模式）：图标 + 一句「现在是什么」+ 一个出口——
 * 与对话里的提示行（ChatView 的 Notice）同一句法，换了地方也是同一种说法。
 *
 * 以前全应用五六种写法各管各的：右栏 `.panel-empty` 一行灰字不画图标，记忆的 `.mem-empty`
 * 图标 16 + 说明另起一行，铃铛清单 `.bell-card-empty` 次级灰，模型服务的 `.pv-wall-empty`
 * 居中，侧栏的 Empty 内联样式……同一件事（「这里现在什么都没有」）说法、字色、对齐各不相同。
 *
 * 长相（样式在 styles.css 的 `.panel-empty`）：
 * - 左对齐，**图标落在行首槽**（14px，与面板里每一行的图标同一列），字落在行名那一列；
 *   不居中、不放大图标、不斜体；
 * - 一句话 sm / 次级灰；补充说明（hint）接在后面、三级灰；出口是句尾的文字按钮（提示行的
 *   `.notice-exit` 同一配方：主墨色、半粗、发丝下划线）；
 * - 出错（tone="danger"）整句与图标转红并带 role=alert；在等（busy）图标是转圈的 loader。
 */
export function PanelEmpty(props: {
  /** 行首槽里的 lucide 图标；busy 时换成 loader-circle、tone=danger 缺省 triangle-alert */
  icon?: IconName;
  /** 一句「现在是什么」 */
  children: React.ReactNode;
  /** 接在句子后面的补充（怎么才会有东西），三级灰 */
  hint?: React.ReactNode;
  /** 出口：句尾一个文字按钮，说下一步去哪 */
  exit?: { label: string; onClick: () => void } | undefined;
  tone?: "danger";
  /** 在读 / 在等：图标换成转圈的 loader */
  busy?: boolean;
  /** 宿主的版式微调（如侧栏把字对到行名那一列） */
  className?: string;
}) {
  const danger = props.tone === "danger";
  const icon: IconName | undefined =
    props.busy === true ? "loader-circle" : (props.icon ?? (danger ? "triangle-alert" : undefined));
  return (
    <div
      className={props.className === undefined ? "panel-empty" : `panel-empty ${props.className}`}
      role={danger ? "alert" : undefined}
      data-tone={danger ? "danger" : undefined}
    >
      <span className="panel-empty-glyph" aria-hidden="true">
        {icon !== undefined && <Icon name={icon} size={14} strokeWidth={1.8} spin={props.busy === true} />}
      </span>
      <p className="panel-empty-text">
        {props.children}
        {props.hint !== undefined && <span className="panel-empty-hint"> {props.hint}</span>}
        {props.exit !== undefined && (
          <>
            {" "}
            <button type="button" className="notice-exit" onClick={props.exit.onClick}>
              {props.exit.label}
            </button>
          </>
        )}
      </p>
    </div>
  );
}
