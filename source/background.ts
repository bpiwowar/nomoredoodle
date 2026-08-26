import './options-storage.js';
import {getEvents, getCalendars, NativeBridgeError} from './native-calendar.js';
import {
CalendarStatus, type CalendarSlot, type TimeRange, type OptionsCalendarStatus, type SelectedCalendars,
} from './events.js';
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

	const {selectedCalendars = {}} = (await browserAPI.storage.local.get('selectedCalendars')) as {selectedCalendars?: SelectedCalendars};
	const selectedIds = Object.entries(selectedCalendars).filter(([_, sel]) => (sel !== 'off')).map(([calId, _]) => calId);

	console.log('Searching for events in range', startDate, endDate, selectedIds);
	const events = await getEvents(startDate, endDate, selectedIds);

	const offToYes = (status: OptionsCalendarStatus) => status === 'off' ? 'yes' : status;
	return browserAPI.tabs.sendMessage<TabMessage>(tab_id, {
		type: 'runFill',
		payload: events.map(event => {
			const bridgeStatus = event.status; // Original status from iCal availability
			const calendarDefaultStatus = offToYes(selectedCalendars[event.calendarId]);

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

	if (message.type === 'getCalendars') {
		console.log('Getting calendars from native bridge');
		(async () => {
			try {
				const calendars = await getCalendars();
				sendResponse({calendars});
			} catch (error) {
				console.error('Error getting calendars:', error);
				sendResponse({
					error: (error as Error)?.message ?? 'Failed to get calendars',
					hint: error instanceof NativeBridgeError ? error.hint : undefined,
				});
			}
		})();

		return true; // Keep channel open for async response
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
