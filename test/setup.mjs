import {registerHooks} from 'node:module';

/**
 * Lets the tests import the extension's TypeScript sources directly, with no
 * compile step and so no chance of testing a stale copy.
 *
 * Two things stand in the way of running them as they are:
 *
 * 1. The sources import each other with `.js` specifiers, which is what
 *    TypeScript requires for ESM output but is not a file that exists on disk.
 *    Node does not remap those, so the resolve hook below does.
 * 2. `browser-compat.ts` reads the `chrome` global at import time. In a browser
 *    that is always there; here it is not, and the bare reference throws before
 *    any test runs. A minimal stand-in is enough — the modules under test only
 *    reach for it inside functions the unit tests do not call.
 *
 * Node's own type stripping handles the rest, which is why the sources avoid
 * TypeScript syntax that cannot be erased (see CalDavError).
 */
registerHooks({
	resolve(specifier, context, nextResolve) {
		if (specifier.startsWith('.') && specifier.endsWith('.js')) {
			try {
				return nextResolve(specifier.slice(0, -3) + '.ts', context);
			} catch {
				// Fall through: it really was a .js file, or it does not exist at all
				// and the original specifier gives the better error message.
			}
		}

		return nextResolve(specifier, context);
	},
});

globalThis.chrome ??= {
	runtime: {id: 'test-extension-id'},
	permissions: {
async contains() {
		return true;
	},
},
	storage: {
local: {
async get() {
		return {};
	}, async set() {},
},
},
};
