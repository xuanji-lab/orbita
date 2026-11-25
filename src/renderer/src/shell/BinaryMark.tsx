import type { ReactNode } from "react";
import { StarFigure } from "../features/galaxy-designer/StarFigure.tsx";
import { useGalaxyDesign } from "../features/galaxy-designer/useGalaxyDesign.ts";
import { useT } from "../locale.ts";

/**
 * 侧栏行头像旁的联星标记：主星头像右下角挂一颗小伴星（伴星工作区自己的主星形象，固定 12px），
 * 外圈一道面板底色描边把它和主星头像隔开。读屏念「与 X 结成联星」。没有伴星时原样返回头像。
 */
export function BinaryMark(props: { figure: ReactNode; partner: { id: string; name: string } | null }) {
  const t = useT();
  const { design } = useGalaxyDesign(props.partner?.id ?? "");
  if (props.partner === null) return <>{props.figure}</>;
  const label = t.gravity.binaryWith(props.partner.name);
  return (
    <span className="agent-binary" data-binary={props.partner.id} title={label}>
      {props.figure}
      <span className="agent-binary-mark">
        <StarFigure bySize={false} design={design} size={12} label={label} />
      </span>
    </span>
  );
}
