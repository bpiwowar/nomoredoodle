import './options-storage.js';
import {NativeBridgeError} from './native-calendar.js';
import {
	type CalendarSlot, type TimeRange, type OptionsCalendarStatus,
} from './events.js';
import {
	forgetSource, getEventsForSelection, listSources, loadCalendarStatuses, setSourceEnabled,
} from './calendars/index.js';
import {
	type CalDavAccount, type CalDavCheck, discoverHomeSet, listCalendars, loadAccounts, newAccountId,
	probeExpand, recordCheck, removeAccount, saveAccount, summarize,
} from './calendars/caldav/index.js';
import {browserAPI} from './browser-compat.js';

type TabMessage = {type: 'get-range'} | {type: 'runFill'; payload: CalendarSlot[]};

/**
 * Parcel content-hashes the icons, so a hard-coded "icon-128.png" never resolves
 * and Chrome then refuses to create the notification at all — which is why
 * failures used to reach the console and nowhere else. The built manifest is the
 * only place that knows the real file name.
 */
const notificationIcon = browserAPI.runtime.getManifest().icons?.['128'] ?? '';

/** Console warnings are invisible to users, so every failure gets a notification. */
async function notifyError(title: string, error: unknown) {
	console.warn(title, error);
	const hint = error instanceof NativeBridgeError ? error.hint : undefined;
	const message = (error as Error)?.message ?? 'Unknown error';
	await browserAPI.notifications.create({
		type: 'basic',
		title,
		message: hint ? `${message}\n\n${hint}` : message,
		iconUrl: notificationIcon,
	});
}

async function fillSlots(tab_id: number) {
	console.log('Filling on', tab_id);
	const response = await browserAPI.tabs.sendMessage<TabMessage, TimeRange | {error: string} | undefined>(tab_id, {
		type: 'get-range',
	});

	// A content script that finds nothing answers with a reason, or with nothing
	// at all. Either way the user needs to be told rather than hitting a
	// "cannot read properties of undefined" further down.
	if (response && 'error' in response) {
		throw new Error(response.error);
	}

	if (!response?.startDate || !response?.endDate) {
		throw new Error('No poll options found on this page. If the poll needs a "Vote" button to open its form, open it first, then try again.');
	}

	// Convert serialized dates back to Date objects
	const startDate = new Date(response.startDate);
	const endDate = new Date(response.endDate);

	const selectedCalendars = await loadCalendarStatuses();

	const selectedCount = Object.values(selectedCalendars).filter(status => status !== 'off').length;
	console.log('Searching for events in range', startDate, endDate, `across ${selectedCount} selected calendar(s)`);
	const events = await getEventsForSelection({startDate, endDate}, selectedCalendars);
	// No events and every calendar matching look identical from the outside, and
	// the first of those answers "yes" to every slot — so the count is logged.
	console.log(`Found ${events.length} event(s)`);

	const offToYes = (status: OptionsCalendarStatus) => status === 'off' ? 'yes' : status;
	return browserAPI.tabs.sendMessage<TabMessage>(tab_id, {
		type: 'runFill',
		payload: events.map(event => {
			const bridgeStatus = event.status; // Original status from iCal availability
			const calendarDefaultStatus = offToYes(selectedCalendars[event.calendarId] ?? 'off');

			// Just pass the raw data - let calendar-app handle the logic
			return {
				...event,
				bridgeStatus, // Preserve original status from bridge
				calendarDefaultStatus, // Store calendar's default status for reference
				status: bridgeStatus, // Pass through the bridge status
			};
		}),
	});
}

// Run the id migration when the worker starts rather than on first read, so the
// stored selection is consistent as soon as the extension loads — inspecting
// storage should not be what triggers the rewrite. Repeat starts are a no-op:
// the stored version stops it running twice.
void loadCalendarStatuses();

/**
 * The options page never talks to a CalDAV server itself: everything goes
 * through here, so credentials are read in exactly one place and a request made
 * while the page is closed behaves the same as one made while it is open.
 *
 * Failures answer with `{error, hint}` rather than rejecting, because a rejected
 * `sendMessage` reaches the page as a generic "message port closed" and loses
 * the part that says how to fix it.
 */
