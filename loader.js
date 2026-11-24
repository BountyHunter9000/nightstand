// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 BountyHunter9000. Part of Nightstand: https://github.com/BountyHunter9000/nightstand
// Nightstand without Tampermonkey: the same thing nightstand.user.js does, for the browser console, a bookmark, or an
// add-on manager such as FUSAM. It turns the loader on and adds the dock; the dock then loads the add-ons you have
// switched on (⚙ → Add-ons). Running it twice, or alongside the Tampermonkey script, does nothing more.
// Which dock release to add comes from toolkit.json on GitHub (updated within minutes of a release), so this file
// itself hardly ever changes, and a CDN holding on to an old copy of it doesn't hold anyone back. If the list can't be
// read, the release named below is used.
(() => {
	"use strict";
	const BETA = false; // loader-beta.js: true (test versions switched on, the dock's newest test version)
	const FALLBACK = "tk-v1.3.4";
	// The repository: this name to start with, then whatever toolkit.json names ("repo"), so a renamed repository only
	// needs a new list (GitHub redirects the old name's raw files). Only the name comes from the list.
	const OWNER = "BountyHunter9000";
	const REPO = "nightstand";
	const NAME = /^[A-Za-z0-9._-]{1,100}$/;
	const LISTS = [`https://raw.githubusercontent.com/${OWNER}/${REPO}/main/toolkit.json`, `https://cdn.jsdelivr.net/gh/${OWNER}/${REPO}@main/toolkit.json`];
	const dockUrl = (repo, tag) => `https://cdn.jsdelivr.net/gh/${OWNER}/${repo}@${tag}/bc-dock/bc-dock.js`;
	if (window.BCToolkit && window.BCToolkit.loader === true) return;
	window.BCToolkit = BETA ? { loader: true, beta: true } : { loader: true };

	async function dockTag() {
		for (const url of LISTS) {
			try {
				const ctl = new AbortController();
				const timer = setTimeout(() => ctl.abort(), 6000);
				const r = await fetch(url, { cache: "no-store", signal: ctl.signal }).finally(() => clearTimeout(timer));
				if (!r.ok) continue;
				const list = await r.json();
				const tag = BETA ? list.dockBeta || list.dock : list.dock;
				const repo = typeof list.repo === "string" && NAME.test(list.repo) ? list.repo : REPO;
				// Only a dock tag of this repository, nothing else the list might say
				if (typeof tag === "string" && /^tk-v\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(tag)) return { repo, tag };
			} catch {}
		}
		return { repo: REPO, tag: FALLBACK };
	}

	// Added even when a dock is already here (from an old one-add-on script): the newer copy takes over, the same or an
	// older one steps aside, and a dock from version 14 on starts the loader once it sees the flag above
	dockTag().then(({ repo, tag }) => {
		const s = document.createElement("script");
		s.src = dockUrl(repo, tag);
		s.crossOrigin = "anonymous";
		s.onerror = () => console.warn("[Nightstand] couldn't download the dock from", s.src);
		document.head.append(s);
	});
})();
