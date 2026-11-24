# Quick Actions

*Part of [Nightstand](../README.md).*

A panel in Bondage Club chat rooms for doing activities (kiss, caress, wiggle, struggle, ...)
without opening the character dialog and hunting through body zones every time.

- **Target**: pick yourself or anyone in the room. It stays on them until you pick someone else in this
  menu: opening someone's dialog, people coming and going, or the room refreshing don't change it. If they step
  out, the menu shows them as "not here" and actions wait (nothing goes to you or anyone else instead) until
  they're back or you pick again.
- **Favorites**: pinned actions, one click each. `Alt+1`..`Alt+9` fire the first nine in order;
  drag a favorite onto another to reorder them (and so re-assign the hotkeys). Up to 30
  favorites each for "on myself" and "on others".
- **Recent**: the last activities you did, including ones done through the normal dialog. Click
  to repeat, ☆ to pin.
- **+ Find an action**: pick a body zone and see every activity possible on the target right now.

Buttons are greyed out when an action isn't possible at the moment (gagged, arms tied, the target
doesn't allow interaction, ...), with the reason on hover. Actions go through the game's own
`ActivityRun`, the same call the dialog makes, so messages, arousal and add-on reactions all
behave exactly as if you'd clicked through the dialog.

## The bar

- It's the **⚡** tab on the shared dock's rail ([BC Dock](../bc-dock/README.md)), with Friend
  Manager and Vibe Link. Click the tab to slide the panel out or back; the dock handles position,
  side, width and opacity.
- The header shows who you're targeting. **A− / A+** scale the text and buttons (70–160%).
- It only shows in chat rooms. It needs `bc-dock.js` (the loader requires it), not the other add-ons.

Favorites, recents and text size are saved in your account's
`ExtensionSettings.QuickActions`, so they follow you across browsers.

## Rules

Bondage Club's add-on rules ask scripts not to affect other players without their consent and not
to be usable for spam:

- **Only what the game's own dialog allows.** Each action runs the game's own activity call with the
  game's own permission checks, so it can't do anything to someone that you couldn't do by hand.
- **No spam.** The same action on the same person can't be repeated faster than the cooldown
  (1.5 s by default; ⚙ in the panel header), and holding Alt+number doesn't auto-repeat.
- **Only when you act.** Nothing runs by itself. A future auto-react would only answer things done
  to you, at most once per cooldown.

## Planned

- **Auto-react**: respond automatically when someone uses a chosen activity or item on you, with
  per-trigger cooldowns and loop protection against other auto-responders.

## Install

1. Install [Tampermonkey](https://www.tampermonkey.net/) in Chrome or Edge.
2. Install **[Nightstand](https://github.com/BountyHunter9000/nightstand/raw/main/nightstand.user.js)**, the one script for all the add-ons, and
   confirm in Tampermonkey.
3. Reload the game. Quick Actions runs at its latest release; the dock's ⚙ → **Add-ons** turns it off or picks an
   earlier version (see [One script for all add-ons](../bc-dock/README.md#one-script-for-all-add-ons)).

New releases arrive by themselves while the menu is on Latest. To work on the code itself, see
[Development](../README.md#development).
