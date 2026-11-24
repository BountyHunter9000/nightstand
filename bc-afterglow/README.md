# Afterglow

*Part of [Nightstand](../README.md).*

A small Bondage Club add-on that keeps count of your orgasms and what stood in their way: the time since
your last one, your records, and how often you were denied, ruined or held back in between. You can
share it with people the game's permissions allow. Open it from
the **✨** tab on the shared dock's rail ([BC Dock](../bc-dock/README.md)) or with `/afterglow`. The
tab's summary shows the time since your last orgasm, or whichever clock you pick.

## What it shows

The panel has three tabs: **Stats** (everything below), **Shared** (what people in the room share with
you, see [Sharing](#sharing)) and **⚙** (settings, in sections that fold away: Sharing, Clocks,
Chastity belt, From before Afterglow, What counts as what, Reset).

- **The time since your last orgasm**: the big clock, with when it was.
- **Three small boxes** below it: ⛔ denied, 💔 ruined and ✊ resisted. Each counts how many since your
  last orgasm, with the record for one stretch ("rec 7").
  - The ⛔ box covers edging too: under the denials it shows 🫠, how many times you've been edged.
  - While a denial item is on you, ⛔ turns into a timer: **Held** for how long it's been on, with the
    count underneath. With an edging item it's 🫠 **Edged** instead. 💔 does the same while a ruin item
    is on you. They go back to counts when the item comes off.
  - Under such a timer, a second line shows the other ways of counting it when they differ by more than a
    minute: **39m online** (or **1h 11m in all** when **⚙ → Clocks** counts only time online), and for edging,
    **35m edging**, how long you were actually edged since it went on (the time the 🫠 Time edged table adds up).
    People you share with see the same figures.
  - Under the boxes, a line names the items doing it, for example "⛔ Polished Chastity Belt (Pelvis) ·
    🫠 Vibrating Egg (Vulva, Edge mode)". For a full look at every vibrator, see Vibe Link's
    [Inspect](../bc-vibe-link/README.md#inspect) tab.
  - ✊ is always a count. Under it, 😵 is how many times (all time) you tried to resist and came anyway.
- Click the big clock or a box to show it on the dock tab's summary (it gets a highlighted border, 📌).
  The time since your last orgasm is the default.
- **🏆 Longest without**: your record stretch between two orgasms, with its dates. While the current
  stretch is longer, it says you've passed your record.
- **Counts** of orgasms, ruined, resisted, failed resists, denied and edged for this session, today and all
  time.
- **🫠 Time edged**: how long you've had an edging item on while online, for this session, today and all
  time, to the second, including while the game tab is in the background (Afterglow keeps time with a
  background worker, which the browser doesn't slow down). The all-time total can be reset on its own
  (**⚙ → Clocks → Reset time edged**).
  - This can be less than the 🫠 **Edged** timer in the box, which runs from when the item went on, including
    time you were away (unless **⚙ → Clocks** counts only time online). The box's second line shows both.
- **The game's own count**: the lifetime orgasm count for your character, the number under its arousal
  meter when you zoom in on it. The game saves that number only when you leave its Preferences screen
  and with arousal updates in chat rooms, so it can lag behind or read 0; Afterglow's own counts don't
  depend on it.
- **🔒 Belt**: while you wear the game's Modular Chastity Belt, its own figures (see
  [Chastity belt](#chastity-belt)).
- **Recent**: the latest events with their time and room, and ⏸ stretches you were away.
- `/afterglow stats` writes a one-line summary into your chat that only you see.

## What counts as what

Afterglow watches the game's own orgasm functions:

| | When |
|---|---|
| 💦 **Orgasm** | you orgasm (you didn't resist, or the resist timed out) |
| 💔 **Ruined** | an orgasm is ruined (a ruin effect, e.g. some belts and vibrators) |
| ✊ **Resisted** | you win the game's resist mini-game |
| 😵 **Resist failed** | you start the resist mini-game but its time runs out and you orgasm (also counted as an orgasm) |
| ⛔ **Denied** | full arousal is held at the edge (99%) by a denial effect instead of an orgasm |
| 🫠 **Edged** | full arousal is held at the edge (95%) by an edging effect: an item that edges, or a crafted item with the Edging property |

The game keeps asking while you're held at the edge, so one spell there counts once: it counts
again after a minute without being stopped, or once your arousal has dropped below 90% and come back.
Nothing counts if your arousal is turned off in the game's settings.

Before 0.4.0, edges were counted as denials. In Recent and Today they now show as edged, but the
all-time denied total from before then still includes them.

A **session** is your current stretch of play. It carries on through reloads, disconnects and breaks
shorter than 30 minutes; after a longer break (logged out, game closed, computer asleep) the next one
starts fresh. Time edged counts only while you're online and connected.

Afterglow only counts what happens while it's running, so the first stretch starts when you install it
and shows as **≥** (at least that long) until your first orgasm after that.

## Time away

While you're logged in and connected, Afterglow notes "still here" every minute (and every 10 minutes
with your account, for your other computers). When you come back after more than 2 minutes, logged
out, the game closed, disconnected or the computer asleep, that gap is **time away**, accurate to
about a minute. It's listed in Recent as ⏸ Away 2d 3h.

- The clocks show both kinds of time: under the big one, "1d 4h online" (or "3d 0h in all").
- **⚙ → Clocks → Clocks count** chooses which the clocks and the 🏆 record use: **all time** (the default)
  or **only time online**. Records are kept for both, so switching shows the matching one.
- Time away is tracked from version 0.1.0 on; time away before that, or on a computer without
  Afterglow, can't be known (another computer without it counts as away).

**⚙ → From before Afterglow** fills in what it couldn't see (the game keeps no history of its own):
earlier totals of each kind, added to the All column; when your last orgasm was, which starts the
current stretch there; and your longest stretch without one so far, kept as the record (marked
"entered by hand") until Afterglow sees a longer one.

## Chastity belt

The game's **Modular Chastity Belt** (and the **Techno Chastity Cage**, which works the same way) keeps
its own record while you wear it: the time of your last
orgasm, how many orgasms, and its "deny count" (how many orgasm prompts since your last orgasm didn't end
in one, so resisted or ruined; denial and edging items don't show up there). Afterglow shows these as
**🔒 Belt: 💦 4 · held back 2 · last orgasm 1d 3h ago** and cross-checks the time. The belt starts its
"last orgasm" at the moment it's put on, so until it sees one it shows *none since it went on 2h ago*
and nothing is offered.

- If the belt saw an orgasm **after** Afterglow's last one (on another computer without Afterglow, or
  before it loaded), Afterglow offers: *"Your belt saw an orgasm … that Afterglow didn't. Count it?"*
  **Count it** ends the stretch then (a record if it was the longest), counts the orgasm and lists it in
  Recent as "seen by your belt". **No** leaves it.
- If Afterglow hasn't seen an orgasm yet (the clock shows **≥**) and the belt's is from before Afterglow
  started, it offers to start the clock from then, so it's exact.

**⚙ → Chastity belt**: **Belt saw one I didn't**: *ask me* (the default), *count it* (without asking),
or *ignore*; and whether to show the belt's figures.

## Sharing

You can let people in the room see your stats, using the permissions the game already has. They need
Afterglow too.

**⚙ → Sharing**: tick **Share my stats** (it's off until you do), then choose who sees each part:

| Part | What |
|---|---|
| Clocks and counts | the time since your last orgasm, this stretch's denied/edged/ruined/resisted, and the session, today and all-time counts |
| Records, time edged | your longest stretch without, and time edged (session and all time) |
| Held now, which items | whether a denial, edging or ruin item is on you right now, for how long, and which items |

Each part can be **Same as my item permissions** (whoever the game lets use items on you, following
your setting in the game's Preferences), one of the game's own levels (everyone in the room; everyone
except blacklist; owner, lovers, whitelist and dominants; owner, lovers and whitelist; owner and lovers;
owner only), or **Nobody**. The default is the same as your item permissions for the first two and owner
and lovers for the third. Your blacklist and ghost list never see anything, at any level. The panel
lists who in the room can see some of it.

**Seeing what others share**: just open Afterglow in a room. It asks everyone there whether they share
with you, and the **Shared** tab (it shows how many, e.g. "Shared (2)") has a card for each person who does, with their clocks running
live. Nothing to request by hand. While it's open it asks again every 30 seconds (every 10 minutes for
people who don't share), and news (an orgasm, a denial, an item going on) arrives straight away.
**Show what others share with me** turns the asking off.

How it works:

- Every message is a hidden message sent to **one person only**, never to the whole room. Only
  Afterglow reads them. The ask carries no stats; the answer goes only to the person who asked.
- Permissions are checked every time, against the live relationship. When someone loses access (you
  stop sharing, change a level, or the game's permission changes), their card clears right away.
- People without Afterglow ignore the ask. The ask does tell its recipient that you use Afterglow.
- Sharing only works in the same room: hidden messages don't leave it.

## Rules and privacy

- It only watches: ModSDK hooks that let the game run first and change nothing. No game function is
  replaced.
- It never sends anything to the room. It only sends hidden messages to one person at a time, for
  [Sharing](#sharing): asking people in the room when you open Afterglow (which you can turn off), and
  answering people your sharing settings allow (off until you turn it on). `/afterglow stats` is a
  local line only you see.
- Counts, records and the current stretch are saved in your account's `ExtensionSettings.Afterglow`, so
  they follow you to other computers. The recent list is kept in this browser's `localStorage`
  (`Afterglow.log.<member number>`, the last 1000 events), and so is the current session
  (`Afterglow.session.<member number>`).
- **⚙ → Reset → Reset everything** starts the counts, records and recent list over from zero; your
  settings (sharing, belt, clocks) stay. It asks first.

## Console

`Afterglow.state()`, `Afterglow.session()`, `Afterglow.log()`, `Afterglow.stats()`.

## Install

1. Install [Tampermonkey](https://www.tampermonkey.net/) in Chrome or Edge.
2. Install **[Nightstand](https://github.com/BountyHunter9000/nightstand/raw/main/nightstand.user.js)**, the one script for all the add-ons, and
   confirm in Tampermonkey.
3. Reload the game. Afterglow runs at its latest release; the dock's ⚙ → **Add-ons** turns it off or picks an
   earlier version (see [One script for all add-ons](../bc-dock/README.md#one-script-for-all-add-ons)).

New releases arrive by themselves while the menu is on Latest. To work on the code itself, see
[Development](../README.md#development).
