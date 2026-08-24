const { UserBubble, AssistantText, ToolCard, ThinkingCard, RespondingIndicator, Composer, Chip, Badge, IconButton, Icon } = window.OrbitaDesignSystem_994749;

function ChatHeader({ title, workspace, onToggleDrawer, drawerOpen }) {
  return (
    <header style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) auto", gap: 12, alignItems: "center", padding: "12px 18px", borderBottom: "1px solid var(--color-border-subtle)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0, height: 30 }}>
        <strong style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: "var(--font-size-title)", lineHeight: "30px", fontWeight: "var(--weight-bold)" }}>{title}</strong>
        {workspace ? <Badge variant="outline" mono>{workspace}</Badge> : null}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <Badge variant="muted" mono>a7f3c1</Badge>
      </div>
    </header>
  );
}

function Turn({ item }) {
  if (item.kind === "user") return <UserBubble time={item.time} delivery={item.delivery}>{item.text}</UserBubble>;
  if (item.kind === "assistant") return <AssistantText>{item.text.split("\n\n").map((p, i) => <p key={i} style={{ margin: i ? "1em 0 0" : 0 }}>{p}</p>)}</AssistantText>;
  if (item.kind === "thinking") return <ThinkingCard subtitle={item.subtitle} duration={item.duration} detail={item.detail} />;
  return <ToolCard name={item.name} subtitle={item.subtitle} icon={item.icon} tone={item.tone} status={item.status} duration={item.duration} detail={item.detail} />;
}

function ChatScreen({ title, workspace, transcript, value, onChange, onSubmit, running, onToggleDrawer, drawerOpen }) {
  const endRef = React.useRef(null);
  return (
    <div style={{ height: "100%", display: "grid", gridTemplateRows: "auto minmax(0,1fr) auto", minHeight: 0 }}>
      <ChatHeader title={title} workspace={workspace} onToggleDrawer={onToggleDrawer} drawerOpen={drawerOpen} />
      <div className="scroll" style={{ minHeight: 0, padding: "var(--space-6) var(--space-5)" }}>
        <div style={{ width: "min(100%, var(--content-max-width))", margin: "0 auto", display: "flex", flexDirection: "column", gap: "var(--space-4)" }}>
          {transcript.map((item, i) => <Turn key={i} item={item} />)}
          {running ? <RespondingIndicator label="Running typecheck" /> : null}
          <div ref={endRef} />
        </div>
      </div>
      <div style={{ padding: "var(--space-1) var(--space-5) 10px" }}>
        <div style={{ width: "min(100%, var(--content-max-width))", margin: "0 auto" }}>
          <Composer
            value={value}
            onChange={onChange}
            onSubmit={onSubmit}
            running={running}
            placeholder="Reply, or steer the agent"
            bottomSlot={
              <>
                <Chip icon={<Icon name="paperclip" size={12} />}>Attach</Chip>
                <Chip icon={<Icon name="at-sign" size={12} />}>Context</Chip>
                <Chip icon={<Icon name="shield-check" size={12} />} chevron>Full access</Chip>
                <Chip chevron>GLM-5.3</Chip>
                <Chip icon={<Icon name="gauge" size={12} />} chevron>Max</Chip>
              </>
            }
          />
        </div>
      </div>
    </div>
  );
}

Object.assign(window, { ChatScreen, ChatHeader, Turn });
