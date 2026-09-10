/**
 * Timeful page-world bridge.
 *
 * The extension saves availability by POSTing straight to
 * `/api/events/{id}/response` (see `timeful.ts` for why we bypass the
 * documented `set-slots` plugin call). That write never goes through Timeful's
 * Vue app, and Timeful keeps the event in `Event.vue`'s local state — so the
 * grid keeps showing the stale response until the user reloads the page.
 *
 * Timeful's plugin API exposes no "refresh" message, but its `Event` component
 * has a `refreshEvent()` method that refetches the event and reassigns
 * `this.event`. Reaching it means touching page JavaScript, which a normal
 * (isolated-world) content script cannot do — hence this second content script,
 * declared with `"world": "MAIN"` in the manifest. It only listens for our own
 * refresh request and answers whether the refresh happened; `timeful.ts` falls
 * back to reloading the page when the answer is no (or never comes, e.g. on
 * browsers that ignore `world` and inject this into the isolated world).
 */

import {TIMEFUL_REFRESH_REQUEST, TIMEFUL_REFRESH_RESPONSE, type TimefulRefreshResponse} from './timeful-messages.js';

type VueComponent = {
	refreshEvent?: () => unknown;
	$children?: VueComponent[];
};

/** Breadth-first search of the Vue tree for the component owning `refreshEvent`. */
function findEventComponent(): VueComponent | undefined {
	const root = (document.querySelector('#app') as {__vue__?: VueComponent} | undefined)?.__vue__;
	if (!root) {
		return undefined;
	}

	const queue: VueComponent[] = [root];
	while (queue.length > 0) {
		const component = queue.shift()!;
		if (typeof component.refreshEvent === 'function') {
			return component;
		}

		queue.push(...(component.$children ?? []));
	}

	return undefined;
}

globalThis.addEventListener('message', event => {
	if (event.source !== globalThis.window || (event.data as {type?: string} | undefined)?.type !== TIMEFUL_REFRESH_REQUEST) {
		return;
	}

	const {id} = event.data as {id: string};
	(async () => {
		let refreshed = false;
		try {
			const component = findEventComponent();
			if (component) {
				await component.refreshEvent!();
				refreshed = true;
			} else {
				console.warn('No More Doodle: could not find the Timeful event component to refresh');
			}
		} catch (error) {
			console.error('No More Doodle: refreshing the Timeful view failed', error);
		}

		const response: TimefulRefreshResponse = {type: TIMEFUL_REFRESH_RESPONSE, id, refreshed};
		globalThis.postMessage(response, globalThis.location.origin);
	})();
});
