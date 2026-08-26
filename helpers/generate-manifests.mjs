import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

// Generates one manifest per browser from source/manifest.json.
//
// A single shared manifest cannot satisfy both stores: Chrome rejects
// `background.scripts` ("requires manifest version of 2 or lower") while Firefox
// has no service worker background and needs exactly that key, and its linter
// warns that `background.service_worker` is ignored. Each target below starts
// from the shared manifest and drops what its browser does not understand.
//
// To add a browser, add an entry here and a matching Parcel target in
// package.json ("targets": { "<name>": { source, distDir } }).

const sourceDirectory = path.resolve('./source');
const base = JSON.parse(fs.readFileSync(path.join(sourceDirectory, 'manifest.json'), 'utf8'));

const targets = {
	chrome(manifest) {
		delete manifest.browser_specific_settings; // Gecko-only
		delete manifest.background.scripts; // Manifest v2 only, as far as Chrome is concerned
	},
	firefox(manifest) {
		delete manifest.key; // Chrome-only extension id pinning
		delete manifest.minimum_chrome_version;
		delete manifest.background.service_worker; // Not supported by Firefox
		// Firefox does accept background.type, but Parcel's manifest schema only
		// allows it next to a service_worker. The bundle is self-contained, so a
		// classic script is equivalent here.
		delete manifest.background.type;
	},
};

/**
 * Each manifest is written to its own directory so that the file Parcel emits is
 * called `manifest.json`, which is the only name a browser will load — and so
 * that `parcel watch` keeps producing a loadable directory. That puts it one
 * level below the assets it points at, so every path that resolves to a real
 * file in source/ gains a `../`.
 */
function reroot(value) {
	if (Array.isArray(value)) {
		return value.map(item => reroot(item));
	}

	if (value && typeof value === 'object') {
		return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, reroot(item)]));
	}

	if (typeof value === 'string' && fs.existsSync(path.join(sourceDirectory, value))) {
		return `../${value}`;
	}

	return value;
}

for (const [name, apply] of Object.entries(targets)) {
	const manifest = structuredClone(base);
	delete manifest.$schema; // An editor aid, not part of the format
	apply(manifest);

	const directory = path.join(sourceDirectory, name);
	fs.mkdirSync(directory, {recursive: true});
	const output = path.join(directory, 'manifest.json');
	fs.writeFileSync(output, JSON.stringify(reroot(manifest), null, '\t') + '\n');
	console.log(`✅ ${path.relative(process.cwd(), output)}`);
}
