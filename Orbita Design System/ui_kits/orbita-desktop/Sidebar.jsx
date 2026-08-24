const { BrandLockup, ModeChip, RailButton, SessionRow, IconButton, Icon, Badge } = window.OrbitaDesignSystem_994749;

function SidebarRail({ onExpand, onNewSession, onSettings }) {
  return (
    <aside style={{ width: 48, flex: "0 0 48px", display: "flex", flexDirection: "column", alignItems: "center", gap: 4, padding: "4px 0", background: "transparent" }}>
      <RailButton title="Expand sidebar" onClick={onExpand}><Icon name="panel-left" size={16} /></RailButton>
      <RailButton title="Agent mode" active><Icon name="bot" size={16} /></RailButton>
      <RailButton title="Orchestrate — opens with the orchestration phase" disabled><Icon name="workflow" size={16} /></RailButton>
      <RailButton title="New task" onClick={onNewSession}><Icon name="plus" size={16} /></RailButton>
      <RailButton title="Search" onClick={onExpand}><Icon name="search" size={16} /></RailButton>
      <div style={{ flex: 1 }} />
      <RailButton title="Settings" onClick={onSettings}><Icon name="settings" size={16} /></RailButton>
    </aside>
  );
}

function NodeHeader({ label, addLabel, addIcon, onAdd }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) 26px", alignItems: "center", gap: 2, minHeight: 28 }}>
      <span style={{ fontSize: "var(--font-size-micro)", fontFamily: "var(--font-family-business)", letterSpacing: ".06em", textTransform: "uppercase", color: "var(--color-text-secondary)" }}>{label}</span>
      <IconButton label={addLabel} onClick={onAdd} style={{ width: 26, height: 26 }}><Icon name={addIcon} size={14} /></IconButton>
    </div>
  );
}

