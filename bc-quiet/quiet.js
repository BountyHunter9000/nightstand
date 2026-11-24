// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 BountyHunter9000. Part of Nightstand: https://github.com/BountyHunter9000/nightstand
// Quiet for Bondage Club
// One click on the dock mutes every game notification in this tab (popups, tab title, favicon and the alarm
// sound, for chat messages, people joining, beeps, disconnects and LARP turns), and another click brings them
// back. The game's own notification settings are never changed. The choice is kept per character in this browser.
"use strict";

(async () => {

	// ModSDK: the full name groups the add-ons as "Nightstand: …" in mod lists, with a link to the add-on's folder
	const MOD_INFO = { name: "NS_Quiet", fullName: "Nightstand: Quiet", version: "0.2.3", repository: "https://github.com/BountyHunter9000/nightstand/tree/main/bc-quiet" };
	const TAG = "[Quiet]";
	/** @param {number} m */
	const KEY = (m) => `Quiet.${m}`;

	// Re-running the script (dev reload) replaces the previous instance
	if (window.Quiet && typeof window.Quiet.unload === "function") window.Quiet.unload();

	/** @param {number} ms */
	const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
	while (typeof bcModSdk === "undefined" || typeof Player === "undefined" || typeof NotificationRaise === "undefined") await sleep(250);

	const mod = bcModSdk.registerMod(MOD_INFO);

	// ---------- state: one flag per character, in this browser ----------

	/** @type {number | null} */
	let member = null; // whose setting is loaded
	let muted = false;
	let skipped = 0; // notifications held back since muting, for the tooltip

	/** @param {number} m */
	const read = (m) => {
		try {
			return localStorage.getItem(KEY(m)) === "1";
		} catch {
			return false;
		}
	};
	/**
	 * @param {number} m
	 * @param {boolean} on
	 */
	const write = (m, on) => {
		try {
			if (on) localStorage.setItem(KEY(m), "1");
			else localStorage.removeItem(KEY(m));
		} catch {
			// storage full or blocked: carries on without saving
		}
	};

	// Notifications already showing (a count in the tab title, a favicon dot, an open popup) are cleared on muting,
	// so nothing is left over from before
	function clearShown() {
		try {
			if (typeof NotificationResetAll === "function" && typeof NotificationEventHandlers !== "undefined" && NotificationEventHandlers) NotificationResetAll();
		} catch (e) {
			console.warn(TAG, "couldn't clear notifications", e);
		}
	}

	/**
	 * @param {boolean} on
	 * @param {boolean} [say] tell the player in the chat
	 */
	function setMuted(on, say = true) {
		on = !!on;
		if (!member) return;
		if (on === muted) return ui.render();
		muted = on;
		skipped = 0;
		write(member, on);
		if (on) clearShown();
		ui.render();
		if (say) tell(on ? "🔕 Notifications muted in this tab. Click 🔕 on the dock or type /quiet to turn them back on." : "🔔 Notifications are back on in this tab.");
	}

	/** @param {string} msg */
	function tell(msg) {
		if (typeof CurrentScreen !== "undefined" && CurrentScreen === "ChatRoom" && typeof ChatRoomSendLocal === "function") ChatRoomSendLocal(msg, 10_000);
		console.log(TAG, msg);
	}

	// ---------- the hook ----------
	// Every game notification goes through NotificationRaise. While muted it isn't passed on, so nothing pops up,
	// the title and favicon stay as they are and no alarm plays. The Test button in the game's notification settings
	// still works, since pressing it means you want to see one.
	mod.hookFunction("NotificationRaise", 0, (args, next) => {
		if (muted && args[0] !== "Test") {
			skipped++;
			ui.render();
			return;
		}
		return next(args);
	});

	// ---------- dock tab ----------
	// A button tab, not a panel: a click toggles. The dock keeps a tab's icon from when it was added, so a change of
	// state adds the tab again with the other icon (adding an id that exists replaces it in place).

	const ui = (() => {
		/** @type {BCDockHandle | null} */
		let tab = null;
		/** @type {string | null} */
		let shownIcon = null;
		let warned = false;
		const icon = () => (muted ? "🔕" : "🔔");
		function tip() {
			if (!member) return "";
			if (!muted) return "on · click to mute this tab";
			return `muted${skipped ? ` (${skipped} held back)` : ""} · click to turn back on`;
		}
		function render() {
			if (!window.BCDock) {
				if (!warned) {
					warned = true;
					console.warn(TAG, "bc-dock.js isn't loaded (the Nightstand script brings it), so there's no button. /quiet still works.");
				}
				return;
			}
			if (!tab || shownIcon !== icon()) {
				shownIcon = icon();
				tab = BCDock.add({ id: "quiet", title: "Notifications", icon: shownIcon, order: 60, version: MOD_INFO.version, visible: !!member, onClick: () => setMuted(!muted) });
			}
			tab.setVisible(!!member);
			tab.setSummary(tip());
			tab.setDot(muted ? "bad" : "none");
			// 🔕 in the browser tab's title while muted (dock 13 and later)
			window.BCDock?.setTitleMark?.("quiet", member && muted ? "🔕" : null);
		}
		function unmount() {
			window.BCDock?.setTitleMark?.("quiet", null);
			tab?.remove();
			tab = null;
		}
		return { render, unmount };
	})();

	// ---------- /quiet ----------

	const COMMAND = {
		Tag: "quiet",
		Description: "[on|off]: mute or unmute the game's notifications in this tab (no argument switches)",
		Action: (/** @type {string} */ args) => {
			const a = String(args || "").trim().toLowerCase();
			if (a === "on" || a === "mute") setMuted(true);
			else if (a === "off" || a === "unmute") setMuted(false);
			else if (a === "") setMuted(!muted);
			else tell(`Notifications are ${muted ? "muted" : "on"} in this tab. /quiet on, /quiet off, or /quiet to switch.`);
		},
	};
	let commandAdded = false;
	function addCommand() {
		if (commandAdded || typeof Commands === "undefined" || typeof CommandCombine !== "function") return;
		commandAdded = true;
		if (Commands.some((c) => c.Tag === COMMAND.Tag)) return console.warn(TAG, "/quiet is already used by another add-on");
		CommandCombine([COMMAND]);
	}

	// ---------- wiring ----------
	// The setting belongs to the character logged in: it's loaded on login, and logging out (or in as someone else)
	// switches to theirs
	function sync() {
		addCommand();
		const m = Player?.MemberNumber || null;
		if (m === member) return;
		member = m;
		muted = m ? read(m) : false;
		skipped = 0;
		ui.render();
	}
	sync();
	const timer = setInterval(sync, 1000);

	window.Quiet = {
		version: MOD_INFO.version,
		isMuted: () => muted,
		mute: () => setMuted(true),
		unmute: () => setMuted(false),
		toggle: () => setMuted(!muted),
		unload() {
			clearInterval(timer);
			ui.unmount();
			mod.unload();
			delete window.Quiet;
		},
	};

	console.log(TAG, `v${MOD_INFO.version} loaded${muted ? " (muted)" : ""}`);
})().catch((err) => console.error("[Quiet]", err));
