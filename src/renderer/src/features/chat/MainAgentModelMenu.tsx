/**
 * 顶栏胶囊里的「主智能体」：点开定这个工作区的主智能体以后都用的型号与思考档（写进档案，agents:set-main-model）。
 * 主智能体的输入框里没有型号与思考档两个选择器（2026-11-17 用户定：型号在档案里定一次，不是每句话都改）。
 *
 * 不新造样式：触发键长得与原来的灰字一样（只多悬停 / 聚焦反馈）；弹层是 Menu，一行灰字说明（Menu 的组头行），
 * 下面就是输入框里那两个芯片——同一个 ModelPickerMenu、同一个思考档 Menu。
 */
import { useEffect, useState } from "react";
import { Chip } from "../../shell/Chip";
import { Menu, type MenuItem } from "../../shell/Menu";
import { modelChipParts, ModelPickerMenu } from "../settings/model-menu";
import { modelThinkingLevels } from "@shared/model-defaults";
import { declaredThinkingLevels, modelPreferenceById } from "../settings/providers-view-model.ts";
import { THINKING_LEVELS, type ThinkingLevel } from "@shared/thinking";
import type { MainAgentModel } from "@shared/main-agent";
import type { ModelPair } from "@shared/settings";
import { api } from "../../api";
import { useT } from "../../locale.ts";
import type { ChatSession } from "./useChatSession";
import { reconcileThinkingLevel } from "./thinking-choice.ts";

export function MainAgentModelMenu(props: {
  session: ChatSession;
  workspaceId: string;
  label: string;
  starredModels: readonly ModelPair[];
  onToggleStarModel: (pair: ModelPair) => void;
  onOpenProviders: () => void;
}) {
  const t = useT();
  const { session } = props;
  // 档案里定的；没定（缺席）就显示这条会话此刻在用的——那正是不定时它会用的
  const [saved, setSaved] = useState<MainAgentModel | null>(null);
  useEffect(() => {
    let live = true;
    setSaved(null);
    void api.agents
      .main(props.workspaceId)
      .then((profile) => {
        if (live) setSaved(profile.model ?? null);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [props.workspaceId]);

  const current: MainAgentModel | null =
    saved ?? (session.model === null ? null : { ...session.model, thinkingLevel: session.thinkingLevel });
  const supportedOf = (providerId: string, modelId: string): readonly ThinkingLevel[] | null =>
    modelThinkingLevels(
      modelId,
      session.catalog,
      null,
      modelPreferenceById(session.usable, providerId),
      declaredThinkingLevels(session.usable, providerId, modelId),
    );

  /** 写档案，并让这条会话眼下的状态跟上（不记成「上次用的」：它只属于这个主智能体） */
  const save = (next: MainAgentModel): void => {
    setSaved(next);
    void api.agents
      .setMainModel({ workspaceId: props.workspaceId, model: next })
      .then((profile) => setSaved(profile.model ?? next))
      .catch(() => undefined);
    session.chooseModel(next.providerId, next.modelId, { remember: false });
    session.changeThinkingLevel(next.thinkingLevel, { remember: false });
  };

  const supported = current === null ? null : supportedOf(current.providerId, current.modelId);
  const thinkingItems: MenuItem[] = (supported ?? THINKING_LEVELS).map((value): MenuItem => ({
    id: value,
    label: t.thinkingLevel(value, current?.modelId),
    checked: current?.thinkingLevel === value,
    disabled: supported !== null && !supported.includes(value),
    onSelect: () => {
      if (current !== null) save({ ...current, thinkingLevel: value });
    },
  }));
  const parts = current === null ? null : modelChipParts(session.usable, session.catalog, current);

  return (
    <Menu
      // 一行灰字（组头行，不可选）说清这里定的是什么
      items={[{ id: "main-model-note", label: t.chat.mainModelNote, header: true }]}
      panelMinWidth={300}
      footer={() => (
        <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", padding: "var(--space-1) var(--space-2)" }}>
          {session.usable.length > 0 && (
            <ModelPickerMenu
              t={t}
              providers={session.usable}
              catalog={session.catalog}
              selected={current}
              starred={props.starredModels}
              onToggleStar={props.onToggleStarModel}
              onSelect={(providerId, modelId) => {
                // 换型号时档的规矩与输入框同一条：新型号仍支持当前档就不动，不支持才落它的默认档
                const level = reconcileThinkingLevel(current?.thinkingLevel ?? session.thinkingLevel, modelId, supportedOf(providerId, modelId));
                save({ providerId, modelId, thinkingLevel: level });
              }}
              onOpenProviders={props.onOpenProviders}
              trigger={({ open, toggle }) => (
                <Chip
                  active={open}
                  title={parts === null ? t.chat.modelTip : `${parts.name} · ${parts.detail}`}
                  onClick={toggle}
                  chevron
                  leading={parts?.avatar}
                  className="chip-model"
                >
                  {parts?.name ?? t.chat.noModel}
                </Chip>
              )}
            />
          )}
          <Menu
            items={thinkingItems}
            panelMinWidth={112}
            trigger={({ open, toggle }) => (
              <Chip active={open} fixedWidth={84} title={t.chat.thinkingTip} onClick={toggle} chevron className="chip-think">
                {t.thinkingLevel(current?.thinkingLevel ?? session.thinkingLevel, current?.modelId)}
              </Chip>
            )}
          />
        </div>
      )}
      trigger={({ open, toggle }) => (
        <button
          type="button"
          className="cap-tag-button"
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label={t.chat.mainModelButton}
          title={t.chat.mainModelButton}
          onClick={toggle}
        >
          {props.label}
        </button>
      )}
    />
  );
}
