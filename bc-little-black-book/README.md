# Little Black Book

*Part of [Nightstand](../README.md). Formerly called Friend Manager: same add-on, same data.*

A Bondage Club add-on that combines a friend/profile cache with a chat client: beep and whisper
conversations, a log of every chat room you enter, a room browser, and profiles of everyone you've
met that you can look up later, even when they're offline. It's meant to replace LianChat and can
import its history.

Open it from the **📓** tab on the shared dock's rail ([BC Dock](../bc-dock/README.md)), `/book`, or `/chat`. The window follows the dock's opacity setting (dock ⚙).
**👤 My profile** in the top bar opens your own profile, live, from any section.

Its window follows the dock's theme (dock ⚙ → Theme) and panel opacity. Colors that mean something
keep their meaning in every theme: whispers blue, room changes teal, unread badges pink.

## Sections

### Chats
- One conversation per person: beeps and whispers in both directions, with unread counts (also
  shown on the 📓 tab).
- Reply by **beep** from anywhere, or by **whisper** when they're in your room (a Whisper/Beep switch
  appears). Sending uses the game's own `ServerSendBeepMessage` / `ChatRoomSendWhisper`.
- Beep metadata (message id, colour, replies, emoji reactions) is decoded with the game's
  `FriendListBeepParseMessage`, so no raw JSON shows up.
- **Outbox**: when someone is offline, the reply box becomes **Send when online**. Queued messages
  show above the reply box (⏳, with cancel) and are beeped once they appear online: checked every
  minute while anything is queued, or immediately if they join your room. Only friends' online
  status is visible to the game, and your game has to be open for anything to be sent.
- **Pin** a chat to the top, **Hide** it until they message you again (the **Hidden** button shows
  hidden ones), **Export** it as text, or **Delete** it.
- **Invite to my room** (a beep carrying your room) and **Add friend** (same steps as the game's
  Add Friends screen).
- **Join their room** when a friend is in a public room and you're not in a room.
- 🔔 **Background notifications** for whispers (on by default) and beeps (off by default, since the
  game already pops up beeps). Clicking one opens the conversation. Set on the ⚙ Settings page.
  While [Quiet](../bc-quiet/README.md) has the tab muted, these and the online alerts don't pop up
  either (the chat line for online alerts still shows).
- Reading a chat here also clears its unread count in the game's own friend list (its Beeps tab).
- **Import LianChat** copies LianChat's beep/whisper history for the logged-in account. Safe to run
  more than once; run it once on each account.
- Type a member number and press Enter in the search box to start a conversation.

### Friends
Your friend list, online friends first, with the room each one is in and how long they've been
online ("for 25m", when Little Black Book saw them come online). Offline friends show when they were
**last online** ("offline · last online 3h ago"), from the online-friends check or the last time you
were in a room together. Little Black Book checks who's online every 5 minutes while the game is open
(every 30 seconds while its window is open), so these times are that close. The time shown in
**Chats** is the last message, not when they were last online. A profile's Overview also lists
**Last online**, **Online since** and **Went offline** (when Little Black Book noticed). Clicking
someone opens your conversation with them.

**Groups**: make your own groups (name and colour) and put people in them with the **+ Group** tag
picker in a chat or profile header (× removes). Anyone can be in several groups, including people
who aren't on your friend list. The list is split under collapsible group headers showing
online/total, with **Ungrouped** last, and a filter shows one group at a time. **Groups** in the
toolbar opens group management (rename, recolour, delete), and ✉ on a group header sends one message
to the whole group: beeped now to those online, queued in the outbox for the rest.

### Rooms
Every room you enter is logged: its settings (name, description, background, space, language,
limit, admins, private/locked, blocked categories), everyone who was there, and every chat line as
it appeared in the chat log.

- Visits to rooms with the same name show as **one growing log**, with dividers where each visit
  starts and ends: "You joined", "You left", or "Log ends here" when the page closed or the
  connection dropped. Reloading the page while in a room continues the same visit (within 15 min).
- **Renames** seen while you're in the room link the old and new names, so their logs merge; the
  latest name seen is the one shown.
- **Room changes** (description or settings edits, with who made them when the server says) are
  logged as their own line type, including "Changed since your last visit" when you rejoin.
- Names are bold and coloured per person (their label colour, or a stable colour if theirs is the
  default white); click one to open their profile.
- Filters (Chat, Emote, Whisper, Action, Activity, Room changes, System), find-in-room, and
  **Search messages** across every room log and conversation.
