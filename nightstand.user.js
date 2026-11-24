// ==UserScript==
// @name         Nightstand
// @namespace    nightstand
// @version      1.3.4
// @description  All the Nightstand add-ons for Bondage Club in one script: pick which ones run, and at which version, in the dock's ⚙ → Add-ons
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
// @updateURL    https://github.com/BountyHunter9000/nightstand/raw/main/nightstand.user.js
// @downloadURL  https://github.com/BountyHunter9000/nightstand/raw/main/nightstand.user.js
// ==/UserScript==

// The dock (from the tk-v1.3.4 release, loaded by @require above) is also the loader: it reads the list of add-ons
// and their versions, and starts the ones switched on in ⚙ → Add-ons, each from its own release. If you also have an
// add-on's separate script installed, that script keeps running it; turn the separate script off to choose here.
window.BCToolkit = { loader: true };
