// eslint-disable-next-line import/no-unassigned-import
import './options-storage.js';
import {getEvents} from './native-calendar.js';
import {CalendarStatus, type CalendarSlot, type TimeRange} from './events.js';
import {type OptionsCalendarStatus, type SelectedCalendars} from './popup.js';

type TabMessage = {type: 'get-range'} | {type: 'runFill'; payload: CalendarSlot[]};

async function fillSlots(tab_id: number) {
	console.log('Filling on', tab_id);
	const {startDate, endDate} = await chrome.tabs.sendMessage<TabMessage, TimeRange>(tab_id, {
		type: 'get-range',
	});

	console.log('Searching for events in range', startDate, endDate);

	const {selectedCalendars = {}} = (await browser.storage.local.get('selectedCalendars')) as {selectedCalendars?: SelectedCalendars};
	const selectedIds = Object.entries(selectedCalendars).filter(([_, sel]) => (sel !== 'off')).map(([calId, _]) => calId);
	const events = await getEvents(startDate, endDate, selectedIds);

	const offToYes = (status: OptionsCalendarStatus) => status === 'off' ? 'yes' : status;
	await chrome.tabs.sendMessage<TabMessage>(tab_id, {
		type: 'runFill',
		payload: events.map(event => ({
			...event,
			status: offToYes(selectedCalendars[event.calendarId]),
		})),
	});
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
	console.log('Got message', message);
	if (message.type === 'checkSupportedPage') {
		console.log('Checking if current page is supported');
		chrome.tabs.query({active: true, currentWindow: true}, tabs => {
			const tab = tabs[0];
			const isSupported = Boolean(tab?.url?.includes('doodle.com'));
			sendResponse({supported: isSupported});
			console.log(`Is supported: ${isSupported}`);
		});
		return true; // Keep channel open for async response
	}

	if (message.type === 'fillSlots') {
		console.log('Got a message: fill slot');
		chrome.tabs.query({active: true, currentWindow: true}, tabs => {
			if (tabs[0]?.id) {
				fillSlots(tabs[0]?.id).catch((error: unknown) => {
					console.warn('Error when filling', error);
				});
			}
		});
	} else {
		console.warn('Unprocessed', message);
	}
});
