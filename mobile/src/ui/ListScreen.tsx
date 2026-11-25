import { useMemo, useState, type ReactNode } from "react";
import { Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { SessionSummary } from "../../../src/shared/mobile.ts";
import { copy } from "../copy.ts";
import { buildList, effective, SMALL_SCREEN_HEIGHT, taskRows, type AttentionGroup, type Seen, type WorkspaceGroup } from "../model/list.ts";
import { ageLabel } from "../model/time.ts";
import type { AppController, AppState } from "../store/controller.ts";
import { fontSize, lineHeight, MONO, space, TOUCH, weight, type Theme } from "../theme/theme.ts";
import { HostBar, isStale } from "./HostBar.tsx";
import { Icon } from "./Icon.tsx";
import { PanelEmpty } from "./PanelEmpty.tsx";
import { StatusPie } from "./StatusPie.tsx";

/**
 * 任务清单（照设计稿 android-list-*）：壳上的主机条，下面是四组（等你 / 在跑 / 跑完没看 / 出错），
 * 再下面是「工作区」（默认收起）与并列的「任务」组。行不套框、不加分隔线；组名、图标、饼在同一条
 * 左缘上（x = 16），行尾钉在右内边距。断线时所有饼退成三级灰。
 */
export function ListScreen(props: { theme: Theme; state: AppState; controller: AppController; initiallyOpen: string | null }) {
  const { theme, state, controller } = props;
  const { color } = theme;
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  const stale = isStale(state);
  const seen: Seen = { viewed: state.viewed, selectedId: state.openId };
  const sessions = useMemo(() => [...state.sessions.values()], [state.sessions]);
  const model = useMemo(() => buildList(sessions, seen, height < SMALL_SCREEN_HEIGHT), [sessions, state.viewed, state.openId, height]);
  const now = Date.now();
  const open = (row: SessionSummary) => controller.openSession(row.id);
  const loading = state.listState === "loading" && state.sessions.size === 0;
  return (
    <View style={{ flex: 1, backgroundColor: color.bgApp }}>
      <HostBar theme={theme} state={state} topInset={insets.top} />
      <ScrollView contentContainerStyle={{ paddingBottom: insets.bottom + space.s4 }}>
        {state.link.kind === "rejected" && (
          <View style={styles.notice}>
            <PanelEmpty
              theme={theme}
              tone="danger"
              icon="key"
              hint={copy.host.rejectedHint}
              exit={{ label: copy.host.rePair, onPress: () => void controller.rePair() }}
            >
              {copy.host.rejected}
            </PanelEmpty>
          </View>
        )}
        {loading ? (
          <View style={styles.notice}>
            <PanelEmpty theme={theme} busy>
              {copy.list.loading}
            </PanelEmpty>
          </View>
        ) : state.listState === "failed" && state.sessions.size === 0 ? (
          <View style={styles.notice}>
            <PanelEmpty theme={theme} tone="danger" icon="triangle-alert" exit={{ label: copy.chat.retry, onPress: () => controller.retry() }}>
              {copy.list.failed}
            </PanelEmpty>
          </View>
        ) : model.empty ? (
          <View style={styles.notice}>
            <PanelEmpty theme={theme} icon="messages-square" hint={copy.list.emptyHint}>
              {copy.list.empty}
            </PanelEmpty>
          </View>
        ) : (
          <>
            {model.groups.map((group) => (
              <Attention key={group.id} theme={theme} group={group} seen={seen} stale={stale} now={now} onOpen={open} />
            ))}
            {model.workspaces.length > 0 && (
              <View>
                <GroupHead theme={theme} label={copy.list.workspaces} />
                {model.workspaces.map((ws) => (
                  <Workspace key={ws.id} theme={theme} ws={ws} seen={seen} now={now} initiallyOpen={props.initiallyOpen === ws.id} onOpen={open} />
                ))}
              </View>
            )}
            {model.loose.length > 0 && (
              // 不属于任何工作区的任务：和「工作区」并列的一组（同桌面侧栏），不是工作区里的一行
              <View>
                <GroupHead theme={theme} label={copy.list.tasks} />
                <TaskRows theme={theme} sessions={model.loose} seen={seen} now={now} onOpen={open} />
              </View>
            )}
            {state.truncated && (
              <View style={styles.notice}>
                <PanelEmpty theme={theme} icon="history">
                  {copy.list.olderOnHost}
                </PanelEmpty>
              </View>
            )}
          </>
        )}
      </ScrollView>
    </View>
  );
}

function GroupHead(props: { theme: Theme; label: string }) {
  return (
    <Text style={[styles.groupHead, { color: props.theme.color.textSecondary }]} accessibilityRole="header">
      {props.label}
    </Text>
  );
}

function Attention(props: {
  theme: Theme;
  group: AttentionGroup;
  seen: Seen;
  stale: boolean;
  now: number;
  onOpen: (row: SessionSummary) => void;
}) {
  const { theme, group } = props;
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? group.rows : group.rows.slice(0, group.cap);
  const rest = group.rows.length - group.cap;
  return (
    <View>
      <GroupHead theme={theme} label={copy.list.group[group.id]} />
      {shown.map((row) => (
        <RecordRow key={row.id} theme={theme} row={row} seen={props.seen} stale={props.stale} now={props.now} onOpen={props.onOpen} />
      ))}
      {rest > 0 && (
        <Row theme={theme} onPress={() => setExpanded((value) => !value)} minHeight={TOUCH} expanded={expanded}>
          <Slot>
            <Icon name={expanded ? "chevron-up" : "chevron-down"} size={14} color={theme.color.textTertiary} />
          </Slot>
          <Text style={[styles.more, { color: theme.color.textSecondary }]}>{expanded ? copy.list.less : copy.list.more(rest)}</Text>
        </Row>
      )}
    </View>
  );
}

/** 两行的记录行：饼 · 标题 / 「工作区 · 那一句」 · 行尾 */
function RecordRow(props: { theme: Theme; row: SessionSummary; seen: Seen; stale: boolean; now: number; onOpen: (row: SessionSummary) => void }) {
  const { theme, row } = props;
  const { color } = theme;
  const pie = effective(row, props.seen).pie;
  const stateWord = row.state === "idle" ? null : copy.chat.state[row.state];
  return (
    <Row theme={theme} onPress={() => props.onOpen(row)} minHeight={TOUCH + space.s3} label={stateWord === null ? row.title : `${row.title}，${stateWord}`}>
      <Slot>{pie !== null && pie !== "idle" && <StatusPie theme={theme} state={pie} stale={props.stale} />}</Slot>
      <View style={styles.main}>
        <Text numberOfLines={1} style={[styles.title, { color: color.textPrimary }]}>
          {row.title}
        </Text>
        {(row.workspaceName !== null || row.lastLine !== null) && (
          <Text numberOfLines={1} style={[styles.line, { color: color.textSecondary }]}>
            {row.workspaceName !== null && <Text style={{ color: color.textTertiary }}>{`${row.workspaceName}${row.lastLine !== null ? " · " : ""}`}</Text>}
            {row.lastLine ?? ""}
          </Text>
        )}
      </View>
      <Trailing theme={theme} row={row} now={props.now} />
    </Row>
  );
}

/**
 * 行尾：挂着在跑的子会话时只写个数（读屏写「N 个子会话在跑」）；在跑 / 等你不写时间（不走的「刚刚」
 * 比没有更糟）；其余写多久前。
 */
function Trailing(props: { theme: Theme; row: SessionSummary; now: number }) {
  const { color } = props.theme;
  const { row } = props;
  if (row.childrenRunning > 0) {
    return (
      <View style={styles.trailing} accessibilityLabel={copy.list.subRunning(row.childrenRunning)}>
        <Icon name="bot" size={12} color={color.textTertiary} />
        <Text style={[styles.trailingText, { color: color.textTertiary }]}>{row.childrenRunning}</Text>
      </View>
    );
  }
  if (row.state === "running" || row.state === "waiting") return null;
  return <Text style={[styles.trailingText, { color: color.textTertiary }]}>{ageLabel(row.updatedAt, props.now)}</Text>;
}

/** 工作区：一行名字，点开是它的任务（顶上露过的不重复）。行尾不汇总状态饼 */
function Workspace(props: { theme: Theme; ws: WorkspaceGroup; seen: Seen; now: number; initiallyOpen: boolean; onOpen: (row: SessionSummary) => void }) {
  const { theme, ws } = props;
  const [open, setOpen] = useState(props.initiallyOpen);
  return (
    <View>
      <Row theme={theme} onPress={() => setOpen((value) => !value)} minHeight={TOUCH + space.s1} expanded={open}>
        <Slot>
          <Icon name={open ? "folder-open" : "folder"} size={14} color={theme.color.textTertiary} />
        </Slot>
        <Text numberOfLines={1} style={[styles.wsName, { color: theme.color.textPrimary }]}>
          {ws.name}
        </Text>
      </Row>
      {open && <TaskRows theme={theme} sessions={ws.sessions} seen={props.seen} now={props.now} onOpen={props.onOpen} />}
    </View>
  );
}

/** 工作区展开后 /「任务」组的行：「另有 N 件在上面」· 一页空闲任务 · 「更早的 N 条」 */
function TaskRows(props: { theme: Theme; sessions: readonly SessionSummary[]; seen: Seen; now: number; onOpen: (row: SessionSummary) => void }) {
  const { theme } = props;
  const { color } = theme;
  const [pages, setPages] = useState(1);
  const { above, rows, older } = taskRows(props.sessions, props.seen, pages);
  return (
    <View>
      {above > 0 && (
        <View style={[styles.row, { minHeight: TOUCH }]}>
          <Slot>
            <Icon name="chevron-up" size={14} color={color.textTertiary} />
          </Slot>
          <Text style={[styles.above, { color: color.textTertiary }]}>{copy.list.above(above)}</Text>
        </View>
      )}
      {rows.map((row) => (
        <Row key={row.id} theme={theme} onPress={() => props.onOpen(row)} minHeight={TOUCH}>
          <Slot />
          <Text numberOfLines={1} style={[styles.taskTitle, { color: color.textPrimary }]}>
            {row.title}
          </Text>
          <Text style={[styles.trailingText, { color: color.textTertiary }]}>{ageLabel(row.updatedAt, props.now)}</Text>
        </Row>
      ))}
      {older > 0 && (
        <Row theme={theme} onPress={() => setPages((value) => value + 1)} minHeight={TOUCH}>
          <Slot>
            <Icon name="history" size={14} color={color.textTertiary} />
          </Slot>
          <Text style={[styles.taskTitle, { color: color.textSecondary }]}>{copy.list.older(older)}</Text>
        </Row>
      )}
    </View>
  );
}

/** 一种行：行首 20 宽的槽、名字列、行尾；按下时是中性的灰（不是 accent） */
function Row(props: { theme: Theme; onPress: () => void; minHeight: number; expanded?: boolean; label?: string; children: ReactNode }) {
  return (
    <Pressable
      onPress={props.onPress}
      accessibilityRole="button"
      accessibilityLabel={props.label}
      accessibilityState={props.expanded === undefined ? undefined : { expanded: props.expanded }}
      style={({ pressed }) => [styles.row, { minHeight: props.minHeight }, pressed && { backgroundColor: props.theme.color.bgHover }]}
    >
      {props.children}
    </Pressable>
  );
}

function Slot(props: { children?: ReactNode }) {
  return <View style={styles.slot}>{props.children}</View>;
}

const styles = StyleSheet.create({
  notice: {
    paddingHorizontal: space.s4,
    paddingVertical: space.s3,
  },
  groupHead: {
    paddingTop: space.s4,
    paddingBottom: space.s1,
    paddingHorizontal: space.s4,
    fontSize: fontSize.sm,
    lineHeight: lineHeight(fontSize.sm),
    fontWeight: weight.semibold,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    columnGap: space.s2,
    paddingHorizontal: space.s4,
    paddingVertical: space.s1,
  },
  slot: {
    width: space.s5,
    alignItems: "flex-start",
    justifyContent: "center",
  },
  main: {
    flex: 1,
    minWidth: 0,
  },
  title: {
    fontSize: fontSize.base,
    lineHeight: lineHeight(fontSize.base),
    fontWeight: weight.medium,
  },
  line: {
    fontSize: fontSize.sm,
    lineHeight: lineHeight(fontSize.sm),
  },
  trailing: {
    flexDirection: "row",
    alignItems: "center",
    columnGap: space.s0_5,
  },
  trailingText: {
    fontFamily: MONO,
    fontSize: fontSize.xs,
  },
  more: {
    flex: 1,
    fontSize: fontSize.sm,
  },
  wsName: {
    flex: 1,
    fontSize: fontSize.base,
    fontWeight: weight.semibold,
  },
  taskTitle: {
    flex: 1,
    fontSize: fontSize.base,
  },
  above: {
    flex: 1,
    fontSize: fontSize.sm,
  },
});
