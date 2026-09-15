<div align="center">

# dsh-model-search

**A two-level model picker (provider → model) and a Codex-style draggable reasoning-effort bar for DeepSeek Harness**

A hundred models? Pick the route on the left, the model on the right — grouped into DeepSeek / GPT / others.

[![License](https://img.shields.io/badge/license-MIT-blue.svg?style=flat-square)](LICENSE)
[![DSH Plugin](https://img.shields.io/badge/topic-dsh--plugin-0e7490?style=flat-square)](https://github.com/topics/dsh-plugin)
[![Version](https://img.shields.io/badge/version-1.2.1-green?style=flat-square)](package.json)

[简体中文](README.md) · **English**

</div>

---

## The problem

When you add a custom provider in DSH (an OpenAI-compatible gateway, a self-hosted
server, a relay), "**Fetch available models**" returns a checkbox list. Providers
routinely serve dozens or hundreds of models, and that dialog has **no search box** —
you just scroll.

Once the models are configured there are two more of the same:

- the **model menu** next to the composer lays every route's models out in one long
  column;
- the **reasoning effort** hides two panes deep behind "Model / Reasoning effort".

This plugin fixes all three:

<p align="center">
  <img src="docs/menu-search.png" alt="Model menu: providers on the left, family-grouped models on the right, reasoning-effort bar at the bottom" width="600">
</p>

<p align="center">
  <img src="docs/dialog-search.png" alt="Search box in the “Choose models to add” dialog" width="640">
</p>

Both screenshots come from a real, locally running DSH instance (produced by
`node scripts/e2e-dsh.mjs`, which drives the UI in headless Chrome).

## Features

**① The model menu becomes a two-level cascade (providers → models)**

- Opens as two columns: **routes on the left** (official / lingsuan / chatanywhere…, with model counts and the active one highlighted), **that route's models on the right**
- Click another route on the left and the right column swaps immediately; the left column stays put, so comparing routes needs no reopening
- **The right column groups models by family**: DeepSeek / GPT / Claude / Gemini / Qwen / GLM / Kimi / Grok / Llama / Mistral / MiniMax… anything unrecognized lands in "Other" and always sorts last. When one family is spread across several relay routes, this is where it comes back together
- Opening the menu **lands directly on the model pane**, skipping the extra "Model / Reasoning effort" click (`openToModels` turns that off)
- **No flash**: the host's original list is taken over within the same frame, so the first thing you see is already the plugin's version

**② The model menu: search**

- A search box on top filters both columns live: the left keeps the routes that match, the right keeps the models that match
- When matches are spread across routes, an "**All providers**" entry appears — the cross-route model list, still grouped by route and family
- Zero substring hits fall back to subsequence matching (`dsv4flash` → `deepseek-v4-flash`) and say so
- If the current route has no match at all, the right column moves to the first route that does — you don't have to click the left column yourself

**③ Reasoning effort: a draggable energy bar in the same box**

- Sits at the bottom of the model menu, **in the same panel** as the model list: `Reasoning ▮▮▮▯ High`
- **Drag** it, **click** a segment, or use **←→ / ↑↓**; dragging previews live and only commits on release
- The levels are the model's **real** levels, read from the host's model directory rather than guessed (DeepSeek's official models expose Off/Low/High/Max, other routes may expose two or three), with full `role="slider"` + `aria-valuenow/valuetext` semantics
- Committing calls the host's own `directory.select()` — exactly what clicking the host's menu does

**④ The "fetch available models" dialog: search and batch selection**

- A search box on top; multiple space-separated keywords (AND); automatic fuzzy fallback when nothing matches
- Live counters: `6 / 19 shown · 12 selected`
- **"Select results" / "Deselect results" touch only the rows the filter currently shows** — "filter then select all" becomes one click
- `Esc` clears the search (without closing the dialog), `↑↓` moves between results, `Enter` picks a single remaining match
- Focused automatically when the dialog opens, so you can just start typing

**⑤ Out of the way**

- Nothing happens for catalogues under 8 models — the UI stays exactly as shipped
- Each surface can be disabled independently; the cascade itself can be turned off (`drilldown: false` restores the single-column list)
- Purely client-side: writes no config, serves no routes, reads no credentials

## Install

**Option 1 — the official command (recommended)**

```bash
# Install from GitHub (no build step: the bundle is committed)
dsh plugin --profile web add github:Xstone1129/dsh-model-search
```

Then **reload the page**; restart `dsh web` if it does not take effect.

**Option 2 — manual (no restart, handy for local hacking)**

```bash
cd ~/.dsh/profiles/web
pnpm add file:/path/to/dsh-model-search
```

and add the entry to that profile's `cordis.patch.yml` (the file is watched live):

```yaml
- insert:
    - id: dsh-model-search
      name: 'dsh-model-search'
```

Reload the page — no `dsh web` restart needed.

> ⚠️ Do not use both at once: inserting the same entry twice loads the plugin twice.
> Remove the three manual lines before installing with option 1.

## Usage

Nothing to configure:

- **Switch models**: click the model name next to the composer → pick a route on the left → pick a model on the right (the current one is ticked)
- **Change reasoning effort**: drag or click the bar at the bottom of the menu
- **Add models**: Settings → Models → edit a custom provider → Fetch available models → search

## Options

From the browser console, via `dshModelSearch` (persisted in `localStorage`):

```js
dshModelSearch.options                        // current options
dshModelSearch.set({ drilldown: false })      // no cascade: one flat list + search
dshModelSearch.set({ openToModels: false })   // keep the host's root pane when opening
dshModelSearch.set({ minItems: 3 })           // take over from 3 models on
dshModelSearch.set({ menu: false })           // dialog only, leave the model menu alone
dshModelSearch.set({ lang: 'en' })            // force English copy (default 'auto')
dshModelSearch.reset()                        // back to defaults
```

| Option | Default | Meaning |
| --- | --- | --- |
| `dialog` | `true` | Search box in the "fetch available models" dialog |
| `menu` | `true` | Rework the composer model menu (search + cascade + effort bar) |
| `drilldown` | `true` | Two-level cascade (routes left / models right); `false` = flat list |
| `openToModels` | `true` | Jump straight to the model pane (press `Esc` for the root pane) |
| `minItems` | `8` | Do nothing below this many models |
| `autoFocus` | `true` | Focus the dialog search box on open |
| `lang` | `'auto'` | Copy language: `auto` / `zh` / `en` |

Storage key: `localStorage["dsh-model-search:options"]`.

### Keyboard

| Where | Key | Effect |
| --- | --- | --- |
| Search box | typing | Live filtering across both columns |
| Search box | `Esc` | Clear the search → leave "All providers" → hand `Esc` back to the host |
| Search box | `↑ ↓` | Focus the first / last model in the right column |
| Search box | `Enter` | Select the only candidate, otherwise focus the first one |
| Effort bar | `← →` / `↑ ↓` | Step one level down / up and apply it |
| Either column | `↑ ↓` | Move focus within that column |

## How it works (and an honest caveat)

The two host components (`dsh-client-ui-settings-models`,
`dsh-client-ui-model-selection`) own private DOM with no extension slot exposed, so
this plugin enhances the DOM in place under three strict rules:

1. **Add only, never modify**: it inserts its own nodes (search bar, the two columns, the effort bar) and never moves, removes, or reorders host nodes;
2. **Touch only attributes the host does not own**: hiding the host list uses `style.display` (the host sets no `style` prop, so React never overwrites it) — never `className`, never controlled props;
3. **Structural detection instead of hashed class names**: the candidate list is recognized as "a `<ul>` holding only `<li>`s that each contain a checkbox" (unique in the app), the model menu as `div[role="menu"]` plus `section[role="group"]`.

**Clicking a model still has exactly one source of truth**: every row in the right
column forwards its click to the host's own (hidden) button, so selection, menu
closing and error reporting all run the host's existing logic.

**The effort levels are never guessed**: they are per-model capabilities, so the bar
reads `reasoning.efforts` for the current model from the host's client service
`modelDirectories` and commits through its `select()` — the identical entry point the
host itself uses. When that service is unavailable (or the session is unknown) the bar
quietly disappears and everything else keeps working.

**Why there is no flash**: a MutationObserver callback is a microtask and the browser
only paints after the current task, so the plugin performs "hide the host list + switch
the pane + mount the two columns" **synchronously** inside that callback. The throttled
80 ms scan is only a fallback.

**So**: if a future DSH release changes those structures, the plugin **degrades
silently** (it stops taking over) rather than breaking the UI, and every entry point is
wrapped in `try/catch` that at worst leaves a console warning.

Development is verified against `@deepseek-ai/dsh@0.1.1-rc.2` (the DSH Web UI). The
real-browser E2E has already caught three issues that only show up when it actually
runs: the model items are `role="menuitemradio"`, the auto-focus guard was wrong, and
the effort bar was clipped by the menu's `max-height`.

## Development

This repo has zero build dependencies: `lib/client.js` is produced by wrapping
`src/client.js` in DSH's `window.__ModuleLoader__.load({ id, factory })` envelope.

```bash
npm run build          # src/ → lib/client.js (inlines CSS, checks the version)
npm test               # 59 cases: pure logic + the real artifact in jsdom + a fake model directory
npm run check:browser  # real-Chrome checks (layout/focus); does NOT need dsh web running
node scripts/e2e-dsh.mjs --screenshot out.png   # real-browser E2E (needs a running dsh web)
node scripts/e2e-dsh.mjs --skip-effort          # the run that leaves your settings alone
node scripts/e2e-dsh.mjs --set-effort High      # maintenance: drag the effort to a named level
```

```
src/client.js        browser half (the factory body: apply / inject)
src/client.css       injected styles (DSH theme variables, light and dark)
scripts/build.mjs    bundler (dependency-free: envelope + inlined CSS)
scripts/e2e-dsh.mjs  headless-Chrome E2E: dialog search / cascade / effort drag (real mouse events)
scripts/browser-check.mjs  real-Chrome self-check: stable panel size, real clicks keep the menu open
test/harness.html    the page that self-check drives (inlines the host menu's layout rules)
lib/index.js         host half (a no-op shell so the Loader discovers the browser half)
lib/client.js        built artifact (committed — installs need no build)
test/                node:test suites (jsdom fixtures + a fake modelDirectories service)
```

> The E2E drag does change a setting: model/effort selection in an empty session is
> written to `settings.yaml` under `agent-default-model`. The script restores the level
> it found; pass `--skip-effort` to keep it away entirely.

## Compatibility

- DSH Web UI (`dsh web`), desktop and mobile browsers
- Purely client-side: writes no config, serves no routes, reads no credentials; unloading restores everything

## License

[MIT](LICENSE) © 2026 Xstone1129
