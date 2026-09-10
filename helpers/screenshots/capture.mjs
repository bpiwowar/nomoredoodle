#!/usr/bin/env node
/**
 * Photograph the harness pages into media/, at the size the stores expect.
 *
 * Run it through `npm run screenshots`, which builds the pages first. It needs
 * a local Chrome; set CHROME to point at one somewhere unusual.
 *
 * The pages are served over http rather than opened as files because they are
 * ES modules, which a file:// origin is not allowed to load. Chrome is then
 * driven over the DevTools protocol instead of `--screenshot`, which fires on
 * the load event: these screens are only finished a few frames later, so each
 * page raises a flag when it has settled and the capture waits for that.
 */
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {Buffer} from 'node:buffer';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const built = path.resolve('.screenshots');
const output = path.resolve('media');
const width = 1280;
const height = 800;

const shots = [
	{file: 'calendar.png', page: 'overlay.html#calendar'},
	{file: 'list.png', page: 'overlay.html#list'},
	{file: 'calendars-tab.png', page: 'overlay.html#calendars'},
	{file: 'options.png', page: 'options.html'},
];

const chromeCandidates = [
	process.env.CHROME,
	'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
	'/Applications/Chromium.app/Contents/MacOS/Chromium',
	'/usr/bin/google-chrome',
	'/usr/bin/chromium',
];

const mimeTypes = {
	'.html': 'text/html',
	'.js': 'text/javascript',
	'.mjs': 'text/javascript',
	'.css': 'text/css',
	'.map': 'application/json',
	'.png': 'image/png',
	'.svg': 'image/svg+xml',
	'.woff2': 'font/woff2',
};

function findChrome() {
	const found = chromeCandidates.find(candidate => candidate && fs.existsSync(candidate));
	if (!found) {
		console.error('No Chrome found. Set CHROME to its path.');
		process.exit(1);
	}

	return found;
}

async function serve() {
	const server = createServer((request, response) => {
		const asked = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
		const file = path.join(built, asked === '/' ? '/overlay.html' : asked);
		// Nothing outside the build directory is servable, symlinks included.
		if (!fs.existsSync(file) || !path.resolve(file).startsWith(built)) {
			response.writeHead(404).end('not found');
			return;
		}

		response.writeHead(200, {'content-type': mimeTypes[path.extname(file)] ?? 'application/octet-stream'});
		fs.createReadStream(file).pipe(response);
	});
	await new Promise(resolve => {
		server.listen(0, '127.0.0.1', resolve);
	});
	return server;
}

async function until(what, attempt, {timeout = 20_000, every = 100} = {}) {
	const deadline = Date.now() + timeout;
	while (Date.now() < deadline) {
		// eslint-disable-next-line no-await-in-loop
		const result = await attempt();
		if (result) {
			return result;
		}

		// eslint-disable-next-line no-await-in-loop
		await new Promise(resolve => {
			setTimeout(resolve, every);
		});
	}

	throw new Error(`Timed out waiting for ${what}.`);
}

/** A DevTools connection, with request/response matched by message id. */
async function connect(url) {
	const socket = new WebSocket(url);
	const pending = new Map();
	socket.addEventListener('message', event => {
		const message = JSON.parse(event.data);
		const settle = pending.get(message.id);
		if (settle) {
			pending.delete(message.id);
			settle(message);
		}
	});
	await new Promise((resolve, reject) => {
		socket.addEventListener('open', resolve, {once: true});
		socket.addEventListener('error', reject, {once: true});
	});

	let id = 0;
	return {
		async send(method, params = {}) {
			id += 1;
			const mine = id;
			const answer = new Promise(resolve => {
				pending.set(mine, resolve);
			});
			socket.send(JSON.stringify({id: mine, method, params}));
			const message = await answer;
			if (message.error) {
				throw new Error(`${method}: ${message.error.message}`);
			}

			return message.result;
		},
		close() {
			socket.close();
		},
	};
}

async function main() {
	if (!fs.existsSync(built)) {
		console.error(`No ${path.relative('.', built)}/ - run "npm run screenshots" instead.`);
		process.exit(1);
	}

	const server = await serve();
	const origin = `http://127.0.0.1:${server.address().port}`;
	const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'nmd-screenshots-'));
	const chrome = spawn(findChrome(), [
		'--headless=new',
		'--remote-debugging-port=0',
		`--user-data-dir=${profile}`,
		'--no-first-run',
		'--no-default-browser-check',
		'--disable-extensions',
		'--hide-scrollbars',
		`--window-size=${width},${height}`,
		'about:blank',
	], {stdio: 'ignore'});

	let session;
	try {
		// Chrome writes the port it actually took on its first line.
		const port = await until('Chrome to start', () => {
			const file = path.join(profile, 'DevToolsActivePort');
			return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n')[0] : undefined;
		});
		const target = await until('a page to attach to', async () => {
			const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then(async response => response.json());
			return targets.find(candidate => candidate.type === 'page');
		});

		session = await connect(target.webSocketDebuggerUrl);
		await session.send('Page.enable');
		await session.send('Emulation.setDeviceMetricsOverride', {
			width, height, deviceScaleFactor: 1, mobile: false,
		});

		fs.mkdirSync(output, {recursive: true});
		for (const {file, page} of shots) {
			// One page at a time: the shots share a tab, and share it in order.
			/* eslint-disable no-await-in-loop */
			// Two shots of the same page differ only by fragment, and navigating
			// between those is a same-document navigation: nothing reloads, the
			// ready flag is still set from last time, and the camera catches the
			// previous view. Leaving the page first is what makes it a real load.
			await session.send('Page.navigate', {url: 'about:blank'});
			await session.send('Page.navigate', {url: `${origin}/${page}`});
			await until(`${page} to settle`, async () => {
				const {result} = await session.send('Runtime.evaluate', {
					expression: 'document.documentElement.dataset.screenshot === "ready"',
				});
				return result.value;
			});
			const {data} = await session.send('Page.captureScreenshot', {format: 'png'});
			fs.writeFileSync(path.join(output, file), Buffer.from(data, 'base64'));
			console.log(`media/${file} <- ${page}`);
			/* eslint-enable no-await-in-loop */
		}
	} finally {
		session?.close();
		server.close();
		// Killing it only asks. Chrome is still flushing its profile for a moment
		// after that, and removing the directory underneath it fails with
		// ENOTEMPTY - intermittently, which is the worst way to find out.
		chrome.kill();
		await new Promise(resolve => {
			chrome.once('exit', resolve);
			setTimeout(resolve, 5000);
		});
		fs.rmSync(profile, {
			recursive: true, force: true, maxRetries: 5, retryDelay: 100,
		});
	}
}

await main();
