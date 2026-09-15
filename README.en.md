<div align="center">

# dsh-model-search

**A search box for DeepSeek Harness model lists**

Fetched a hundred models from a custom provider? Stop scrolling for the one you want.

[![License](https://img.shields.io/badge/license-MIT-blue.svg?style=flat-square)](LICENSE)
[![DSH Plugin](https://img.shields.io/badge/topic-dsh--plugin-0e7490?style=flat-square)](https://github.com/topics/dsh-plugin)
[![Version](https://img.shields.io/badge/version-1.0.0-green?style=flat-square)](package.json)

[简体中文](README.md) · **English**

</div>

---

## The problem

When you add a custom provider in DSH (an OpenAI-compatible gateway, a self-hosted
server, a relay), "**Fetch available models**" returns a checkbox list. Providers
routinely serve dozens or hundreds of models, and that dialog has **no search box** —
you scroll, you squint, and the model whose name you remember stays hidden.

Once the models are configured there is a second, identical pain: the **model menu**
next to the composer lists every model grouped by provider, and it has no search
either.

This plugin adds a search box to both:

<p align="center">
  <img src="docs/dialog-search.png" alt="Search box in the “Choose models to add” dialog" width="640">
</p>

<p align="center">
  <img src="docs/menu-search.png" alt="Search box in the composer model menu" width="560">
</p>

Both screenshots come from a real, locally running DSH instance (produced by
`node scripts/e2e-dsh.mjs`, which drives the UI in headless Chrome).

## Features

**① The "fetch available models" dialog**

- A search box appears above the candidate list and filters as you type, leaving the host layout untouched
- **Multiple keywords**: space-separated, all must match (`deepseek v4`)
- **Fuzzy fallback**: when no substring matches, it falls back to subsequence matching (`dsv4flash` → `deepseek-v4-flash`) and labels the result "fuzzy match"
- **Live counters**: `6 / 19 shown · 12 selected`
- **Select results / Deselect results**: batch-toggle only the rows the filter currently shows — "filter then select all" becomes one click
- Keyboard: just start typing; `Esc` clears the search (without closing the dialog); `↑ ↓` move between results; `Enter` picks a single remaining match

**② The composer model menu**

- Opening the "Model" sub-panel reveals a search box that filters model items and hides whole groups with no match

**③ Out of the way**

- No search box for short lists (fewer than 8 items by default)
- Each surface can be disabled independently; the threshold is configurable

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

Nothing to configure. Open **Settings → Models → Edit (a custom provider) → Fetch
available models** and the search box is there.

The search box is focused automatically when the dialog opens, so you can start
typing right away (disable with `autoFocus` below).

## Options

From the browser console, via `dshModelSearch` (persisted in `localStorage`):

```js
dshModelSearch.options                      // current options
dshModelSearch.set({ autoFocus: false })    // do not steal focus
dshModelSearch.set({ minItems: 3 })         // show the box from 3 items on
dshModelSearch.set({ menu: false })         // dialog only, no composer menu
dshModelSearch.set({ lang: 'en' })          // force English copy (default 'auto')
dshModelSearch.reset()                      // back to defaults
```

| Option | Default | Meaning |
| --- | --- | --- |
| `dialog` | `true` | Search box in the "fetch available models" dialog |
| `menu` | `true` | Search box in the composer model menu |
| `minItems` | `8` | Hide the box when the list is shorter than this |
| `autoFocus` | `true` | Focus the box when the dialog opens |
| `lang` | `'auto'` | Copy language: `auto` / `zh` / `en` |

Storage key: `localStorage["dsh-model-search:options"]`.

## How it works (and an honest caveat)

The candidate list and the model menu are **private DOM** of built-in DSH components
with no extension slot exposed, so this plugin enhances the DOM in place, under three
strict rules:

1. **Add only, never modify**: it inserts its own search bar and never moves, removes, or reorders host nodes;
2. **Touch only attributes the host does not own**: filtering uses `style.display` (the host sets no `style` prop, so React never overwrites it) — never `className`, never controlled props;
3. **Structural detection instead of hashed class names**: the candidate list is recognized as "a `<ul>` holding only `<li>`s that each contain a checkbox" (unique in the app), the model menu as `div[role="menu"]` plus `section[role="group"]`.

**So**: if a future DSH release changes those structures, this plugin **degrades
silently** (no search box) rather than breaking the UI, and every entry point is
wrapped in `try/catch` that at worst leaves a console warning.

Development is verified against `@deepseek-ai/dsh@0.1.1-rc.2` (the DSH Web UI). The
`role="menuitemradio"` layout difference in the composer menu was actually caught by
the real-browser E2E run — the unit-test fixtures now mirror the real DOM.

## Development

This repo has zero build dependencies: `lib/client.js` is produced by wrapping
`src/client.js` in DSH's `window.__ModuleLoader__.load({ id, factory })` envelope.

```bash
npm run build     # src/ → lib/client.js (inlines CSS, checks the version)
npm test          # 30 cases: pure logic + the real artifact loaded in jsdom
node scripts/e2e-dsh.mjs --screenshot out.png   # real-browser E2E (needs a running dsh web)
```

```
src/client.js        browser half (the factory body: apply / inject)
src/client.css       injected styles (DSH theme variables, light and dark)
scripts/build.mjs    bundler (dependency-free: envelope + inlined CSS)
scripts/e2e-dsh.mjs  headless-Chrome E2E: open settings → fetch models → assert filtering
lib/index.js         host half (a no-op shell so the Loader discovers the browser half)
lib/client.js        built artifact (committed — installs need no build)
test/                node:test suites (with jsdom fixtures)
```

## Compatibility

- DSH Web UI (`dsh web`), desktop and mobile browsers
- Purely client-side: writes no config, serves no routes, reads no credentials; unloading restores everything

## License

[MIT](LICENSE) © 2026 Xstone1129
