/**
 * Browser API compatibility wrapper
 * Provides a unified API that works in both Chrome and Firefox
 */

// Use browser if available (Firefox), otherwise use chrome (Chrome/Chromium)
export const browserAPI: typeof browser | typeof chrome
	= typeof browser === 'undefined' ? chrome : browser;
