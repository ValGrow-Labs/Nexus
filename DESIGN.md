# Design: the Spine system

Nexus is the app's shell. Its design system is called Spine.

## Principles

1. **The spine is built from real state only.** The project spine lists nodes derived from the project's folder and git working tree (a source node, a changes node when the tree is dirty). No placeholder artifacts, versions, users, metrics, deployments or runs. Empty states say so plainly.
2. **Colour means provenance.** A hue identifies which workspace something came from. There is no decorative colour, no gradient identity and no run accent. A workspace's hue comes from its permanent slot (see the slot rule), never from how many workspaces exist.
3. **Unavailable is stated, never faked.** Where the lead agent does not report a plan, output, review or approval, the UI says "Not reported by this agent". Actions the app cannot perform (Accept, Discard, Promote) are not rendered as buttons.
4. **One intent line, bound to the selection.** A single docked line (Ctrl/Cmd J) carries a context chip built from the current selection (workspace, project, spine node). Suggestions prefill; they never send on their own.
5. **Offline, keyboard-first, accessible.** Fonts ship in the bundle. Every surface is reachable by keyboard, motion respects `prefers-reduced-motion`, and hue never carries meaning without a text label.

## Tokens

- `src/renderer/src/nexus/styles/tokens.css` is the source of truth: the `--nx-*` tokens, in OKLCH. Dark values apply under `:root[data-cth-theme="dark"]`, the app's existing theme switch (`design/theme.ts`).
- Colour roles: `--nx-ground`, `--nx-surface`, `--nx-sunken`, `--nx-ink`, `--nx-text-2`, `--nx-text-3`, `--nx-line`, `--nx-line-strong`, `--nx-on-ink`, `--nx-ok`, `--nx-warn`, `--nx-bad`, `--nx-hatch`, `--nx-shadow-float`.
- Other tokens: `--nx-font-*`, `--nx-r-*`, `--nx-s*`, `--nx-t-*`, `--nx-ease-*`, `--nx-bar-h` (48px).
- Contrast floors, enforced by `test/nexus-tokens.test.cjs` in both themes: body text 4.5:1, structural borders (`--nx-line-strong`) 3:1, text on an ink fill 4.5:1.
- Borders over shadows. `--nx-shadow-float` is used only on floating layers (palette, menus, sheets).

### Provenance rule and slot rule

- Provenance colour for an element is `oklch(var(--nx-ws-l) var(--nx-ws-c) var(--ws-h))`. `--nx-ws-l` and `--nx-ws-c` are per theme (light 0.56 / 0.13, dark 0.74 / 0.12). `--ws-h` is set inline on the element (`.nx-prov`, rendered by `ProvenanceMark`).
- Slot rule: `nexus/design/provenance.ts` exports `provenanceHue(slot) = round(((265 + slot * 137.508) % 360) * 10) / 10`. Each workspace in `nexus/workspaces/registry.ts` has a permanent `hueSlot` (0 to 7 today; a new workspace takes max+1). Slots walk the golden angle from base hue 265, so existing hues never change when workspaces are added.
- A project whose domain maps to no workspace is "Unassigned" and uses `.nx-prov--none` (neutral `--nx-line-strong`), not a hue.
- Marks always sit beside a text label and meet 3:1 against surfaces.

## Typography

Four families, bundled through Fontsource (OFL-1.1, listed in `THIRD_PARTY_FONTS.md`), imported in `src/renderer/src/main.tsx`. No network font loading, and no Google Fonts entries in the CSP.

| Role | Family (package) | Token |
|---|---|---|
| Names people give (workspace, project titles) | Bricolage Grotesque Variable (`@fontsource-variable/bricolage-grotesque`) | `--nx-font-display` |
| Interface | Instrument Sans Variable (`@fontsource-variable/instrument-sans`) | `--nx-font` |
| Versions, commit shas, ids, paths in chips | Martian Mono, weights 400 and 500 (`@fontsource/martian-mono`) | `--nx-font-id` |
| Code, diffs, terminals | JetBrains Mono, weights 400, 500 and 700 (`@fontsource/jetbrains-mono`) | `--nx-font-code` |

Sizes are not tokenised; each stylesheet sets its own `font` shorthand. In practice UI text runs from 11px to about 15px (12px and 12.5px are the most common for controls and labels, 13 to 14px for body text). Headings step up from there: the project surface title is 26px (`styles/project.css`) and the launcher query is 44px (`styles/launcher.css`). JetBrains Mono is loaded as a static family so the literal `"JetBrains Mono"` used by the terminal pool and Monaco keeps working.

## Spacing and shape

- Base unit 4px: `--nx-s1` 4, `--nx-s2` 8, `--nx-s3` 12, `--nx-s4` 16, `--nx-s6` 24, `--nx-s8` 32, `--nx-s12` 48.
- Radius: `--nx-r-ctl` 4px for controls, `--nx-r-obj` 8px for objects. Fully round only for status chips.
- Breakpoints: 1280 and 768. At 1280 and up: context bar, spine, tool rail, focus surface and passport column. From 768 to 1279: the tool rail becomes a segmented control and the passport opens as a right sheet. Below 768: mobile tabs, a vertical spine with runs first, and no IDE, terminal or diff.

## Motion

