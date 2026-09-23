/**
 * 归属点阵：一个 skill / 一个圆区属于哪些集合，用位置与形状表达，不用颜色区分
 * （颜色只用中性灰阶——accent 已经有自己的职责：主操作与当前模式）。
 *
 * **环点** = Global（对所有会话生效）；**实心点** = 一个 workspace，几个集合几个点。
 * missing 不走这套符号——它是「链接还在、真身没了」的断链态，走行首红三角 + 红名
 * （见 SkillsPanel 的 skill-row-missing），与「属于哪些集合」是两件事。
 *
 * 放在 `shell/` 而不是 `features/skills/`：Skills 列表是第一个消费者，
 * 韦恩图视图（已撤下，之后再议）的图例曾是第二个消费者——留在 `shell/`
 * 是为了下次有别的视图要用同一套符号时，用户能把行尾的点阵认成同一件事。
 */
export function SetDots(props: {
  /** 链在 global：对所有会话生效 */
  global: boolean;
  /** 链在几个 workspace（几个集合几个实心点） */
  workspaces: number;
  /** 原生 tooltip：调用方拼好的集合全名（如 "Global, orbita, vault"） */
  title?: string;
}) {
  if (!props.global && props.workspaces === 0) return null;
  return (
    <span className="set-dots" title={props.title}>
      {props.global && <span className="set-dot-ring" />}
      {Array.from({ length: props.workspaces }, (_, i) => (
        <span className="set-dot" key={i} />
      ))}
    </span>
  );
}