function answer(sendResponse: (response: any) => void, work: () => Promise<Record<string, unknown>>) {
	void (async () => {
		try {
			sendResponse(await work());
		} catch (error) {
			console.warn('Request failed', error);
			const hint = (error as {hint?: unknown})?.hint;
			const missingOrigin = (error as {missingOrigin?: unknown})?.missingOrigin;
			sendResponse({
				error: (error as Error)?.message ?? 'Unknown error',
				hint: typeof hint === 'string' ? hint : undefined,
				// Carried separately from the text so the page can offer the grant as
				// a button: a message telling someone to allow a host they cannot see
				// a way to allow is not much of an answer.
				missingOrigin: typeof missingOrigin === 'string' ? missingOrigin : undefined,
			});
		}
	})();
}

/**
 * Reaches the server and reports what it found. The discovered calendar names
 * come back with it: seeing them is the difference between "it connected" and
 * "it connected to the right account".
 *
 * Failure is a result, not an exception. Accounts are saved whether or not they
 * work — a server that is down, or behind a VPN that is not up yet, should not
 * cost you the credentials you just typed — so what a check produces is a verdict
 * to store and show, and the caller decides what to do about it.
 */
async function runCheck(account: CalDavAccount): Promise<CalDavCheck> {
	try {
		const homeSet = await discoverHomeSet(account);
		const calendars = await listCalendars(account, homeSet);
		const unexpanded = await probeExpand(account, calendars.map(calendar => calendar.url));
		return {
			at: Date.now(),
			ok: true,
			calendars: calendars.length,
			// Named after what it means for the user, not after the CalDAV element:
			// these calendars would silently lose every repeat of a repeating event.
			unexpanded: calendars.filter(calendar => unexpanded.includes(calendar.url)).map(calendar => calendar.title),
			message: calendars.map(calendar => calendar.title).join(', '),
		};
	} catch (error) {
		console.warn('CalDAV check failed', error);
		const hint = (error as {hint?: unknown})?.hint;
		const missingOrigin = (error as {missingOrigin?: unknown})?.missingOrigin;
		return {
			at: Date.now(),
			ok: false,
			message: (error as Error)?.message ?? 'Unknown error',
			hint: typeof hint === 'string' ? hint : undefined,
			missingOrigin: typeof missingOrigin === 'string' ? missingOrigin : undefined,
		};
	}
}

/** Editing an account leaves the password box empty to keep the stored one. */
async function withStoredPassword(draft: CalDavAccount): Promise<CalDavAccount> {
	if (draft.password || !draft.id) {
		return draft;
	}

	const accounts = await loadAccounts();
	const existing = accounts.find(account => account.id === draft.id);
	return existing ? {...draft, password: existing.password} : draft;
}

