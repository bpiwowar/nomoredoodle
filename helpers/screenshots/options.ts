/**
 * The options page, rendered against the fake extension rather than a real
 * profile. It mounts itself on import, so there is nothing to do but install
 * the stand-ins first and then let it run.
 */
import {installFakeExtension} from './fixtures.js';

installFakeExtension();

async function main(): Promise<void> {
	await import('../../source/options.js');
	await new Promise(resolve => {
		setTimeout(resolve, 300);
	});
	document.documentElement.dataset.screenshot = 'ready';
}

void main();
