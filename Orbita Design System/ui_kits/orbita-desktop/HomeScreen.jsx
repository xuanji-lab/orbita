const { SessionCard, Composer, Chip, Icon } = window.OrbitaDesignSystem_994749;

function HomeScreen({ value, onChange, onSubmit, exiting, onOpenSession }) {
  const cards = window.SESSIONS.slice(0, 3);
  return (
    <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", padding: "var(--space-5)", overflow: "hidden" }}>
      <div style={{ width: "min(100%, var(--content-max-width))", display: "flex", flexDirection: "column", alignItems: "center", gap: "var(--space-5)" }}>
        <h1 className={exiting ? "fade-out" : ""} style={{ margin: "0 0 var(--space-1)", fontFamily: "var(--font-family-brand)", fontSize: "var(--font-size-logo)", fontWeight: 600, letterSpacing: "var(--tracking-slogan)", color: "var(--color-text-primary)", textAlign: "center" }}>
          璇玑运转，诸事得序
        </h1>
        <div className={exiting ? "fade-out" : ""} style={{ display: "flex", gap: "var(--space-3)", width: "100%" }}>
          {cards.map((c) => (
            <SessionCard key={c.id} name={c.project} queries={c.queries || []} running={c.running} onClick={() => onOpenSession(c)} />
          ))}
        </div>
        <div className={exiting ? "slide-down" : ""} style={{ width: "100%" }}>
          <Composer
            value={value}
            onChange={onChange}
            onSubmit={onSubmit}
            topSlot={<Chip icon={<Icon name="folder" size={12} />} chevron>orbita-desktop</Chip>}
            bottomSlot={
              <>
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

Object.assign(window, { HomeScreen });
