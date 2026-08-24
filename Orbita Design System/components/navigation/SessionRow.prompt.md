A session in the sidebar tree: status in the leading slot, title, time, and a lock that appears on hover.

```jsx
<SessionRow title="Unify the glass alphas" time="14:22" active running />
```

Rows sit directly on layer 1 with a transparent background; hover and the open row share one neutral `--color-bg-hover` fill, and the active row is marked by weight, never by tint. Status lives in the leading 13px slot as an icon with a label (spinning loader while running, check when finished, triangle-alert on failure) — never a coloured row or a bare dot.