- Export a room's log as TXT, HTML or JSON. Delete a whole room log or a single visit.
- ☆ to favorite a room; **Join** when you're not in a room.

### Lobby
A room browser (Mixed/Female/Male/Asylum) using the game's own `ServerRoomSearch`. Rooms with
friends inside sort first; ☆ favorites are pinned to the top, with a **★ Favorites** filter, and
favorites that aren't open still show (greyed). Selecting a room shows its description, creator,
members and friends inside, with a **Join** button.

Joining follows the same path as the game's leash feature: it checks the room's space and blocked
items, opens the room search screen, then calls `ServerRoomJoin`.

### Profiles
The game has no server call to fetch another player's profile, so profiles are snapshots from the
last time you shared a room.

| Source | When | Contents |
|---|---|---|
| `ChatRoomSync*` server events | you're in a room with them | name, nickname, title, owner/lovers, description, appearance (incl. worn crafted items), public crafting list, reputation, `OnlineSharedSettings` |
| Hidden `ChatRoomMessage`s | add-ons broadcast in the room | last message per add-on message type |
| `AccountQuery OnlineFriends` | every 5 min (30 s with the window open), Refresh | which friends are online and in which room; when each was last online, came online and went offline |

Tabs: Overview, Description, Appearance (applied items and outfit, locks, crafted-by), Crafts
(properties with the game's own descriptions), Room (current room lookup and last shared room),
Shared settings, Mod messages, Raw. Private notes per person are saved automatically.

**Me** (toolbar, or your own entry) shows your own character live from the game rather than the
cache: current outfit and applied items, preview, outfit codes, all your crafts (private ones too),
and the add-ons actually loaded with their versions.

**Other people's outfits need their consent.** Copying, saving or wearing someone else's outfit
(profile Appearance tab, or an outfit saved from them) only works when they've agreed to it the way
the game asks: their wardrobe is open to others (the game's full wardrobe access setting) and, while
they're in the room with you, they allow you to interact with them. Otherwise it's view only (🔒);
profiles stay fully viewable after the fact. Settings → **Other people's outfits** switches each
check on or off (including an optional "same room only" check, off by default), or turns the
limit off entirely for people who are fine with it. Your own outfits are always copyable.

**Restraints copy too.** The Appearance tab's applied items (and saved outfits) have **Copy
restraints code**, **Copy outfit + restraints code** and **Put restraints on me**, plus a
**Put on** button per item. Codes use the game's item bundle format (Name, Group, Color,
Property), as BCX-style outfit codes with restraints do. Crafted items come over as the plain
item they were made from: same colours and chosen options, without the crafter's name,
description, property or effects. Locks never come along. Putting restraints on yourself goes
through the same checks the game's item menu makes (hands free, slot not blocked, you own the
item, your own permissions, self-bondage level, the room's rules). Nothing is posted in chat.
Something that needs another item first (an add-on on a device) gets a second try once the rest
is on. Other people's restraints follow the same consent rules as their outfits.

Saved outfits keep restraints too: a profile with restraints offers **Save outfit + restraints**
and **Save without restraints**, and **Save my current outfit** includes yours. The outfit tools
then have **Copy outfit + restraints code** next to the outfit and full-look codes.

**👤 Preview on me** (a profile's Appearance tab, and saved outfits, when you may copy the outfit) redraws the
preview as your own body (skin, hair, eyes) wearing that outfit. Only the picture changes; nothing is put on you. Click
again for the original. **Import outfit code** (above the saved outfits) puts a wardrobe code on you.

**Favorite profiles**: ☆ on anyone, friend or not; favorites sort first and the filter has a
**★ Favorites** view.

**Online alerts**: 🔕 next to the ☆ on a profile flags that person; it turns to 🔔. When a flagged
friend comes online you get a desktop notification whenever you aren't looking at the game (another
tab, another app, minimized), plus a line in your chat that only you see, saying which room they're
in. **Test desktop notification** in Settings checks that your browser and Windows let them through. Little Black Book checks who's online about once a
minute while anyone is flagged and the game is open. The game only reports mutual friends as online,
so it works for them. Switch it all off in Settings → **Notify when flagged friends come online**. The
flags sync between computers with the rest of your favorites.

**Detected add-ons** are listed in the Overview, with versions where the add-on reveals them. They
come from add-on markers in shared settings (MBS, ULTRAbc, LianChat, …) and from hidden messages
(BCX, WCE, LSCG, BCTweaks, …). Only add-ons that announce themselves in rooms can be seen; private
`ExtensionSettings` are never sent to other players. Each add-on chip links to its website or source
(hover for a description), and **About these add-ons** lists what each one does. Names and links come
from FUSAM's add-on directory, built into the script. On your own profile, which lists the add-ons loaded right
now, an add-on the directory doesn't know links to the repository it reports to ModSDK (Nightstand's add-ons
show as **Nightstand: Quiet** and so on). Anything else links to a GitHub search.

