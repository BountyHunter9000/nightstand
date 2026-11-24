# Held Remote

*Part of [Nightstand](../README.md).*

The game won't let you use a vibrator remote while your arms are tied, even with the **Vibe Remote** in your
hand: it only checks whether something you wear blocks your hands. With Held Remote switched on, a remote
**someone else left you with** works on your own vibrators while you're tied.

It's off until you switch it on: click **🎚** on the shared dock's rail ([BC Dock](../bc-dock/README.md)) or type
`/heldremote on`.

## When it works

All of these:

- **Someone else left you with the remote:** they put the Vibe Remote in your hand, or they tied your arms while
  you were holding it. Picking it up yourself, or tying yourself while holding it, doesn't count.
- **Or it was in your hand when you came back:** if you log in, reconnect or reload while you're tied with the
  remote in your hand, it counts. Held Remote can't have seen how it got there, and you couldn't have put it
  there yourself while tied.
- **It's still in your hand.** Once the remote has been out of your hand for a few seconds, it's over until someone
  gives it back. A disconnect or reload doesn't end it.
- **Your hand can hold it.** Armbinders, straitjackets, mitts and anything else that blocks the hand slot rule it
  out; ropes, cuffs and the like don't.
- **It's your own vibrator.** Shock items never count, nor do other people's items.

Then the vibrator's **Remote** button works as if your hands were free, and everything after that is the game's
usual check, unchanged. These still refuse:

- your owner's rules on remotes (on yourself, or at all);
- vibrators that block remotes, and lover-only items you can't use;
- not owning a remote;
- BCX's **Forbid using remotes on self** rule, which works on the Remote button itself.

What you change shows in the room as usual. Some items that combine a vibrator with other settings (a chastity
belt with a vibrating module) open their whole settings screen through the remote, as they do in the game.

The dock tab's tooltip says whether the remote is usable right now, and who left you with it. Its dot is green
when it is, yellow when it's on but not usable.

## /heldremote

`/heldremote on`, `/heldremote off`, and `/heldremote` on its own to see the state.

## How it works

- One ModSDK hook on the game's remote check (`DialogCanUseRemoteState`). When the game answers "your hands are
  blocked" and the conditions above hold, it runs the game's remaining checks instead. Every other answer is passed
  on unchanged. No game function is replaced.
- Who changed your items comes with the game's own item updates (`ChatRoomSyncItem`, `ChatRoomSyncSingle`), which
  say who made the change. Held Remote only watches them.
- Whether it's on, and who left you with the remote, are kept per character in this browser (`localStorage`,
  `HeldRemote.<member number>`), so they survive a reload.
- Nothing is sent anywhere by the add-on itself. Changing your vibrator sends the game's usual update.

## Console

`HeldRemote.isOn()`, `HeldRemote.usable()`, `HeldRemote.grant()`, `HeldRemote.status()`.

## Install

1. Install [Tampermonkey](https://www.tampermonkey.net/) in Chrome or Edge.
2. Install **[Nightstand](https://github.com/BountyHunter9000/nightstand/raw/main/nightstand.user.js)**, the one script for all the add-ons, and
   confirm in Tampermonkey.
3. Reload the game. Held Remote runs at its latest release; the dock's ⚙ → **Add-ons** turns it off or picks an
   earlier version (see [One script for all add-ons](../bc-dock/README.md#one-script-for-all-add-ons)).

Held Remote starts switched off: switch it on with **🎚** or `/heldremote on`.

New releases arrive by themselves while the menu is on Latest. To work on the code itself, see
[Development](../README.md#development).