browserAPI.runtime.onMessage.addListener((message, sender, sendResponse) => {
	console.log('Got message', message);
	if (message.type === 'checkSupportedPage') {
		console.log('Checking if current page is supported');
		browserAPI.tabs.query({active: true, currentWindow: true}, tabs => {
			const tab = tabs[0];
			const isSupported = Boolean(tab?.url?.includes('doodle.com')
				|| tab?.url?.includes('evento.renater.fr/survey')
				|| tab?.url?.includes('framadate.org/polls')
				|| tab?.url?.includes('timeful.app/e/')
				|| tab?.url?.includes('app.rallly.co/invite/')
				|| tab?.url?.includes('app.rallly.co/poll/'));
			sendResponse({supported: isSupported});
			console.log(`Is supported: ${isSupported}`);
		});
		return true; // Keep channel open for async response
	}

	if (message.type === 'listCalendarSources') {
		console.log('Listing calendar sources');
		(async () => {
			try {
				sendResponse({listings: await listSources()});
			} catch (error) {
				// A failing source is already reported inside its own listing, so
				// reaching here means the settings read itself failed.
				console.error('Error listing calendar sources:', error);
				sendResponse({error: (error as Error)?.message ?? 'Failed to list calendars'});
			}
		})();

		return true; // Keep channel open for async response
	}

	if (message.type === 'setSourceEnabled') {
		(async () => {
			try {
				await setSourceEnabled(message.sourceId as string, message.enabled as boolean);
				// Answer with a fresh listing: switching a source on has to contact it.
				sendResponse({listings: await listSources()});
			} catch (error) {
				console.error('Error switching source:', error);
				sendResponse({error: (error as Error)?.message ?? 'Failed to switch source'});
			}
		})();

		return true; // Keep channel open for async response
	}

	if (message.type === 'listCalDavAccounts') {
		answer(sendResponse, async () => {
			const accounts = await loadAccounts();
			return {accounts: accounts.map(account => summarize(account))};
		});
		return true; // Keep channel open for async response
	}

	if (message.type === 'testCalDavAccount') {
		answer(sendResponse, async () => {
			const account = await withStoredPassword(message.account as CalDavAccount);
			const check = await runCheck(account);
			// A draft that has never been saved has no id and nowhere to record this;
			// the page shows it and, if the account is then saved, sends it back.
			if (account.id) {
				await recordCheck(account.id, check);
			}

			return {check};
		});
		return true; // Keep channel open for async response
	}

	if (message.type === 'saveCalDavAccount') {
		answer(sendResponse, async () => {
			const draft = await withStoredPassword(message.account as CalDavAccount);
			const account: CalDavAccount = {
				...draft,
				id: draft.id || newAccountId(),
				// The home set is a cache keyed by the address that produced it, so
				// editing an account has to drop it. Rediscovery costs two requests
				// once; keeping a stale one points the account at the wrong server.
				homeSet: undefined,
				lastCheck: message.lastCheck as CalDavCheck | undefined,
			};
			await saveAccount(account);
			return {account: summarize(account)};
		});
		return true; // Keep channel open for async response
	}

	if (message.type === 'removeCalDavAccount') {
		answer(sendResponse, async () => {
			const id = message.id as string;
			await removeAccount(id);
			// The selection is keyed by source, so it has to go with the account —
			// otherwise those statuses linger under an id nothing can resolve.
			await forgetSource(id);
			return {removed: id};
		});
		return true; // Keep channel open for async response
	}

	if (message.type === 'openOptionsPage') {
		void browserAPI.runtime.openOptionsPage();
		sendResponse({opened: true});
		return false;
	}

	if (message.type === 'fillSlots') {
		console.log('Got a message: fill slot');
		browserAPI.tabs.query({active: true, currentWindow: true}, async tabs => {
			if (tabs[0]?.id) {
				try {
					await fillSlots(tabs[0].id);
					console.log('Filling is OK');
					await browserAPI.notifications.create({
						type: 'basic',
						title: 'Meeting schedule filled',
						message: 'All good',
					iconUrl: notificationIcon,
					});
					sendResponse({success: true});
				} catch (error) {
					await notifyError('Could not fill the poll', error);
					sendResponse({success: false, error: (error as Error)?.message});
				}
			} else {
				sendResponse({success: false, error: 'No active tab found'});
			}
		});
		return true; // Keep channel open for async response
	}

	console.warn('Unprocessed message:', message);
	return false;
});

// Handle extension icon clicks
browserAPI.action.onClicked.addListener(async tab => {
	if (tab.id) {
		// Check if page is supported
		const isSupported = Boolean(tab?.url?.includes('doodle.com')
			|| tab?.url?.includes('evento.renater.fr/survey')
			|| tab?.url?.includes('framadate.org/polls')
			|| tab?.url?.includes('timeful.app/e/')
			|| tab?.url?.includes('app.rallly.co/invite/')
			|| tab?.url?.includes('app.rallly.co/poll/'));

		if (isSupported) {
			// Trigger the overlay
			fillSlots(tab.id)
				.then(async () => {
					console.log('Filling is OK');
					await browserAPI.notifications.create({
						type: 'basic',
						title: 'Meeting schedule filled',
						message: 'All good',
				iconUrl: notificationIcon,
					});
				})
				.catch(async (error: unknown) => {
					await notifyError('Could not fill the poll', error);
				});
		} else {
			// Show notification that page is not supported
			await browserAPI.notifications.create({
				type: 'basic',
				title: 'No More Doodle',
				message: 'Navigate to a Doodle, Evento, Framadate, Timeful, or Rallly page to use this extension.',
			iconUrl: notificationIcon,
			});
		}
	}
});
