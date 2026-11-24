// ==UserScript==
// @name         Nightstand (beta)
// @namespace    nightstand
// @version      1.3.4
// @description  Nightstand with test versions switched on: each add-on starts at Beta (its newest test version, or the release once that's newer). For testers; install this or Nightstand, not both
// @author       BountyHunter9000
// @license      GPL-3.0-or-later
// @homepageURL  https://github.com/BountyHunter9000/nightstand
// @supportURL   https://github.com/BountyHunter9000/nightstand/issues
// @match        https://bondageeurope.com/*
// @match        https://www.bondageeurope.com/*
// @match        https://bondageprojects.elementfx.com/*
// @match        https://www.bondageprojects.elementfx.com/*
// @match        https://bondage-europe.com/*
// @match        https://www.bondage-europe.com/*
// @match        https://bondageprojects.com/*
// @match        https://www.bondageprojects.com/*
// @run-at       document-end
// @grant        none
// @require      https://cdn.jsdelivr.net/gh/BountyHunter9000/nightstand@tk-v1.3.4/bc-dock/bc-dock.js
// @updateURL    https://github.com/BountyHunter9000/nightstand/raw/main/nightstand-beta.user.js
// @downloadURL  https://github.com/BountyHunter9000/nightstand/raw/main/nightstand-beta.user.js
// ==/UserScript==

// The same as Nightstand, with "Show test versions" switched on: each add-on starts at Beta, and its menu in ⚙ → Add-ons
// lists the test versions. You can still pick Latest or a release for any add-on, or switch test versions off in ⚙.
// The dock comes from the tag in the @require line: a test version of the dock itself (tk-vX.Y.Z-beta.N) goes there.
window.BCToolkit = { loader: true, beta: true };
