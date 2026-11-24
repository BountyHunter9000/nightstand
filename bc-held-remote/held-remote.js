// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 BountyHunter9000. Part of Nightstand: https://github.com/BountyHunter9000/nightstand
// Held Remote for Bondage Club
// The game won't let you use a vibrator remote while your arms are tied, even with the Vibe Remote in your hand.
// With this add-on switched on, a remote someone else left you with works on your own vibrators while you're tied:
// either they put it in your hand, or they tied your arms while you were holding it. Everything else the game,
// your owner or BCX says about remotes still applies. Off until you switch it on.
"use strict";

(async () => {

	// ModSDK: the full name groups the add-ons as "Nightstand: …" in mod lists, with a link to the add-on's folder
	const MOD_INFO = { name: "NS_HeldRemote", fullName: "Nightstand: Held Remote", version: "0.1.5", repository: "https://github.com/BountyHunter9000/nightstand/tree/main/bc-held-remote" };
	const TAG = "[HeldRemote]";
	/** @param {number} m */
	const ON_KEY = (m) => `HeldRemote.${m}`;
	/** @param {number} m */
	const GRANT_KEY = (m) => `HeldRemote.grant.${m}`;
	/** @type {{ group: AssetGroupItemName, name: string }} */
	const HELD = { group: "ItemHandheld", name: "VibeRemote" };

	// Re-running the script (dev reload) replaces the previous instance
	if (window.HeldRemote && typeof window.HeldRemote.unload === "function") window.HeldRemote.unload();

	/** @param {number} ms */
	const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
	while (typeof bcModSdk === "undefined" || typeof Player === "undefined" || typeof DialogCanUseRemoteState === "undefined" || typeof ChatRoomSyncItem === "undefined")
		await sleep(250);

	const mod = bcModSdk.registerMod(MOD_INFO);

	// ---------- state ----------
	// on: switched on for this character (this browser). grant: who left you with the remote, and how:
	// { by: member number, name, how: "given" | "tied", at: ms }. Both kept in localStorage per character.

	/** @typedef {{ by: number, name: string, how: "given" | "tied" | "relog", at: number }} HeldGrant */
	/** @type {number | null} */
	let member = null;
	let on = false;
	/** @type {HeldGrant | null} */
	let grant = null;

	/** @param {string} k */
	const lsGet = (k) => {
		try {
			return localStorage.getItem(k);
		} catch {
			return null;
		}
	};
	/**
	 * @param {string} k
	 * @param {string | null} v null removes it
	 */
	const lsSet = (k, v) => {
		try {
			if (v == null) localStorage.removeItem(k);
			else localStorage.setItem(k, v);
		} catch {
			// storage full or blocked: carries on without saving
		}
	};

	/** @param {number | null} m */
	function load(m) {
		member = m;
		on = !!m && lsGet(ON_KEY(m)) === "1";
		grant = null;
		if (m) {
			try {
				const g = /** @type {HeldGrant | null} */ (JSON.parse(lsGet(GRANT_KEY(m)) || "null"));
				if (g && Number.isInteger(g.by) && ["given", "tied", "relog"].includes(g.how)) grant = g;
			} catch {
				// missing or unreadable: the defaults stay
			}
		}
	}
	const saveGrant = () => member && lsSet(GRANT_KEY(member), grant ? JSON.stringify(grant) : null);
	/**
	 * @param {HeldGrant | null} g
	 * @param {string} why for the console
	 */
	function setGrant(g, why) {
		grant = g;
		saveGrant();
		console.info(TAG, g ? `remote from ${g.name || `#${g.by}`} (${g.how})` : "remote permission ended", why ? `: ${why}` : "");
		ui.render();
	}

	// ---------- game helpers ----------

	/** @param {Character} [C] */
	const holding = (C = Player) => {
		const it = typeof InventoryGet === "function" ? InventoryGet(C, HELD.group) : null;
		return it?.Asset?.Name === HELD.name;
	};
	/** @param {Character} [C] */
	const armsBlocked = (C = Player) => typeof C?.CanInteract === "function" && !C.CanInteract();
	// The remote has to be usable in your hand: mitts and the like that block the hand slot rule it out
	const handFree = () => {
		try {
			return !InventoryGroupIsBlocked(Player, HELD.group);
		} catch {
			return true;
		}
	};
	// Vibrators only: the game's vibrating items, and items with a vibration intensity. Shock items never count.
	/** @param {Item | null | undefined} item */
	function isVibrator(item) {
		if (!item?.Asset) return false;
		if (typeof InventoryItemHasEffect === "function" && InventoryItemHasEffect(item, "ReceiveShock", true)) return false;
		return item.Asset.Archetype === "vibrating" || typeof item.Property?.Intensity === "number";
	}
	/** @param {number} m */
	function nameOf(m) {
		const c = typeof ChatRoomCharacter !== "undefined" ? ChatRoomCharacter.find((x) => x.MemberNumber === m) : null;
		if (!c) return `#${m}`;
		try {
			return typeof CharacterNickname === "function" ? CharacterNickname(c) : c.Name;
		} catch {
			return c.Name || `#${m}`;
		}
	}
	/** @param {string} msg */
	function tell(msg) {
		if (typeof CurrentScreen !== "undefined" && CurrentScreen === "ChatRoom" && typeof ChatRoomSendLocal === "function") ChatRoomSendLocal(msg, 15_000);
		console.log(TAG, msg);
	}

	// The game's checks after "can you use your hands" (Dialog.js, DialogCanUseRemoteState), unchanged: an owner's
	// rules on remotes, lover-only items, items that block remotes, and owning a remote
	/**
	 * @param {Character} C
	 * @param {Item} Item
	 * @returns {VibratorRemoteAvailability}
	 */
	function remainingChecks(C, Item) {
		if (C.IsPlayer() && Player.IsFullyOwned() && LogQuery("BlockRemoteSelf", "OwnerRule")) return "RemotesBlocked";
		if (Item.Asset.LoverOnly) {
			if (!C.IsLoverOfPlayer()) return "NoAccess";
			if (!InventoryAvailable(Player, "LoversVibratorRemote", "ItemVulva")) return "NoLoversRemote";
			return "Available";
		}
		if (C.Effect.indexOf("BlockRemotes") >= 0) return "RemotesBlocked";
		if (!InventoryAvailable(Player, "VibratorRemote", "ItemVulva")) return "NoRemote";
		if (LogQuery("BlockRemote", "OwnerRule")) return "NoRemoteOwnerRuleActive";
		return "Available";
	}

	// Usable now: switched on, holding the remote someone else left you with, a free hand to hold it
	const usable = () => on && !!grant && holding() && handFree();

	// ---------- the hook ----------
	// Only the game's "your hands are blocked" answer changes, only for your own vibrators, and only while usable().
	// Every other answer passes through, and the rest of the game's checks still run. BCX's remote rules act later
	// (on the Remote button and the remote click), so they still apply. Low priority: other add-ons' hooks see the
	// result.
	mod.hookFunction("DialogCanUseRemoteState", -10, (args, next) => {
		const result = next(args);
		if (result !== "CannotInteract") return result;
		const [C, Item] = args;
		try {
			if (!C?.IsPlayer?.() || !isVibrator(Item) || !usable()) return result;
			return remainingChecks(C, Item);
		} catch (e) {
			console.warn(TAG, "check failed", e);
			return result;
		}
	});

	// ---------- who left you with the remote ----------
	// Someone else changing your items arrives as ChatRoomSyncItem (one item) or ChatRoomSyncSingle (the whole
	// character, e.g. a wardrobe or BCX outfit), with who did it. Compare before and after:
	//  - the remote is newly in your hand → they gave it to you
	//  - your arms just got blocked while you hold it → they tied you with it in your hand
	// Your own changes never count.
	/**
	 * @param {unknown} source who made the change (member number)
	 * @param {{ holding: boolean, blocked: boolean } | null} before
	 */
	function noteChange(source, before) {
		if (!member || !before || typeof source !== "number" || !Number.isInteger(source) || source === member || source <= 0) return;
		const hold = holding();
		if (!hold) return;
		/** @type {"given" | "tied" | null} */
		let how = null;
		if (!before.holding) how = "given";
		else if (!before.blocked && armsBlocked()) how = "tied";
		if (!how) return;
		const name = nameOf(source);
		setGrant({ by: source, name, how, at: Date.now() }, "seen in the room");
		if (on) tell(`🎚 ${name} ${how === "given" ? "put the Vibe Remote in your hand" : "tied you with the Vibe Remote in your hand"}: you can use it on your vibrators.`);
	}
	const snapshot = () => ({ holding: holding(), blocked: armsBlocked() });

	mod.hookFunction("ChatRoomSyncItem", 0, (args, next) => {
		const data = args[0];
		const mine = member && data?.Item?.Target === member;
		const before = mine ? snapshot() : null;
		const r = next(args);
		if (mine) safely(() => noteChange(data.Source, before));
		return r;
	});
	mod.hookFunction("ChatRoomSyncSingle", 0, (args, next) => {
		const data = args[0];
		const mine = member && data?.Character?.MemberNumber === member;
		const before = mine ? snapshot() : null;
		const r = next(args);
		if (mine) safely(() => noteChange(data.SourceMemberNumber, before));
		return r;
	});

	/** @param {() => void} fn */
	function safely(fn) {
		try {
			fn();
		} catch (e) {
			console.warn(TAG, e);
		}
	}

	// The permission ends when the remote leaves your hand. Only judged while the game is settled (connected, your
	// character loaded, not on the login or reconnect screens), and only once it's been gone a few seconds, so a
	// disconnect or a reload never ends it by mistake.
	let missingSince = 0;
	const settled = () =>
		(typeof ServerIsConnected === "undefined" || ServerIsConnected) &&
		Array.isArray(Player?.Appearance) &&
		Player.Appearance.length > 0 &&
		!(typeof CurrentScreen !== "undefined" && ["Login", "Relog", "Disclaimer", "Creation"].includes(CurrentScreen));
	function check() {
		if (!grant || !member || !settled()) return (missingSince = 0);
		if (holding()) return (missingSince = 0);
		if (!missingSince) missingSince = Date.now();
		else if (Date.now() - missingSince >= 3000) {
			missingSince = 0;
			setGrant(null, "the remote left your hand");
		}
	}

	// Logging in, reconnecting or reloading while you're tied with the remote already in your hand: it counts. Held
	// Remote can't have seen how it got there (it wasn't running, or the hand-off happened while you were away), and you
	// couldn't have put it there yourself while tied. Checked once the game has settled after each login or reconnect.
	let startCheck = true;
	let wasConnected = true;
	function checkStart() {
		const conn = typeof ServerIsConnected === "undefined" || !!ServerIsConnected;
		if (conn && !wasConnected) startCheck = true; // back from a disconnect
		wasConnected = conn;
		if (!startCheck || !member || !settled()) return;
		startCheck = false;
		if (!grant && holding() && armsBlocked()) setGrant({ by: 0, name: "", how: "relog", at: Date.now() }, "in your hand when you came back");
	}

	/** @param {boolean} v */
	function setOn(v) {
		if (!member) return;
		on = !!v;
		lsSet(ON_KEY(member), on ? "1" : null);
		ui.render();
		tell(on ? `🎚 Held Remote on. ${status()}` : "🎚 Held Remote off: the game's usual rule applies (no remote while your arms are tied).");
	}

	function status() {
		if (!grant) return holding() ? "You picked up the remote yourself, so it doesn't count yet: someone else has to give it to you or tie you holding it." : "Nobody has left you with a Vibe Remote.";
		const who =
			grant.how === "relog"
				? "The remote was in your hand when you came back"
				: `${grant.name || `#${grant.by}`} ${grant.how === "given" ? "gave you the remote" : "tied you holding the remote"}`;
		if (!handFree()) return `${who}, but your hand can't hold it right now.`;
		return `${who}: you can use it on your vibrators while tied.`;
	}

	// ---------- dock tab ----------

	const ui = (() => {
		/** @type {BCDockHandle | null} */
		let tab = null;
		let warned = false;
		function render() {
			if (!window.BCDock) {
				if (!warned) {
					warned = true;
					console.warn(TAG, "bc-dock.js isn't loaded, so there's no button. /heldremote still works.");
				}
				return;
			}
			if (!tab) tab = BCDock.add({ id: "held-remote", title: "Held Remote", icon: "🎚", order: 70, version: MOD_INFO.version, visible: !!member, onClick: () => setOn(!on) });
			tab.setVisible(!!member);
			tab.setSummary(member ? (on ? `on · ${status()} · click to turn off` : "off · click to turn on") : "");
			tab.setDot(!on ? "none" : usable() ? "on" : "wait");
		}
		function unmount() {
			tab?.remove();
			tab = null;
		}
		return { render, unmount };
	})();

	// ---------- /heldremote ----------

	const COMMAND = {
		Tag: "heldremote",
		Description: "[on|off]: let a remote someone left you with work while you're tied (no argument shows the state)",
		Action: (/** @type {string} */ args) => {
			const a = String(args || "").trim().toLowerCase();
			if (a === "on") setOn(true);
			else if (a === "off") setOn(false);
			else tell(`🎚 Held Remote is ${on ? "on" : "off"}. ${on ? status() : ""} /heldremote on or /heldremote off.`);
		},
	};
	let commandAdded = false;
	function addCommand() {
		if (commandAdded || typeof Commands === "undefined" || typeof CommandCombine !== "function") return;
		commandAdded = true;
		if (Commands.some((c) => c.Tag === COMMAND.Tag)) return console.warn(TAG, "/heldremote is already used by another add-on");
		CommandCombine([COMMAND]);
	}

	// ---------- wiring ----------
	let lastSig = "";
	function tick() {
		addCommand();
		const m = Player?.MemberNumber || null;
		if (m !== member) {
			load(m);
			startCheck = true;
		}
		checkStart();
		check();
		const sig = `${member}|${on}|${grant?.by}|${usable()}`;
		if (sig !== lastSig) {
			lastSig = sig;
			ui.render();
		}
	}
	tick();
	const timer = setInterval(tick, 1000);

	window.HeldRemote = {
		version: MOD_INFO.version,
		isOn: () => on,
		grant: () => (grant ? { ...grant } : null),
		usable,
		status,
		unload() {
			clearInterval(timer);
			// Take /heldremote with it, so a reloaded copy adds its own
			if (typeof Commands !== "undefined") {
				const i = Commands.indexOf(COMMAND);
				if (i >= 0) Commands.splice(i, 1);
			}
			ui.unmount();
			mod.unload();
			delete window.HeldRemote;
		},
	};

	console.log(TAG, `v${MOD_INFO.version} loaded`);
})().catch((err) => console.error("[HeldRemote]", err));