- Durations: `--nx-t-fast` 120ms, `--nx-t-base` 200ms, `--nx-t-shift` 320ms. Easing: `--nx-ease-in` is `cubic-bezier(0.2, 0, 0, 1)`, which decelerates and is used for entering and opening; `--nx-ease-out` is `cubic-bezier(0.4, 0, 1, 1)`, which accelerates and is used for exits. The names describe the motion's role (in = arriving, out = leaving), not the CSS easing convention.
- Every animation communicates a state change. No decorative loops.
- Transitions and keyframes live inside `@media (prefers-reduced-motion: no-preference)`.
- Route changes use a document view transition through `nexus/ui/viewTransition.ts` (`withViewTransition`). It is skipped under `prefers-reduced-motion: reduce` and when the browser lacks `startViewTransition`; navigation always happens. A `reduce` rule in `styles/project.css` also removes view-transition animations.
- `design/global.css` additionally zeroes all animation and transition durations under `reduce`, which covers legacy screens.

## Accessibility

- Launcher: ARIA combobox and listbox (`aria-activedescendant`, `aria-selected`); the preview is an `aria-live="polite"` region.
- Spine: one tab stop with roving tabindex; arrow keys, Home and End move; each node has a full accessible name.
- Run strip: an `article` labelled by its title, with an ordered list of stages (`aria-label="Stages"`). Each stage's state is carried by a visually hidden text suffix (done, in progress, waiting for you, not started, not reported by this agent) plus a `data-state` bar style, so state never relies on colour or pattern alone. The headline is a polite live region.
- Focus: a visible `:focus-visible` ring on interactive elements, a skip link, and focus moves to the page `h1` on route change.

## Where things live

- `src/renderer/src/nexus/`: all Spine UI. Subfolders: `agents`, `assistant`, `chrome`, `components`, `data`, `design` (provenance), `intent`, `launcher` (the environment emblems only), `pages`, `project`, `review`, `router`, `routes`, `runs`, `state`, `styles`, `ui`, `workspaces`.
- Pure models (no React or `window`, loadable by `test/load-ts.cjs`) include `provenance.ts`, `router/routes.ts`, `project/spineModel.ts`, `project/passport.ts`, `runs/runModel.ts`, `review/reviewModel.ts`, `intent/intentContext.ts`.
- `nexus/agents/workbench`: the agent workbench (header, section tabs, native lead sections, hosted tools) mounted on the Agents page and in fullscreen.
- `src/renderer/src/design/tokens.css`: the legacy `--cth-*` tokens, now references to `--nx-*`.
- `src/renderer/src/design/tokens.ts`: sRGB mirror of the light-theme values. Its runtime colours are read only by `scene/office`; `AddAgentModal`, `AgentCard`, `PixelPanel`, `store` and `memoryGraph/buildGraph` import only its types (`AccentColorName`). Update with `tokens.css`.
- `src/renderer/src/design/global.css`: reset, focus ring, scrollbars, keyframes, markdown preview, reduced-motion rule.
- `test/nexus-decoupling.test.cjs`: guards `nexus/` against the retired office scene, pixel components, persona names and the old product identity, and against `"Inter"` and plain horizontal gradients in Nexus CSS (repeating gradients are textures and are allowed).

## Start page motion exception

The Start page at `#/` (`nexus/start/*`, `styles/start.css`) is the one place ambient motion is allowed. It was requested explicitly so the front door feels alive. Every other surface keeps the Motion rules above. The old dark environment picker (`#/browse`, an instrument wall) is gone: "Browse all environments" on Start opens the Workspaces list, and an old `#/browse` link opens it too.

- **Start (Home), `#/`.** An intent-first page: describe, then confirm, then start.
  - Detection (`start/startModel.ts`, tested) maps the words to a registry environment, or to none and never a guess.
  - Pressing Start creates the project when a new folder was chosen, then hands the request to the project's AI helper, which begins the build.
  - It has its own violet-to-blue palette. Waves, a laptop and glass tiles are drawn in code and drift gently. The chosen environment's emblem (`launcher/emblems.ts`) and provenance colour appear next to the request.
- **Reduced motion.** Every keyframe and transition sits under `prefers-reduced-motion: no-preference`. With `reduce`, the page is static and fully usable.
- **Still enforced.** No plain horizontal gradients and no Inter. `test/nexus-start.test.cjs` and `test/nexus-emblems.test.cjs` cover the helpers.

## Legacy screens

The project Command Center is retired. Agents work in the agent workbench (`nexus/agents/workbench/*`), which is Nexus-native; its hosted tools (Triggers, History, Memory, Graph, Skills, Workers), the Agents page's Semantic memory panel and Manage projects use the Nexus classes in `styles/hosted.css` instead of pixel chrome. The IDE, settings, the remaining modals and the terminals are not redesigned. They are re-skinned: every `--cth-*` colour token points at a `--nx-*` role, and `--cth-font-ui` is Instrument Sans, so they follow the Spine palette and both themes. The `--cth-*` names are legacy (`cream`, `paper`, `ink` describe the old palette); the role mapping is documented at the top of `design/tokens.css`. Do not add new tokens to the `--cth-*` set; add `--nx-*` tokens instead.

The office floor (`scene/office/*`) is isolated legacy code. It is not rendered by any Nexus surface.