### ⚙ Settings
Per account, saved with that account's data.

- **Recording**: room chat logs (and, under it, room setting/description changes), beep and whisper
  history, profile snapshots (and keeping their items current during a visit), add-on messages.
  Turning one off stops new data being saved; what's saved stays until you clear it.
- **Storage**: keep room logs and chats forever or for 7 days to 1 year (older entries are removed at
  login and every few hours; pinned and unread chats are kept), counts of what's saved, **Clear**
  room logs / chat history / profiles, **Export everything** (one JSON file of every store), and
  **Delete everything** (settings are kept).
- **Messages**: automatic outbox delivery (off = queued messages wait for **Send now**), marking beeps
  read in the game too, desktop notifications.
- **Opening Little Black Book**: the 📓 tab, `/book`, `/chat`. The last
  remaining way to open the panel can't be switched off.

## Rules

Bondage Club's add-on rules ask scripts not to affect other players without their consent, not to
take their data or appearance, and not to be usable for spam. How Little Black Book stays inside them:

- **Everything stays in your browser.** Profiles, logs and chats are what the server already sends
  you; nothing is uploaded anywhere, and recording can be switched off per kind in Settings.
- **Other people's outfits** can only be copied, saved or worn with their consent (see Profiles).
  Settings can change the checks or switch them off.
- **Exports** leave out other people's descriptions, outfits and crafts, and outfits saved from
  them, unless Settings → **Full exports** is on (for your own backups). Your own data is always
  included.
- **Group messages** are spaced out (1.5 s by default) and each person gets at most one group
  message a minute (default). Both are set in Settings → Messages.
- **Messages only go out when you send them.** Queued messages wait in the outbox until the person
  is online; nothing is sent on anyone else's behalf.

## Sync between computers

Settings → **Sync between computers** (on by default, switchable per computer) keeps the small things
the same on every computer you play on: settings, friend groups, notes, favorite profiles and rooms,
pinned and hidden chats, and your own saved outfits. They're stored in the game's private add-on
storage for your account (`Player.ExtensionSettings.BlackBookSync`, compressed), which other players
never see. Each item remembers when it last changed and the newer change wins; deletions travel too.
Changes made on another computer arrive at your next login there, since the game loads this storage
at login. Chat and room logs, cached profiles of other people, outfits saved from them and queued
messages stay on each computer. If your own outfits would make it too big, they're left out and
the rest still syncs. Console: `BlackBook.syncNow()`, `BlackBook.syncStatus()`.

## Storage

One IndexedDB database per account (`BlackBook-<member number>`; data in an older `FriendMgr-<member number>` database is moved over once at login, checked, and the old one deleted), opened after login, in this
browser only. Separate databases mean tabs logged into different accounts never block each other.
The first time an account logs in, its records are copied from the pre-0.3 shared `FriendMgr`
database (which is only read).

## Console

`BlackBook.open(member, "profiles" | "chats")`, `BlackBook.get(member)`, `BlackBook.all()`,
`BlackBook.sessions()`, `BlackBook.sessionLines(id)`, `BlackBook.conversation(member)`,
`BlackBook.currentSession()`, `BlackBook.importLianChat()`, `BlackBook.database()`.

## Install

1. Install [Tampermonkey](https://www.tampermonkey.net/) in Chrome or Edge.
2. Install **[Nightstand](https://github.com/BountyHunter9000/nightstand/raw/main/nightstand.user.js)**, the one script for all the add-ons, and
   confirm in Tampermonkey.
3. Reload the game. Little Black Book runs at its latest release; the dock's ⚙ → **Add-ons** turns it off or picks an
   earlier version (see [One script for all add-ons](../bc-dock/README.md#one-script-for-all-add-ons)).

New releases arrive by themselves while the menu is on Latest. To work on the code itself, see
[Development](../README.md#development).
