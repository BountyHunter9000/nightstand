# Nightstand

*Formerly **BC Toolkit**: renamed because other add-ons already use that name and its BCT abbreviation.*

Small, consent-first add-ons for [Bondage Club](https://www.bondageprojects.com/), sharing one dock
on the edge of the screen. Install them all with **one script**, Nightstand, and turn off any you don't want in
the dock.

**[Install Nightstand](https://github.com/BountyHunter9000/nightstand/raw/main/nightstand.user.js)** (all add-ons,
one script; see [Installing](#installing))

| Add-on | What it does |
|---|---|
| 📓 [Little Black Book](bc-little-black-book/README.md) | Profiles of people you meet (even when they're offline), beep and whisper chats, room logs, saved outfits, online alerts. `/book` |
| ⚡ [Quick Actions](bc-quick-actions/README.md) | Favourite and recent activities one click away, on yourself or anyone in the room |
| 〰 [Vibe Link](bc-vibe-link/README.md) | Real toys follow the vibrators your character wears, through Intiface Central, with smooth ramps, patterns and remote control |
| ✨ [Afterglow](bc-afterglow/README.md) | Counts your orgasms, ruined orgasms, resists, denials and edges, the time since your last orgasm, and your records; share them with people your game permissions allow. `/afterglow` |
| 🔔 [Quiet](bc-quiet/README.md) | Mute or unmute every game notification in one tab with a click on the dock; it stays muted until you turn it back on. `/quiet` |
| 🎚 [Held Remote](bc-held-remote/README.md) | A Vibe Remote someone else left in your hand works on your own vibrators while your arms are tied, still within your owner's and BCX's remote rules. Off until you switch it on. `/heldremote` |
| 🔧 [Game Fixes](bc-vibe-fix/README.md) | Stopgaps for bugs in R134 itself: vibrators that never turn down (Off and lower levels, and Escalate starting over, work again), and picked locks that stay locked. No settings. |

The [dock](bc-dock/README.md) comes with Nightstand: a rail of tabs with
themes, opacity and position settings (its ⚙ tab). It also puts the character's name in the browser tab
("Sky · Bondage Club"), so your game tabs are easy to tell apart.

## Installing

1. Install [Tampermonkey](https://www.tampermonkey.net/) in Chrome or Edge.
2. Install **[Nightstand](https://github.com/BountyHunter9000/nightstand/raw/main/nightstand.user.js)** and confirm
   in Tampermonkey.
3. Reload the game. Every add-on starts at its latest release; switch off the ones you don't want in the dock's
   ⚙ → **Add-ons**.

Each add-on has a menu: **Off**, **Latest** (moves to new releases each time the game loads), or a fixed version
to stay on. Changes apply right away, without reloading the game. Your choices are kept in this browser. See
[the dock's README](bc-dock/README.md#one-script-for-all-add-ons) for more. The same menus are in the game's
**Preferences → Extensions → Nightstand**.

**Already have the BC Toolkit script?** It keeps working and updating, and runs the same dock and add-ons, so you don’t have to do anything. To switch, install Nightstand, then delete BC Toolkit in Tampermonkey (running both is harmless but pointless). Your settings carry over.

**Helping test new versions?** Install **[Nightstand (beta)](https://github.com/BountyHunter9000/nightstand/raw/main/nightstand-beta.user.js)**
instead of Nightstand (not both). Every add-on then runs its newest test version where there is one, and its release
otherwise. Or keep Nightstand and switch on **Show test versions** in ⚙ to try just one add-on's test version.
[More about test versions](bc-dock/README.md#test-versions).

### Without Tampermonkey

On a phone, or if you'd rather not install a script manager, load Nightstand straight into the game page. It does
the same as the script, but only for that page load, so you repeat it after each reload.

- **Console:** on the game page press F12, open **Console**, paste this and press Enter. (The first time, Chrome and
  Firefox refuse the paste and ask you to type `allow pasting` first.)

  ```js
  document.head.appendChild(Object.assign(document.createElement('script'),{src:'https://cdn.jsdelivr.net/gh/BountyHunter9000/nightstand@main/loader.js?'+Date.now()}))
  ```

- **Bookmark:** make a bookmark whose address is the line below, and click it on the game page:

  ```
  javascript:(()=>{var s=document.createElement('script');s.src='https://cdn.jsdelivr.net/gh/BountyHunter9000/nightstand@main/loader.js?'+Date.now();document.head.appendChild(s);})()
  ```

Don't use these while the Tampermonkey script is installed; if you do, nothing loads twice.

**Had the older one-script-per-add-on installs?** Those scripts are retired and no longer update. Delete them in
Tampermonkey (Dashboard: Little Black Book, Quick Actions, Vibe Link, Afterglow, Quiet, Held Remote, Vibe Fix) and
keep only Nightstand. Your settings and saved data stay: they belong to the add-ons, not the scripts. Until you
do, Nightstand leaves each of those add-ons to its old script, and its menu says so.

The add-ons work with the usual add-ons (WCE, BCX, LSCG, ...) and use
[ModSDK](https://github.com/Jomshir98/bondage-club-mod-sdk) hooks only, never overwriting game
functions.

## Good to know

- **Consent.** Copying someone's outfit or restraints, and controlling someone's toy, only work with
  their OK, checked the way the game checks it (their permissions, their wardrobe setting, a
  request they accept).
- **Your data stays with you.** Little Black Book keeps what it saves (profiles, chats, room logs)
  in your own browser. A few settings can follow your account through the game's add-on storage,
  which other players can't see. Nothing goes to any other server.
- **Toys.** Vibe Link only talks to Intiface Central on your own computer. Your max strength
  applies to everything, the stop button and your safe word always work, and toys stop when the
  page closes.

## Development

The add-ons are plain JavaScript files with no build step. For working on them locally, use a
loader that `@require`s the files from disk instead of from a release:

```js
// @require      file:///C:/path/to/nightstand/bc-dock/bc-dock.js
// @require      file:///C:/path/to/nightstand/bc-quick-actions/quick-actions.js
```

(In `chrome://extensions` → Tampermonkey → Details, turn on **Allow access to file URLs**.) Add
`window.BCDockDev = { reload: true };` at the end of the loader to get the dock's developer tools:
`/reload` picks up edited files without reloading the game. See the [dock's README](bc-dock/README.md#reloading-the-add-ons-without-reloading-the-game).

### Checks

The add-ons are held to Bondage Club's own standard for its scripts: its ESLint config and its strict TypeScript
check (`checkJs` + `strict`, types written as JSDoc). With a checkout of the game's repository:

```sh
node tools/check.mjs --game path/to/Bondage-College/BondageClub
```

It places the add-ons among the game's scripts in a temporary folder, installs the game's npm packages there once,
and runs both checks; nothing in either checkout changes. Shared types (the dock's API, what each add-on puts on
`window`) are in [`types/bc-toolkit.d.ts`](types/bc-toolkit.d.ts), used only by the check.

### Releasing

Each add-on is released on its own, with a tag: `book-vX.Y.Z`, `qa-vX.Y.Z`, `vl-vX.Y.Z`, `ag-vX.Y.Z`,
`qt-vX.Y.Z`, `hr-vX.Y.Z`, `vf-vX.Y.Z`.

1. Bump the version in the add-on's `MOD_INFO` and update its README. `node tools/check.mjs` should pass.
2. Commit, then tag that commit (`git tag qa-v0.5.2`).
3. Run `node tools/toolkit-list.mjs` to add the new version to `toolkit.json` (the list Nightstand's menus are
   filled from), and commit that.
4. Push the commits and the tag.

Nightstand loads each add-on from its tag through jsDelivr, so a release never changes under anyone.
Everyone on **Latest** gets it the next time the game loads.

**Test versions** go through the same steps with a pre-release version and tag, e.g. `MOD_INFO.version`
`"0.9.0-beta.1"` and tag `ag-v0.9.0-beta.1`. `node tools/toolkit-list.mjs` puts it in the add-on's `beta` list,
which only people with test versions switched on see; Latest is unaffected. When the change is ready, release it as
`0.9.0` as usual, and testers on Beta move to it. A test version of the dock: tag `tk-vX.Y.Z-beta.N`, point
`nightstand-beta.user.js` at it, and run the list script (it becomes `dockBeta`, which `loader-beta.js` loads);
`nightstand.user.js` and `loader.js` stay on the release.

A new add-on also needs an entry in `toolkit.json` (id, name, icon, file path, the name of its `window` object, tag
prefix). A change to the dock is released with Nightstand itself: bump `@version` and the `@require` tag in
`nightstand.user.js` and `nightstand-beta.user.js`, and tag that commit `tk-vX.Y.Z`. Then run
`node tools/toolkit-list.mjs`, which records the new dock in `toolkit.json` (`dock`, and `dockBeta` for test
versions), and commit that: `loader.js` and `loader-beta.js` read it from there, so the console, bookmark and
FUSAM installs get the new dock within minutes, without `loader.js` changing. Tampermonkey sees the new `@version` on `main` and
offers the update.

### Renaming the repository

The dock (from version 21) and `loader.js` build every address from the repository name in `toolkit.json` (`repo`),
so a rename needs no reinstall: rename it on GitHub, then in one commit set the new name in `tools/toolkit-list.mjs`
(`list.repo`), in `REPO` / `TK_REPO` (loaders and dock) and in the scripts’ `@require`, `@updateURL` and `@downloadURL`, and
run `node tools/toolkit-list.mjs`. Running docks read the list through the old address (GitHub redirects it), remember
the new name and load from it; Tampermonkey follows the redirect to the updated scripts. Only names under
`BountyHunter9000` are accepted.

The repository was called `bc-toolkit` until Nightstand 1.3.4. GitHub sends the old name's addresses here, which older
docks and scripts rely on, so no repository named `bc-toolkit` should ever be created under this account again.

## License

[GNU GPL v3.0 or later](LICENSE). You're free to use, change and share the add-ons; if you release a
changed version, release its source under the same license.
