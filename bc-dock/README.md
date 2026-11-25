# Dock

*Part of [Nightstand](../README.md). Not installed on its own: the Nightstand script brings it along.*

A small shared frame that Little Black Book, Quick Actions, Vibe Link, Afterglow, Quiet and Held Remote put their panels and buttons in, so they
stop floating separately and overlapping the game. It's only the frame: each add-on keeps its own
settings, storage and logic.

## How it fits together

- `bc-dock.js` is loaded by the Nightstand script (`@require`), and loads the add-ons after it (see
  [One script for all add-ons](#one-script-for-all-add-ons)). Each add-on adds its panel or button to the dock;
  an add-on that's switched off simply has no tab.
- If two different versions are loaded, the newer one takes over and keeps the panels already added. For
  development the dev loaders all point at the same file (`bc/bc-dock/bc-dock.js`), so there is one copy to edit.

## What it looks like

```
▐👥²│                       tabs hang off the screen edge (left by default)
▐⚡ │┌ ⚡ Quick Actions → Robin A− A+ ✕ ┐   clicking a tab slides its panel out beside it
▐〰●│└ …                                ┘   (one panel at a time; click the tab again to close)
▐⚙ │                                        ⚙ = dock settings
```

- **📓** opens Little Black Book in a large panel (from dock 23; with an older dock, its own big window). Its badge is the unread count.
- **🔔** is Quiet's button: one click mutes the game's notifications in that tab (🔕), another turns them back on.
- **🎚** switches Held Remote on or off.
- **⚡ / 〰 / ✨** slide out Quick Actions / Vibe Link / Afterglow. The panel header shows the title, a one-line
  summary, the add-on's own buttons (Vibe Link's 🛑) and ✕.
- Tabs show a **badge** and a **status dot** (Vibe Link: green = toy connected, yellow = waiting,
  red = stopped or can't reach Intiface).
- **Drag any tab** to slide the rail along its edge, or toward another edge (left, right, top or
  bottom) to move it there. Top and bottom suit the black bars around the game when the browser
  window is wider or taller than the game. Panels open toward the middle of the screen.
- **⚙** holds the dock's settings: **panel opacity** (30–100 %: how much of the game shows through
  open panels, including Little Black Book's window; text stays solid), edge, reset position and the
  **theme**.
- **Theme**: Amethyst (the original purple), Midnight, Rose, Forest, Ember, Graphite, Royal (navy and gold), or **🎨 Custom**
  with three color pickers: **Background**, **Accent** (borders, active tab, buttons, sliders) and
  **Glow** (charts and highlights). Every other shade is mixed from those three. Changes apply as you
  drag. A background too light for the add-ons' light text is darkened automatically. Friend
  Manager's window, Vibe Link and Quick Actions all follow the theme.
- Drag a panel's outer edge to change its width (kept per panel). Little Black Book's panel also has a height: drag its bottom edge, or a floating window's bottom-right corner, to resize it.
- **Floating windows:** drag a panel's title bar away from the rail and it gets a window of its own, anywhere on
  the screen. A floating window stays open next to the docked panel and other floating ones. Its tab opens and
  closes it, and **⇤** in its title bar puts it back on the rail. Which panels float, where they are and whether
  they're open are remembered. In ⚙ → **Panel windows**, **Keep panels on the rail** puts them all back and stops
  title bars from being dragged away, and **Put all back on the rail** puts them back and forgets where they were
  (so does **Reset position**). ⚙ always stays on the rail.
- Tabs hide when their add-on has nothing to show (Quick Actions outside chat rooms, everything when
  logged out). A panel hidden that way comes back open when its tab returns.
- Position, side, opacity, theme, widths, floating windows and the open panel are kept in this browser's `localStorage`
  (`BCDock.v2`).
- Tabs stay in a fixed order: Little Black Book, Quick Actions, Vibe Link, Afterglow, Quiet, Held Remote.

## Browser tab title

The dock puts the logged-in character's name (their nickname, if they've set one) in the browser tab, so your
game tabs can be told apart: **(3) Sky · Bondage Club**. The game's own count of unread notifications stays in
front. Logged out, the tab says Bondage Club as usual. Switch it off in **⚙ → Browser tab → Character name in the
tab**.

Add-ons can put a small marker in front of the name: Quiet shows **🔕** while the tab is muted, and Vibe Link
shows **〰** while it's connected to Intiface, e.g. **🔕〰 Sky · Bondage Club**.

- The dock watches the page's `<title>` and adds the name each time the game (or another add-on) writes it. No game
  function is hooked, and it keeps up in a background tab.
- For add-on authors: `BCDock.setTitleMark(id, text)` sets a marker (an emoji or two) under your add-on's id; `null`
  removes it. Check that it exists first (`window.BCDock?.setTitleMark?.(…)`): docks before version 13 don't have it.

## One script for all add-ons

With the **Nightstand** script (`nightstand.user.js`) the dock is also the loader. Every add-on runs at its
latest release unless you choose otherwise: ⚙ starts with **Add-ons**, a menu for each add-on:

- **Off**: not loaded. Switching an add-on off stops it straight away (its tab and hooks go).
- **Latest (x.y.z)**: the newest release. When a new one comes out, it's used the next time the game loads, or
  right away with **Check for updates**. In between, the dock looks for new releases every 24 hours. It doesn't
  swap one in while you play (that could cut off a toy session or a half-typed note): ⚙ gets a green dot, the
  add-on's line says which version is out, and the button turns into **Update now**.
- **A version** (v0.8.0, …): stays on that release until you pick something else. Handy when a new release
  misbehaves. An older version may not understand what a newer one saved, so going back is best kept short.

Changes apply right away, without reloading the game. The line under each menu says what's running (or why it
didn't load). Your choices are kept in this browser (`BCDock.v2`), for every character and tab.

How it works:
- The list of add-ons and their versions is `toolkit.json` on the repository's main branch. Each add-on's file
  is loaded from its release tag through jsDelivr, so a version
  never changes under you. If the list can't be fetched (offline), the one from last time is used.
- The add-ons start a couple of seconds after the game's own scripts are ready.
- In mod lists (WCE, FUSAM and others that show ModSDK mods) they appear as **Nightstand: Afterglow**, **Nightstand: Quiet**
  and so on, each with a link to its folder in the repository.
- If an older one-add-on script (retired) is still installed, that script keeps running its add-on and the menu
  is greyed out with a note. Delete the old script in Tampermonkey to choose here instead.
- Nothing else changes for the add-ons: each one still unloads its previous copy when a new one starts, which is
  what makes switching versions live possible.
- The script turns this on with `window.BCToolkit = { loader: true };` in its body. Without it (the dev loaders) none of
  the loader runs. Console: `BCDock.toolkit.status()`, `BCDock.toolkit.set(id, "latest" | "off" |
  "0.8.1")`, `BCDock.toolkit.check()`.

### Test versions

Test versions let people try a change before it's released. They're pre-release tags such as `ag-v0.9.0-beta.1`,
fixed like any release, and **Latest never picks one**.

- Switch on **Show test versions** under the menus (in ⚙ or the Preferences page). Each menu then also offers
  **Beta (x.y.z-beta.n)** and the individual test versions, marked "(test)". The setting is kept in this browser.
- **Beta** follows the newest test version, and moves on to the release once that's newer, so a tester never stays
  behind a release. New test versions are pointed out like any update (dot on ⚙, **Update now**).
- Switching test versions off puts anything on Beta or a test version back on Latest right away; switching on again
  brings those choices back.
- **Nightstand (beta)** (`nightstand-beta.user.js`, or `loader-beta.js` without Tampermonkey, or FUSAM's "dev"
  choice) is Nightstand with test versions switched on and every add-on starting at Beta. Install it **instead of**
  Nightstand, not next to it. It's also how a test version of the dock itself is tried: its `@require` can point at
  a `tk-vX.Y.Z-beta.N` tag (and `loader-beta.js` loads `dockBeta` from `toolkit.json`) while the normal script stays
  on the release.

### In the game's Preferences

The dock adds a **Nightstand** page to the game's **Preferences → Extensions**, next to WCE's, BCX's and the
others: the same add-on menus and status lines (or, without the loader, the versions running), and a button that
opens the dock's ⚙.

### Without Tampermonkey

`loader.js` in the repository does what the Nightstand script does: it turns the loader on and adds the dock. Which
dock release it adds comes from `toolkit.json` (`dock`), so a new dock reaches it within minutes and `loader.js`
itself hardly ever changes. The [main README](../README.md#without-tampermonkey) has a console line and a bookmark that load it; an
add-on manager can load it the same way (`tools/fusam-entry.json` is the entry for FUSAM's list). Running it twice,
or next to the Tampermonkey script, does nothing more.

## Reloading the add-ons without reloading the game

Developer tools are hidden unless a Tampermonkey loader turns them on. The dev loaders do it with
one line after their `@require`s (one loader is enough; the others can say the same):

```js
window.BCDockDev = { reload: true, watch: false };
```

- `reload: true` shows the **Developer** section in the dock's **⚙** panel and adds `/reload`.
- `watch: true` also allows reloading whenever a file is saved (`/reload watch` and the "on save"
  box). It's off in the dev loaders because it runs whatever lands in the folder without asking.
- Leave the line out of published loaders: there, nothing of this shows or runs.

Nothing else to install: Chrome lets the page read a folder you pick.

1. **Choose folder** and pick the `bc` folder (the folder that holds `bc-dock`, `bc-little-black-book`,
   `bc-quick-actions`, `bc-vibe-link`, `bc-afterglow`). Chrome may ask to let the site view the folder: allow it, and
   choose *Allow on every visit* if offered, so it doesn't ask again after a game reload.
2. Then, in chat:

| Command | Does |
|---|---|
| `/reload` | reloads whatever changed since it was loaded |
| `/reload all` | reloads everything |
| `/reload vibe` (`book`, `qa`, `dock`) | reloads one |
| `/reload watch` | reloads whenever you save a file (needs `watch: true`; remembered; `/reload unwatch` stops) |
| `/reload folder` | picks the folder again |

The ⚙ panel has the same as buttons (**Reload changed**, **Reload all**, **on save**).

- Results show as a 🔧 line in the chat room. A file with a syntax error is reported with its line,
  and the previous version keeps running.
- Each add-on starts fresh (Little Black Book's window closes); the dock keeps its place and reopens an
  open panel; Vibe Link keeps which slot each toy follows and gets Intiface straight back.
- Changes to the Tampermonkey loaders still need a full game reload.
- If Chrome stops allowing the folder (after a browser restart, say), `/reload` says so: press
  **Reload changed** in the ⚙ panel once to allow it again.

## Rules

The dock is only a frame for the other add-ons' panels: it sends nothing to the server or to other
players, and stores only its own position, side, opacity and panel widths in this browser. The
developer reload reads the add-on files from a folder you choose, and only when you ask.

## API

```js
const panel = BCDock.add({
	id: "vibe-link",          // unique
	title: "Vibe Link",
	icon: "〰",                // the tab on the rail, and before the title
	order: 30,                // lower = higher up
	version: "0.2.4",         // shown after the title, in the tab's tooltip and in ⚙ → Add-ons
	width: 320,               // starting width; minWidth / maxWidth limit dragging (default 220 / 70% of the window)
	height: undefined,        // dock 23: a window of this height that the body fills (resizable; minHeight / maxHeight)
	alignStart: false,        // true: open level with the start of the rail rather than beside its tab
	onClick: undefined,       // tab runs this instead of opening a panel (Little Black Book before dock 23)
	onToggle: (open) => {},   // the panel was opened or closed
});
panel.body                  // element to render the panel's content into
panel.actions               // element in the panel header for the add-on's own buttons
panel.setSummary(text)  panel.setBadge(textOrNumber|null)  panel.setDot("on"|"wait"|"bad"|"")
panel.setTitle(text)    panel.setVisible(bool)
panel.open()  panel.close()  panel.toggle()  panel.isOpen()
panel.remove()              // on the add-on's unload
BCDock.reset()              // rail back to the left edge at the default spot, default widths
BCDock.theme()              // the current palette: { "--bcd-accent": "#c9a8ff", ... }
```

**Theme colors** are CSS variables on the page root, for add-ons to use with a fallback, e.g.
`background:var(--bcd-ctl,#2a2633)`: `--bcd-bg` (an `r g b` triplet, use as `rgb(var(--bcd-bg) / a)`),
`--bcd-tab`, `--bcd-tab-act`, `--bcd-line`, `--bcd-line-soft`, `--bcd-hi`, `--bcd-accent`, `--bcd-glow`,
`--bcd-ctl`, `--bcd-ctl-line`, `--bcd-ctl-hover`, `--bcd-text`, `--bcd-muted`. A `bcdock:theme` event
fires on `window` when they change (Vibe Link redraws its charts on it).

Handles look the dock up by id on every call, so they keep working after a newer dock takes over.

The dock styles buttons, inputs and selects inside its panels (`#bcd-fly button` …) in one look; add-ons
style only their own content, scoped to their body.

## In each add-on

- **Little Black Book** – the 📓 tab (unread count as its badge) opens its window, which follows the
  dock's opacity. The "show in the dock" setting hides the tab.
- **Quick Actions** – the ⚡ panel: summary = "→ target", A−/A+ in the header. Chat rooms only.
- **Vibe Link** – the 〰 panel: status dot on the tab, 🛑/▶ in the header, and two views: **Toys**
  (connection, toys, quick preset load) and **⚙ Settings** (Intiface, presets, strengths, ramps,
  safety).

One panel is open at a time, so Vibe Link's 🛑 is only in its panel header; its stop hotkey
(Ctrl+Space by default) works whatever is open.
