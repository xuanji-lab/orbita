The standard Orbita button — neutral by default; the accent (blue on light, yellow on dark) only when it is the single primary action.

```jsx
<Button variant="accent" buttonSize="sm">Start Agent</Button>
```

Variants: `primary` (near-black neutral), `secondary` (default, muted fill + hairline), `danger`, `ghost`, `accent`. Accent is scarce by rule: one per screen at most. Sizes `sm` (32px) and `md` (36px); `loading` swaps in a spinner and disables.
