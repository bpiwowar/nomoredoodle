// eslint-disable-next-line import/no-unassigned-import
import './options-storage.js';
import {getEvents} from './native-calendar.js';
import {CalendarStatus, type CalendarSlot, type TimeRange} from './events.js';
import {type OptionsCalendarStatus, type SelectedCalendars} from './popup.js';
import {browserAPI} from './browser-compat.js';

type TabMessage = {type: 'get-range'} | {type: 'runFill'; payload: CalendarSlot[]};

async function fillSlots(tab_id: number) {
	console.log('Filling on', tab_id);
	const {startDate, endDate} = await browserAPI.tabs.sendMessage<TabMessage, TimeRange>(tab_id, {
		type: 'get-range',
	});

	const {selectedCalendars = {}} = (await browserAPI.storage.local.get('selectedCalendars')) as {selectedCalendars?: SelectedCalendars};
	const selectedIds = Object.entries(selectedCalendars).filter(([_, sel]) => (sel !== 'off')).map(([calId, _]) => calId);

	console.log('Searching for events in range', startDate, endDate, selectedIds);
	const events = await getEvents(startDate, endDate, selectedIds);

	const offToYes = (status: OptionsCalendarStatus) => status === 'off' ? 'yes' : status;
	return browserAPI.tabs.sendMessage<TabMessage>(tab_id, {
		type: 'runFill',
		payload: events.map(event => ({
			...event,
			status: offToYes(selectedCalendars[event.calendarId]),
		})),
	});
}

browserAPI.runtime.onMessage.addListener((message, sender, sendResponse) => {
	console.log('Got message', message);
	if (message.type === 'checkSupportedPage') {
		console.log('Checking if current page is supported');
		browserAPI.tabs.query({active: true, currentWindow: true}, tabs => {
			const tab = tabs[0];
			const isSupported = Boolean(tab?.url?.includes('doodle.com'));
			sendResponse({supported: isSupported});
			console.log(`Is supported: ${isSupported}`);
		});
		return true; // Keep channel open for async response
	}

	if (message.type === 'fillSlots') {
		console.log('Got a message: fill slot');
		browserAPI.tabs.query({active: true, currentWindow: true}, tabs => {
			if (tabs[0]?.id) {
				fillSlots(tabs[0]?.id)
					.then(async () => {
						console.log('Filling is OK');
						await browserAPI.notifications.create({
							type: 'basic',
							// IconUrl: browser.runtime.getURL("icons/error.png"),
							title: 'Meeting schedule filled',
							message: 'All good',
						});
					})
					.catch(async (error: unknown) => {
						console.warn('Error when filling', error);
						await browserAPI.notifications.create({
							type: 'basic',
							// IconUrl: browser.runtime.getURL("icons/error.png"),
							title: 'Error',
							message: `Got errors when filling: ${(error as Error)?.message}`,
						});
					});
			}
		});
	} else {
		console.warn('Unprocessed', message);
	}
});