function ProjectGroup({ project, sessions, expanded, onToggle, activeId, onOpen, onToggleReadOnly, onNewTask }) {
  const [hover, setHover] = React.useState(false);
  return (
    <div style={{ padding: "var(--space-2) 0" }} onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>
      <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) 26px", alignItems: "center", gap: 2, borderRadius: "var(--radius-sm)", background: hover ? "var(--color-bg-hover)" : "transparent", transition: "var(--transition-hover)" }}>
      <button
        type="button"
        onClick={onToggle}
        style={{ display: "grid", gridTemplateColumns: "24px minmax(0,1fr) max-content", alignItems: "center", gap: "var(--space-2)", width: "100%", minHeight: 28, padding: "var(--space-1) var(--space-2) var(--space-1) 0", border: 0, borderRadius: "var(--radius-sm)", background: "transparent", cursor: "pointer", textAlign: "left" }}
      >
        <span style={{ display: "grid", placeItems: "center", width: 24, height: 24, borderRadius: "var(--radius-sm)", background: "transparent", color: "var(--color-text-secondary)" }}>
          <Icon name="folder" size={14} strokeWidth={1.8} />
        </span>
        <span style={{ minWidth: 0, display: "flex", alignItems: "center", gap: 6 }}>
          <strong style={{ fontSize: "var(--font-size-control)", fontWeight: "var(--weight-semibold)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{project.name}</strong>
          {project.branch ? (
            <span style={{ display: "inline-flex", alignItems: "center", gap: 3, color: "var(--color-text-tertiary)", fontFamily: "var(--font-family-business)", fontSize: "var(--font-size-micro)" }}>
              <Icon name="git-branch" size={11} strokeWidth={1.8} />{project.branch}
            </span>
          ) : null}
        </span>
        <span style={{ color: "var(--color-text-tertiary)", fontFamily: "var(--font-family-business)", fontSize: "var(--font-size-micro)" }}>{project.count}</span>
      </button>
      <IconButton label={"New task in " + project.name} onClick={onNewTask} style={{ width: 26, height: 26 }}><Icon name="plus" size={14} /></IconButton>
      </div>
      {expanded
        ? sessions.map((s) => (
            <SessionRow key={s.id} title={s.title} time={s.time} status={s.status} running={s.running} readOnly={s.readOnly} active={activeId === s.id} onClick={() => onOpen(s)} onToggleReadOnly={(e) => { e.stopPropagation(); onToggleReadOnly(s.id); }} />
          ))
        : null}
    </div>
  );
}

function Sidebar({ collapsed, onCollapse, onExpand, activeId, onOpen, onNewSession, onSettings, sessions, readOnly, onToggleReadOnly }) {
  const [search, setSearch] = React.useState("");
  const [open, setOpen] = React.useState({ p1: true, p2: true, p3: false });
  if (collapsed) return <SidebarRail onExpand={onExpand} onNewSession={onNewSession} onSettings={onSettings} />;
  const byId = Object.fromEntries(sessions.map((s) => [s.id, { ...s, readOnly: readOnly.includes(s.id) }]));
  const filed = new Set(window.PROJECTS.flatMap((p) => p.sessions));
  const loose = sessions.filter((t) => !filed.has(t.id) && t.title.toLowerCase().includes(search.toLowerCase())).map((t) => byId[t.id]);
  return (
    <aside style={{ width: 288, flex: "0 0 288px", display: "flex", flexDirection: "column", gap: "var(--space-3)", padding: "var(--space-2) var(--space-3)", background: "transparent", overflow: "hidden" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <IconButton label="Collapse sidebar" onClick={onCollapse}><Icon name="panel-left" size={14} /></IconButton>
        <BrandLockup />
      </div>
      <div style={{ display: "flex", gap: 4 }} role="tablist">
        <ModeChip icon={<Icon name="bot" size={14} />} active>Agent mode</ModeChip>
        <ModeChip icon={<Icon name="workflow" size={14} />} disabled>Orchestrate</ModeChip>
      </div>
      <button type="button" onClick={onNewSession} style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", height: 32, padding: "0 10px", border: 0, borderRadius: "var(--radius-md)", background: "var(--color-accent)", color: "var(--color-accent-fg)", fontFamily: "var(--font-family-base)", fontSize: "var(--font-size-control)", fontWeight: "var(--weight-medium)", cursor: "pointer" }}>
        <Icon name="plus" size={16} />New task
      </button>
      <div style={{ display: "flex", alignItems: "center", gap: 6, height: 32, padding: "0 10px", borderRadius: "var(--radius-md)", background: "transparent", border: 0 }}>
        <span style={{ color: "var(--color-text-tertiary)", display: "inline-flex" }}><Icon name="search" size={14} /></span>
        <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search" style={{ flex: 1, minWidth: 0, border: 0, background: "transparent", outline: "none", fontFamily: "var(--font-family-base)", fontSize: "var(--font-size-control)", color: "var(--color-text-primary)" }} />
      </div>
      <div className="scroll" style={{ flex: 1, marginRight: "calc(-1 * var(--space-3))", paddingRight: "var(--space-3)" }}>
        <NodeHeader label="Workspaces" addLabel="New workspace" addIcon="folder-plus" />
        {window.PROJECTS.map((p) => {
          const rows = p.sessions.map((id) => byId[id]).filter((s) => s && s.title.toLowerCase().includes(search.toLowerCase()));
          return (
            <ProjectGroup
              key={p.id}
              project={p}
              sessions={rows}
              expanded={open[p.id]}
              onToggle={() => setOpen((o) => ({ ...o, [p.id]: !o[p.id] }))}
              activeId={activeId}
              onOpen={onOpen}
              onToggleReadOnly={onToggleReadOnly}
              onNewTask={onNewSession}
            />
          );
        })}
        <div style={{ paddingTop: "var(--space-3)" }}>
          <NodeHeader label="Tasks" addLabel="New task" addIcon="plus" onAdd={onNewSession} />
          {loose.map((t) => (
            <SessionRow key={t.id} title={t.title} time={t.time} status={t.status} running={t.running} readOnly={t.readOnly} active={activeId === t.id} onClick={() => onOpen(t)} onToggleReadOnly={(e) => { e.stopPropagation(); onToggleReadOnly(t.id); }} />
          ))}
        </div>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)" }}>
        <IconButton label="Archive (planned)" disabled style={{ width: 26, height: 26 }}><Icon name="archive" size={14} /></IconButton>
        <span style={{ fontSize: "var(--font-size-caption)", color: "var(--color-text-primary)" }}>Archived（0）</span>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)" }}>
        <span style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 26, height: 26, color: "var(--color-text-secondary)" }}>
          <Icon name="gauge" size={14} />
        </span>
        <div style={{ display: "flex", gap: 3 }}>
          {[0, 1, 2, 3, 4, 5, 6].map((i) => (
            <span key={i} style={{ width: 10, height: 10, borderRadius: 2, background: i < 5 ? "var(--color-accent)" : "var(--color-bg-hover)" }} />
          ))}
        </div>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)" }}>
        <span style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 26, height: 26, borderRadius: "var(--radius-pill)", background: "var(--color-bg-muted)", color: "var(--color-text-tertiary)" }}>
          <Icon name="user" size={14} />
        </span>
        <span style={{ flex: 1, fontSize: "var(--font-size-caption)", color: "var(--color-text-primary)" }}>User Name</span>
        <IconButton label="Settings" onClick={onSettings}><Icon name="settings" size={16} /></IconButton>
      </div>
    </aside>
  );
}

Object.assign(window, { Sidebar, SidebarRail, ProjectGroup });
