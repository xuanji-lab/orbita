Labelled dropdown, visually matched to TextField (36px, hairline, accent focus).

```jsx
<SelectField label="Theme" value={theme} options={[{value:"light",label:"Light"},{value:"dark",label:"Dark"}]} onChange={setTheme} />
```

Use for closed sets of 3+ options in settings; two options should be a mode chip pair instead.
