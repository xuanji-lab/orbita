import { useState } from "react";
import type { Workspace } from "@shared/workspace";
import { api } from "../../api.ts";
import { Menu, type MenuItem } from "../../shell/Menu";
import { SelectButton } from "../settings/SettingControls";
import { Icon } from "../../shell/Icon";
import { useT } from "../../locale.ts";
import { StarFigure } from "./StarFigure.tsx";
import { useGalaxyDesign } from "./useGalaxyDesign.ts";

/**
 * 设计面板主星页的「结成联星」一行（Workspace.binaryWith，shared/workspace.ts 的 pairBinary）：
 * 选另一个工作区就两边一起写上对方（主进程一次原子写），选「不结成联星」两边一起解除。
 * 先只做手动配对，不按共享记忆 / 协作关系自动推断（规则里的成因留给以后）。
 */
export function BinarySection(props: { workspace: Workspace; workspaces: readonly Workspace[]; onChanged: () => void }) {
  const t = useT();
  const tg = t.gravity;
  const [failed, setFailed] = useState(false);
  const current = props.workspaces.find((workspace) => workspace.id === props.workspace.binaryWith) ?? null;
  const set = (partner: string | null): void => {
    setFailed(false);
    void api.workspace
      .setBinary(props.workspace.id, partner)
      .then(props.onChanged)
      .catch(() => setFailed(true));
  };
  const items: MenuItem[] = [
    { id: "none", label: tg.binaryNone, checked: current === null, onSelect: () => set(null) },
    { id: "rule", label: "", rule: true },
    ...props.workspaces
      .filter((workspace) => workspace.id !== props.workspace.id)
      .map(
        (workspace): MenuItem => ({
          id: workspace.id,
          label: workspace.name,
          avatar: <PartnerFigure id={workspace.id} name={workspace.name} />,
          checked: workspace.id === current?.id,
          onSelect: () => set(workspace.id),
        }),
      ),
  ];
  return (
    <div className="gd-row gd-row-wide" data-field="binary">
      <span className="gd-row-head">
        <span className="gd-row-name">{tg.binaryPick}</span>
        <span className="gd-row-desc">{tg.binaryDesc}</span>
      </span>
      <span className="gd-row-ctl">
        <Menu
          items={items}
          panelMinWidth={200}
          trigger={({ open, toggle }) => (
            <SelectButton open={open} onClick={toggle} title={current === null ? tg.binaryNone : tg.binaryWith(current.name)}>
              {current === null ? tg.binaryNone : current.name}
            </SelectButton>
          )}
        />
      </span>
      {failed && (
        <p className="gd-error" role="alert">
          <Icon name="triangle-alert" size={12} strokeWidth={1.8} />
          <span>{tg.binaryFailed}</span>
        </p>
      )}
    </div>
  );
}

function PartnerFigure(props: { id: string; name: string }) {
  const t = useT();
  const { design } = useGalaxyDesign(props.id);
  return <StarFigure bySize={false} design={design} size={16} label={t.agents.avatar(props.name)} />;
}
