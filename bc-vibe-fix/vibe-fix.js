// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 BountyHunter9000. Part of Nightstand: https://github.com/BountyHunter9000/nightstand
// Game Fixes (formerly Vibe Fix) for Bondage Club
// Stopgaps for bugs in the game itself, each a small ModSDK hook that lets the game's own code do the work and stops
// doing anything once the game is fixed. (The folder, file, window.VibeFix and the vf-v tags keep the old name, so
// earlier versions and the Nightstand menus carry on working.)
//
// 1. Vibrators (R134): a vibrator's intensity could only go up. Picking Off, or a lower level, changed the mode's name
//    but left the vibrator running at the highest level it reached. Vibrators keep a default intensity (-1, off) in
//    their item data; when the mode changes, the game leaves the previous intensity out of what it removes, because
//    it's one of those defaults (ExtendedItemSetOption), then merges old and new intensity by taking the larger one
//    (the Intensity property's merge rule), so the old, higher value always wins. The fix clears the old intensity
//    just before the game applies the new one. Nothing else about the change is touched, and the game still sends it.
//
// 2. Lock picking (R134): picking a lock successfully never unlocked it. The Pick lock button starts the minigame
//    without setting DialogStruggleAction, and DialogStruggleStop, which the minigame calls at the end, returns on its
//    first line when that's empty, before it reaches the unlock. The fix sets it for a lock pick that ends (won or
//    lost, not interrupted) and clears it again afterwards, so the game's own code unlocks the item, posts the usual
//    "picked the lock" message, adds the lock-picking skill and goes back to the item list.
"use strict";

(async () => {

	// ModSDK: the full name groups the add-ons as "Nightstand: …" in mod lists, with a link to the add-on's folder
	const MOD_INFO = { name: "NS_VibeFix", fullName: "Nightstand: Game Fixes", version: "0.2.2", repository: "https://github.com/BountyHunter9000/nightstand/tree/main/bc-vibe-fix" };
	const TAG = "[GameFixes]";

	// Re-running the script (dev reload) replaces the previous instance
	if (window.VibeFix && typeof window.VibeFix.unload === "function") window.VibeFix.unload();

	const sleep = (/** @type {number | undefined} */ ms) => new Promise((r) => setTimeout(r, ms));
	while (typeof bcModSdk === "undefined" || typeof ExtendedItemSetProperty === "undefined" || typeof DialogStruggleStop === "undefined") await sleep(250);

	const mod = bcModSdk.registerMod(MOD_INFO);
	let fixed = 0; // vibrator intensity changes put right
	let picked = 0; // lock picks let through to the game's unlock

	// ---------- 1. vibrators ----------
	// ExtendedItemSetProperty(C, item, previousProperty, newProperty, push, refresh): removes previousProperty from the
	// item's properties, adds newProperty, and (with push) sends the item to the room. Only when the new properties set
	// an intensity, the item has a different one, and the previous properties don't mention it (the bug: it was left
	// out as a default) is the old intensity cleared first. When the game is fixed, previousProperty carries the
	// intensity again and this does nothing.
	mod.hookFunction("ExtendedItemSetProperty", 0, (args, next) => {
		try {
			const [, item, previous, next_] = args;
			const p = item?.Property;
			if (
				p &&
				typeof next_?.Intensity === "number" &&
				typeof p.Intensity === "number" &&
				p.Intensity !== next_.Intensity &&
				(previous == null || previous.Intensity === undefined)
			) {
				delete p.Intensity;
				fixed++;
			}
		} catch (e) {
			console.warn(TAG, e);
		}
		return next(args);
	});

	// ---------- 2. lock picking ----------
	// DialogStruggleStop(C, Game, { Progress, PrevItem, NextItem, Skill, Attempts, Interrupted, Auto }). The game's
	// DialogStruggleAction is a script-level variable, readable and writable from here by name. Only for a lock pick
	// that wasn't interrupted, and only while the game hasn't set an action itself (when it's fixed, it will).
	mod.hookFunction("DialogStruggleStop", 0, (args, next) => {
		let set = false;
		try {
			const [, game, data] = args;
			if (game === "LockPick" && !data?.Interrupted && typeof DialogStruggleAction !== "undefined" && !DialogStruggleAction) {
				DialogStruggleAction = "ActionUnlock";
				set = true;
				if (data?.Progress >= 100) picked++;
			}
		} catch (e) {
			console.warn(TAG, e);
		}
		try {
			return next(args);
		} finally {
			// Leave nothing behind for the next struggle
			if (set)
				try {
					if (DialogStruggleAction === "ActionUnlock") DialogStruggleAction = null;
				} catch {
					// already done or gone: nothing to undo
				}
		}
	});

	window.VibeFix = {
		version: MOD_INFO.version,
		fixed: () => fixed, // how many vibrator intensity changes it has put right since the page loaded
		picked: () => picked, // how many successful lock picks it has let through to the unlock
		unload() {
			mod.unload();
			delete window.VibeFix;
		},
	};

	console.log(TAG, `v${MOD_INFO.version} loaded${typeof GameVersion === "string" ? ` (game ${GameVersion})` : ""}`);
})().catch((err) => console.error("[GameFixes]", err));
