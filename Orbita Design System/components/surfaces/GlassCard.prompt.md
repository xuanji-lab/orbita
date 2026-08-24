Every frosted surface in Orbita — nest by layer, never by inventing a new fill.

```jsx
<GlassCard layer={1} padding="var(--space-8)">
  <GlassCard layer={2} padding="var(--space-8) 48px">…</GlassCard>
</GlassCard>
```

Layer 1 is the application boundary, 2 the chat surface, 3 the input box and session cards. Each level is more solid than the last; text inside is always a solid `--color-text-*`, never translucent.
