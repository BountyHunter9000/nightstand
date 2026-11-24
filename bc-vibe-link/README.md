# Vibe Link

*Part of [Nightstand](../README.md).*

A Bondage Club add-on that makes a real toy (e.g. Lovense Hush 2) follow the vibrator your
character wears, through [Intiface Central](https://intiface.com/central/) / buttplug.io. Like
WCE's toy sync, but with smooth ramps between levels, an editable level table, faster response,
and a safety stop. See [PLAN.md](PLAN.md) for what comes next.

It only reads your own character and only drives toys on your own computer.

## Setup

1. Install and start **Intiface Central**, press **Start Server**, and pair your toy in Intiface
   (not in Windows Bluetooth settings).
2. If WCE is installed, turn off its **Enable buttplug.io** option and reload. Intiface accepts one
   app at a time. Vibe Link shows a warning while WCE's option is on.
3. Install the add-on (below) and log in. Vibe Link connects on its own; click the **〰** tab on the
   shared dock's rail ([BC Dock](../bc-dock/README.md)) to open it.
4. A toy follows nothing until you link it: the panel opens when a toy connects so you can pick
   the slot it follows (Hush 2 → Butt), or load a preset. **Test** buzzes it briefly.

### Trying it without a toy

**Try a virtual toy** on the Toys tab (or ⚙ → Connection → **Virtual toy**) adds a pretend toy that needs no
Intiface. Link it to a slot like a real one and watch its chart and percentage follow your vibrator, the game modes,
presets and **Play on my toys**. Nothing is sent anywhere, and people you let control your toys aren't shown it, so
only you can drive it. It stays alongside real toys until you remove it, and the switch is per browser.

## From the chat room

The 〰 tab is on the dock's rail on every screen, the chat room included; its dot is green with a toy
connected, yellow while waiting and red when stopped or Intiface can't be reached. The panel has two
views: **Toys** (connection, each toy's slot, Test, live strength, and loading a preset) and
**⚙ Settings** (Intiface address, remembering links, managing presets, strengths, ramps, safety).
Its header shows each toy's strength and 🛑. Or use `/vibe`:

| Command | Does |
|---|---|
| `/vibe` | opens the panel |
| `/vibe status` | toys, battery, what each follows and its strength |
| `/vibe scan` | connects to Intiface if needed and looks for toys for 30 seconds |
| `/vibe link butt` | links the toy to a slot (`/vibe link hush butt` when several toys are connected) |
| `/vibe unlink` | the toy stops following anything |
| `/vibe preset` / `/vibe preset night` | lists presets / loads one (the start of the name is enough) |
| `/vibe save night` | saves the current setup as a preset (same name = update) |
| `/vibe stop` / `/vibe resume` | same as 🛑 / ▶ |
| `/vibe here` | moves Intiface to this game tab (see below) |

## Bluetooth scanning

Vibe Link never scans on its own. Connecting only asks Intiface which toys it already has (pair the
toy in Intiface Central once and it shows up). **Look for toys** in the panel, or `/vibe scan`, runs
one Bluetooth scan that stops as soon as a toy turns up, or after 30 seconds. Intiface Central can
also scan by itself if its own settings say so; that's separate from Vibe Link.

## Several game tabs

Intiface accepts one connection at a time, and every game tab (one per account) runs Vibe Link. So
one tab connects and the others wait, showing **In use by Robin's tab** with a yellow dot:

- **Use here** (or `/vibe here`) moves Intiface to this tab; the other tab lets go and waits.
- When the connected tab closes, logs out or disconnects, a waiting tab takes over by itself.
- WCE's own toy sync counts as a connection too, so keep its buttplug.io option off.
- The browser tab's title shows **〰** in front of the character's name in the tab that's connected (with the
  dock's character name in the tab, see [BC Dock](../bc-dock/README.md#browser-tab-title)), so you can see which
  tab has Intiface from the tab bar.

## What it does

- **Levels**: the game's five vibrator levels map to a toy strength. Default 0 / 10 / 40 / 75 /
  100 %, editable.
- **Ramping**: changes slide to the new strength over the **Up** / **Down** times (default 1.5 s
  / 0.8 s), with a smooth or linear curve. 0 s jumps straight there.
- **Game modes** (Random, Escalate, Tease, Deny, Edge) each play a pattern on your toy, set under
  ⚙ → **Game vibrator modes**: a shape, low-high strength and speed per mode (defaults: Random →
  Random 10-80%, Escalate → Climb 5-100% over 30 s, Tease → Tease 0-80%, Deny → Climb 20-90%,
  Edge → Wave 55-95%). **Game steps** instead follows the level changes the game makes in that mode.
  **Follow the game's levels in modes** (off by default) does that for every mode at once. It's very
  steppy: the game only jumps between Low, Medium, High and Max, so nothing curves like the patterns.
- Checked every 50 ms. Commands go out at most 10 times a second per toy, and only when the
  strength actually changes.
- **Toys with several vibration motors** list each motor as its own toy ("Sim 2 Vibe · 1", "· 2"),
  so each can follow its own slot, play its own pattern or be picked separately by a controller. Link
  both to the same slot to move them together. Links made before 0.9.8 carry over to motor 1.
- **⚙ → Toys** shows every connected toy with a Show box. Toys without a vibration motor Vibe Link can
  drive (strokers, rotators) start hidden; hide any you don't use. Hidden toys aren't driven, listed
  or offered to controllers.
- Several toys can be linked, each to its own slot. The **Follows** list shows what you're wearing:
  slots with a vibrator on come first (〰 Butt: Vibrating Butt Plug), then slots with something that
  doesn't vibrate, then empty ones. It updates as items go on and off.
- Each toy's card charts its real strength over the last 15 seconds (newest on the right, faint
  lines at 25/50/75%), so patterns, modes and ramps show as a waveform rather than just a level.
  The chart runs 0-100% with a dashed line at your **max strength** (when it's below 100%);
  **Scale charts to max** (next to Max strength in ⚙) makes 0 to your max fill the chart instead.

## Settings (⚙)

The ⚙ page is split into sections that fold open and closed (remembered per browser): **Connection**
(Intiface address, connect, look for toys, remember links, **Vibe Link messages in my chat**), **Toys** (which toys show on the Toys
tab), **Safety** (max strength, chart scaling,
stop hotkey, pause in background, the game-rules switch), **Game Modes** (strength per game level and
what each vibrator mode plays), **Ramp Config** (up/down times and curve) and **Presets**. Only
Connection starts open.

**Vibe Link messages in my chat** (⚙ → Connection, on by default): off keeps Vibe Link's 〰 lines
out of your chat. That covers `/vibe` replies, which pop up instead, and "Only me" announcements. It
also hides Vibe Link announcements other players post with *Everyone in the room*, from 0.10.1 on,
which tag them. It uses the game's own chat-filter list, so it only affects your view. The game's own
messages, such as vibrator level and mode lines, stay.

## Links and presets

- Toys start each session following nothing, so nothing buzzes until you choose. **Remember links
  between sessions** (under Toys) keeps them instead.
- A **preset** saves which slot each toy follows plus the level table, ramp times, curve and max
  strength. Save, load, update or delete them in the panel's **Presets** section, or with
  `/vibe save` / `/vibe preset`. Up to 20, saved with your account.
- Loading a preset also keeps links for toys that aren't connected yet; they apply when the toy
  connects.

## Safety

- **🛑** in the panel header, or **Ctrl+Space** (changeable, works with the panel closed), stops every toy at once. Toys stay
  off until you press **▶ Resume** (or the hotkey again), even after a reload.
- **Max strength** caps everything: every level is scaled to it.
- Toys stop when the page closes, you log out, or Intiface disconnects. Optionally they also
  pause while the game tab is in the background.

## Remote control (who may control your toy)

The **Remote** tab in the panel lets other players who also run Vibe Link control your toy, and lets
you control theirs: who may control you, live strength control and patterns.

**Giving control** (Remote → Who can control you):
- **Let others ask for control** is off until you turn it on. Off, every request is declined.
- **Requests**: *Ask me* shows a prompt with **Allow** (until one of you leaves the room), **15 min**, **30 min**, **45 min**, **1 h**,
  **Always** or **Decline**; unanswered requests are declined after 60 s. *Only my Always list*
  declines everyone else without asking.
- **Owner and lovers don't need to ask** (off by default).
- **Give**: hand someone in the room control without them asking, while here or for 15/30/45/60 min.
- Only people the game lets use items on you can ask at all.

**Taking it back**:
- **Controlling you now** lists everyone with control and their time left, with **Revoke** and
  **Block** (revoke and always refuse them). The Always and Blocked lists can be edited there too.
- Control ends by itself when its time runs out (toys back to the game). If either of you leaves the
  room, their control ends but your toys keep their last setting until you stop it (see Heartbeat).
- **🛑, the stop hotkey and your safe word** (said in chat) stop your toy, take control away from
  everyone and refuse new requests for a while (5 min by default, changeable).

**Controlling someone else** (Remote → Control someone): everyone in the room running Vibe Link is
listed with whether they accept requests. **Ask** sends a request; once they agree you get a
**strength slider** (0-100%), level buttons **Off / Low / Med / High / Max** and **Stop**, mode
buttons **Random / Escalate / Tease / Deny / Edge**, plus what their toy is really doing, and your
time left. **Give back** hands control back.

**Levels and modes are held like the game's own setting**: Off-Max plays the wearer's own strength for
that level (their level table, ramped), and a mode plays the pattern the wearer chose for it (or the
game's steps). Their worn vibrator is set to exactly that level or mode right away. Both stay until
the controller changes them. **Stop** stops the toys and hands them back to the game. Both sides need
0.9.2 for these buttons.

**Live control feel**: the controller's slider is recorded with its timing (every change) and sent in
small batches, about 10 a second. The wearer replays those points on the controller's own timeline a
short, fixed delay behind (Remote → **Smoothing**, 0.25 s by default, 0.1-0.6 s), so the curve
arrives exactly as drawn even when the game server holds messages back for a moment and then
delivers them in a bunch: a stall shorter than the smoothing delay doesn't show at all, and a longer
one gives a short pause rather than lost movement. Longer smoothing hides more; shorter reacts
faster. During live control the toy takes up to 20 commands a second (a new one only once it has
taken the last). A Lovense Hush has 20 strength steps, so very slow moves still change in 5% notches.
Controllers on 0.4.0 still work (single values, glided).

**Several toys**: if they have more than one toy, a **Toy** picker appears above the slider: **All
toys** or one toy by name. The slider and ▶ Play go to the toy you picked, so one toy can play a
pattern while another follows the slider or stays with their game; the banner lists every toy and
what it's doing. "All toys" replaces whatever each toy was doing; **Stop** stops all of them. On the
wearer's side only toys linked to a slot are controlled (or every toy if none is linked), and each
linked slot's worn vibrator follows its own toy.

**Heartbeat**: while someone controls your toy their Vibe Link says "still here" every 5 s (you send
them status every second anyway). If you hear nothing from them for 15 s (or they leave the room, or
you do), **your toys keep the last setting they gave**, as an in-game setting would: a held level,
mode, pattern or the last slider value. The banner says "Lost contact … keeping their last setting"
with **Hand back**; 🛑, the stop hotkey and the safe word stop it too, and changing the vibrator in
the game hands it back to the game. A timed pattern still ends on time. After 30 s their grant is
dropped (people on your Always list get it back when they ask again; if they come back in time, they
carry on). On the controller's side, no status from the wearer for 15 s shows **Lost
contact** and offers **Ask** again.

**On your own Toys tab**, while someone controls you, a highlighted banner says who it is, lists each
controlled toy and what it's doing (the pattern with its curve, playhead and time left, or live), and
has a **Revoke** button; each controlled toy's card shows "🎮 name: pattern".

**Patterns** (under the slider): pick a shape, **Low** and **High** strength, a **speed** (one cycle
every 0.5-20 s) and **how long** (until stopped, or 15 s to 10 min), see a preview of the curve, and
press **▶ Play**. Shapes: **Wave** (smooth up and down), **Pulse** (on/off), **Heartbeat** (double
beat), **Climb** (build up, drop), **Stairs** (four steps), **Tease** (growing ripples, then drop),
**Random** (drifts to new levels) and **Quake** (fast jolts). The pattern goes to the wearer once, as
a short description, and their Vibe Link draws the curve itself, so it's perfectly smooth whatever
the network does; Random and Quake use a shared seed so the preview matches what they feel. A timed
pattern stops by itself ("The pattern finished"); moving the slider or **Stop** takes over at any
time. The controller sees what's playing and the time left.

**While someone controls you** the panel shows 🎮 and their name, and they control your linked toys
instead of the game level. **Your worn vibrator follows along** so the room sees it: the vibrators in
your linked slots are set to the level matching the controller's average (their own 0-100%, before
your max strength: under 5% Off, 5-25% Low, 25-55% Medium, 55-85% High, above that Max). The level
changes once it has held for 2 seconds and at most every 5 seconds, is synced without a chat line,
and goes back to what it was when remote control ends. A vibrator locked by someone else is only
changed if the controller is the one who locked it, or your owner (otherwise only your toy follows).
If someone changes the vibrator in the game (e.g. with the in-game remote), the game is in control
again and the controller is told. Revoke, Block, 🛑, the stop hotkey and the safe word end remote
control at once.

**Announce changes** (Remote → Safety, off by default) writes remote control changes into the chat:
someone taking control, a pattern starting, your worn vibrator's level rising or easing (at the
mirror's pace, at most every 5 s), and your toy going back to the game. **Only me** shows them as
local lines nobody else sees. **Everyone in the room** posts them as action lines the room reads.

**Play on my toys** (Toys tab) gives you the controller's live slider, toy picker and patterns for
your own toys. It follows the game's rules: it only works for toys linked to a worn vibrator you could
change yourself in the game right now. For a vibrator that works by remote that means free hands, a
vibrator remote and no owner rule or item blocking remotes. Any other vibrator needs free hands and a
slot you can reach. Otherwise the button is greyed out with the reason. If you lose access while
playing (someone ties your hands), it stops and your toys follow the game again.
**Play on my toys ignores the game's rules** (⚙ → Safety, off by default) is the immersion switch:
on, you can play any linked toy whatever the game says. Your worn vibrator is still only changed where
the game would let you change it. Nothing is sent over the network (only the Announce lines, if you turned them on),
it works outside chat rooms too, and Stop, Close or 🛑 hand your toys back to the game.

**Strength**: whatever a controller sends is a 0-100% value that your **max strength scales**, like
the game levels (100% from them = your max). It's never just cut off at the max.

**How it talks**: hidden room messages (`Content: "VibeLink"`, the same channel other add-ons use),
sent only to the person concerned, plus a "hello" to the room when you join so others know you run
Vibe Link and whether you accept requests. Messages are data only and checked on arrival.

## Saved patterns, programs and history

Every pattern picker (controlling someone, or **Play on my toys**) also has:

- **💾** next to ▶ Play saves the pattern under a name. Saved patterns appear in a list at the top of
  the picker: **▶** plays one, **✎** loads it back into the editor to change it.
- **+ Add to program** adds the pattern as the next step of a **program**: up to 12 steps, each
  for its own *how long* (1 min if it runs until stopped). The program shows its steps (reorder
  with ↑, remove with ✕), a preview of the whole run, and **Loop** to start over until stopped.
  **▶ Play** sends the whole program at once and the wearer's Vibe Link plays it, as with patterns.
- **Remote → My patterns** lists everything you saved: play it on your own toys (▶), copy it as a
  code (📋), rename (✎) or delete it (✕). Saved patterns go with your account, like presets.

**Sharing and backups** (Remote → My patterns):

- **📋** copies a **pattern code** (`VL1:…`, compressed like the game's outfit codes) for a pattern,
  program or recording, from My patterns or the History. Anyone with Vibe Link pastes it into
  **Import** to save it. A code is checked like a pattern arriving from another player: data only,
  same limits.
- **⭳ Export all** downloads every saved pattern as `vibe-link-patterns.json`, a backup or a way to
  move them to another account. **⭱ Import file** adds the patterns from such a file (or from a text
  file of codes, one per line). If names clash, you choose: replace yours, or keep both (the imported
  ones get "(2)").

**Remote → History** keeps what happened during remote control, both ways (← done to you, → done
by you): who took control and when it ended, the patterns and programs played, levels and modes set,
and live slider sessions, which are kept as **recordings** of the curve exactly as it was drawn
(up to 10 minutes). Any pattern, program or recording there can be played again on your own toys
(▶) or saved (💾), and a saved recording can be played on someone else too. The history stays in
this browser only (the newest 300 entries, the newest 40 with their curves); **Keep a history**
turns it off and **Clear** empties it.

Programs and recordings need Vibe Link 0.11.0 or newer on the other side; for someone on an older
version they're greyed out. A recording sent to someone else is thinned to 240 points on the way.

## Inspect

The **Inspect** tab shows what's buzzing, or holding someone at the edge, right now. It works without
Intiface or a toy. Pick **You** or anyone in the room:

- Their arousal, and whether they're ⛔ denied, 🫠 edged or 💔 having orgasms ruined, or free to finish.
  For you it uses the game's own edging check: you only count as edged when every vibrator on a zone you
  can orgasm from edges, and it says so when only some do.
- Each vibrator, and each item that edges, denies or ruins:
  - its slot and name, and its crafted name if it has one;
  - its mode (Random, Escalate, Tease, Deny, Edge…; hover for what it does) and the strength it's at now;
  - 🫠 edging, ⛔ denial or 💔 ruin, and a crafted Edging, Arousing or Dull property;
  - its lock, who locked it, and when a timer lock opens.
- A Modular Chastity Belt or Techno Chastity Cage also shows its own record: orgasms while worn, how many orgasm prompts since
  the last one didn't end in one ("held back"), and how long since the last orgasm.

It updates live and only reads what the game already shows everyone. Nothing is sent.

## Rules

Bondage Club's add-on rules ask scripts not to affect other players without their consent:

- **Only your own toys, only from your own character.** Vibe Link reads the vibrators worn by you
  and drives toys connected to your own Intiface. Nobody can reach your toy directly.
- **Remote control only with your consent.** It's off until you turn it on; then each person has to
  ask (or be on your Always list), must be someone the game lets use items on you, and can be
  revoked or blocked at any time. Controller values are scaled by your max strength.
- **Quiet messages.** Remote control uses hidden room messages sent only to the person concerned
  (plus one "hello" to the room when you join); nothing shows in chat.
- **You're always in control.** 🛑 and the stop hotkey stop every toy at once, a max strength caps
  everything, and toys stop when the page closes, you log out or Intiface disconnects.
- **No background scanning.** It only looks for toys when you press Look for toys, for 30 seconds.

## Storage

Settings (levels, ramps, cap, hotkey, Intiface address, presets, saved patterns, and toy links if remembered) are
saved in the account's `ExtensionSettings.VibeLink`. The stopped state and the remote control history are kept in this
browser's `localStorage` (`VibeLink.history.<member number>`); the dock keeps its own position and which panels are
open.

## Console

`VibeLink.toys()`, `VibeLink.settings()`, `VibeLink.connect()`, `VibeLink.disconnect()`,
`VibeLink.stop()`, `VibeLink.resume()`.

## Install

1. Install [Tampermonkey](https://www.tampermonkey.net/) in Chrome or Edge.
2. Install **[Nightstand](https://github.com/BountyHunter9000/nightstand/raw/main/nightstand.user.js)**, the one script for all the add-ons, and
   confirm in Tampermonkey.
3. Reload the game. Vibe Link runs at its latest release; the dock's ⚙ → **Add-ons** turns it off or picks an
   earlier version (see [One script for all add-ons](../bc-dock/README.md#one-script-for-all-add-ons)).

New releases arrive by themselves while the menu is on Latest. To work on the code itself, see
[Development](../README.md#development).

Vibe Link also needs [Intiface Central](https://intiface.com/central/) running on the same computer (see Setup).
