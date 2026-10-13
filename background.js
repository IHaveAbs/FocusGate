/* Focus Gate — service worker.
   Seeds the default gate list and stores the master switch.
   Goals themselves live in per-tab sessionStorage (see content.js), so
   nothing here runs at page-visit time. */

'use strict';

const BLACKLIST_KEY = 'focusgate_blacklist';
const ENABLED_KEY = 'focusgate_enabled';

const DEFAULT_BLACKLIST = [
  'youtube.com',
  'reddit.com',
  'x.com',
  'twitter.com',
  'facebook.com',
  'instagram.com',
  'tiktok.com',
  'twitch.tv',
  'netflix.com',
  'pinterest.com',
  '9gag.com'
];

async function seedDefaults() {
  const stored = await chrome.storage.local.get([BLACKLIST_KEY, ENABLED_KEY]);
  if (!Array.isArray(stored[BLACKLIST_KEY])) {
    await chrome.storage.local.set({ [BLACKLIST_KEY]: DEFAULT_BLACKLIST });
  }
  if (stored[ENABLED_KEY] === undefined) {
    await chrome.storage.local.set({ [ENABLED_KEY]: true });
  }
}

chrome.runtime.onInstalled.addListener(seedDefaults);
