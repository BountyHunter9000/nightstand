# Game Fixes

*Part of [Nightstand](../README.md). Called Vibe Fix up to 0.1.1; the folder, `window.VibeFix` and the `vf-v` tags
keep that name.*

Stopgaps for bugs in Bondage Club **R134** itself. Each fix is a small ModSDK hook that lets the game's own code do
the work, and does nothing once the game is fixed, so you can keep it installed. It has no button or settings.

| Bug in R134 | What you see | With Game Fixes |
|---|---|---|
| [Vibrators only go up](#vibrators-only-go-up) | Off or a lower level keeps the vibrator at the highest level it reached | The level you pick |
| [Picked locks stay locked](#picked-locks-stay-locked) | You win the lock-picking game, but the lock stays and nothing is said | The lock opens, as it should |

## Vibrators only go up

Picking **Off**, or a lower level, changes the mode's name, but the vibrator keeps running at the highest level it
reached, so arousal keeps building (and Vibe Link keeps your toy going at that level). **Escalate** gets stuck at
Maximum the same way, instead of starting over from Low.

| You pick | R134 shows | R134 actually runs at | With Game Fixes |
|---|---|---|---|
| Low | Low | Low | Low |
| Off | Off | **Low** | Off |
| Medium, then Off | Off | **Medium** | Off |
| High, then Low | Low | **High** | Low |
| Escalate from Maximum | Escalate | **Maximum, forever** | Low, then up again |

**Why:** vibrators keep a default intensity (off) in their item data. When a vibrator's mode changes, R134 leaves
the old intensity out of what it removes, because it's one of those defaults (`ExtendedItemSetOption`), then merges
the old and new intensity by keeping the larger one (the Intensity property's merge rule). So the old, higher value
always wins. Found by reproducing it in R134 with no add-ons loaded.

**The fix:** a hook on `ExtendedItemSetProperty`. When a change sets a vibrator's intensity, the item has a different
one, and the game has left the old one out of what it removes, the old intensity is cleared first, so the new one
replaces it. Everything else is left to the game, which also sends the change to the room as usual. It fixes changes
you make (to your own vibrators or other people's); a vibrator that's already stuck is fixed the next time its mode is
picked. Vibrators changed by someone without the fix still behave as R134 does.

## Picked locks stay locked

You pick a lock (**Pick lock** in an item's menu) and win the minigame, but the lock stays on, there's no "picked
the lock" message, and your lock-picking skill doesn't go up. It happens with every lock, on yourself or others.
Removing or struggling out of an item isn't affected.

**Why:** the Pick lock button starts the minigame without setting `DialogStruggleAction` (the game's note of which
struggle action is under way). When the minigame ends, `DialogStruggleStop` returns on its first line if that note is
empty, before it gets to the unlock. Confirmed in the R134 `Dialog.js` the game serves.

**The fix:** a hook on `DialogStruggleStop`. When a lock pick ends (won or lost, not interrupted) and the note is empty,
it fills it in for that call and clears it right after, so the game's own code runs: it unlocks the item, posts the
usual message, adds the skill and goes back to the item list. Any other struggle, and a game that sets the note
itself, are left alone.

## Rules and privacy

Nothing is sent anywhere by the add-on itself, and no game function is replaced: both fixes are ModSDK hooks.

## Console

`VibeFix.fixed()`: how many vibrator intensity changes it has put right since the page loaded.
`VibeFix.picked()`: how many successful lock picks it has let through to the unlock.

## Install

1. Install [Tampermonkey](https://www.tampermonkey.net/) in Chrome or Edge.
2. Install **[Nightstand](https://github.com/BountyHunter9000/nightstand/raw/main/nightstand.user.js)**, the one script for all the add-ons, and
   confirm in Tampermonkey.
3. Reload the game. Game Fixes runs at its latest release; the dock's ⚙ → **Add-ons** turns it off or picks an
   earlier version (see [One script for all add-ons](../bc-dock/README.md#one-script-for-all-add-ons)).

New releases arrive by themselves while the menu is on Latest.
