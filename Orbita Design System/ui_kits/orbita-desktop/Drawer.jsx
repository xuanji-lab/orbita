const { Badge, IconButton, Icon } = window.OrbitaDesignSystem_994749;

/** Right drawer — closed by default. Files slice only; the git, terminal and
 *  browser slices are not recreated here (see README). */
function Drawer({ open, onClose }) {
  if (!open) return null;
  return (
    <aside style={{ width: 320, flex: "0 0 320px", display: "flex", flexDirection: "column", background: "var(--color-bg-panel)", borderLeft: "1px solid var(--color-border-subtle)", boxShadow: "var(--shadow-drawer)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "12px 14px", borderBottom: "1px solid var(--color-border-subtle)" }}>
        <strong style={{ flex: 1, fontSize: "var(--font-size-control)", fontWeight: "var(--weight-semibold)" }}>Changed files</strong>
        <Badge variant="muted" mono>{window.DRAWER_FILES.length}</Badge>
        <IconButton label="Close panel" onClick={onClose}><Icon name="x" size={16} /></IconButton>
      </div>
      <div className="scroll" style={{ flex: 1, padding: "var(--space-2)" }}>
        {window.DRAWER_FILES.map((f) => (
          <button
            key={f.name}
            type="button"
            style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", width: "100%", minHeight: 36, padding: "6px 8px", border: 0, borderRadius: "var(--radius-sm)", background: "transparent", textAlign: "left", cursor: "pointer", fontFamily: "var(--font-family-base)" }}
            onMouseEnter={(e) => (e.currentTarget.style.background = "var(--color-bg-hover)")}
            onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
          >
            <span style={{ color: "var(--color-text-tertiary)", display: "inline-flex" }}><Icon name="file-text" size={13} strokeWidth={1.8} /></span>
            <span style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
              <span style={{ fontSize: "var(--font-size-control)", color: "var(--color-text-primary)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{f.name}</span>
              <span style={{ fontFamily: "var(--font-family-mono)", fontSize: "var(--font-size-micro)", color: "var(--color-text-tertiary)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{f.path}</span>
            </span>
            <span style={{ fontFamily: "var(--font-family-business)", fontSize: "var(--font-size-micro)", color: "var(--color-accent)" }}>+{f.added}</span>
            <span style={{ fontFamily: "var(--font-family-business)", fontSize: "var(--font-size-micro)", color: "var(--color-danger)" }}>−{f.removed}</span>
          </button>
        ))}
      </div>
      <div style={{ padding: "10px 14px", borderTop: "1px solid var(--color-border-subtle)", display: "flex", alignItems: "center", gap: 6, color: "var(--color-text-tertiary)", fontSize: "var(--font-size-caption)" }}>
        <Icon name="git-branch" size={12} strokeWidth={1.8} />
        <span style={{ fontFamily: "var(--font-family-business)" }}>feature/glass</span>
      </div>
    </aside>
  );
}

Object.assign(window, { Drawer });
