// Types for calendars

import {type CalendarEvent, type CalendarSlot} from './events.js';

const BRIDGE_ID = 'fr.piwowarski.calendar.bridge';

export type CalendarEntry = {
	id: string;
	title: string;
	type: string;
};

export type CalendarsGrouped = Record<string, CalendarEntry[]>;

type EventItem = {
	id: string;
	title: string;
	startDate: number;
	endDate: number;
	calendarID: string;
	calendarTitle: string;
	location?: string;
	notes?: string;
};

// Use browser if available, otherwise chrome
const extension: typeof browser | typeof chrome
	= typeof browser === 'undefined' ? chrome : browser;

// Helper to connect to native host
export async function getCalendars(hostName: string = BRIDGE_ID): Promise<CalendarsGrouped> {
	return new Promise((resolve, reject) => {
		let resolved = false;

		const port = extension.runtime.connectNative(hostName);

		// Optional timeout: reject only if nothing arrives in 5 seconds
		const timeout = setTimeout(() => {
			if (!resolved) {
				reject(new Error('Native bridge timed out'));
			}
		}, 5000);

		port.onMessage.addListener((message: any) => {
			if (message.calendars) {
				resolved = true;
				clearTimeout(timeout);
				resolve(message.calendars as CalendarsGrouped);
				// Disconnect slightly after resolving
				setTimeout(() => {
					port.disconnect();
				}, 0);
			} else if (message.error) {
				resolved = true;
				clearTimeout(timeout);
				reject(new Error(message.error));
				setTimeout(() => {
					port.disconnect();
				}, 0);
			}
		});

		port.onDisconnect.addListener(() => {
			// Only reject if we haven't resolved AND timeout hasn't fired
			if (!resolved) {
				const errorMessage
						= (extension.runtime as any).lastError?.message
						|| 'Native bridge disconnected before sending a response (but may still succeed)';
				console.warn(errorMessage); // Just log
			}
		});

		// Send request
		port.postMessage({action: 'listCalendars'});
	});
}

/**
 * Returns the events in a given time range for a subset of calendars
 *
 * @param start Events should start after this date
 * @param end Events should end before
 * @param calendarIDs A list of calendar IDs
 * @returns A list of events
 */
export async function getEvents(start: Date, end: Date, calendarIDs: string[]): Promise<CalendarSlot[]> {
	return new Promise((resolve, reject) => {
		const port = chrome.runtime.connectNative(BRIDGE_ID);
		let resolved = false;

		const timeout = setTimeout(() => {
			if (!resolved) {
				reject(new Error('Native bridge timed out'));
			}
		}, 5000);

		port.onMessage.addListener(message => {
			if (message.events) {
				resolved = true;
				clearTimeout(timeout);
				const items = message.events as EventItem[];
				const events: CalendarEvent[] = items.map(event => ({
					startDate: new Date(event.startDate * 1000),
					endDate: new Date(event.endDate * 1000),
					status: 'no',
					title: event.title,
					id: event.id,
				}));
				console.log('Returning', events);
				resolve(events);
				setTimeout(() => {
					port.disconnect();
				}, 0);
			} else if (message.error) {
				resolved = true;
				clearTimeout(timeout);
				reject(new Error(message.error));
				setTimeout(() => {
					port.disconnect();
				}, 0);
			}
		});

		port.onDisconnect.addListener(() => {
			if (!resolved) {
				console.warn('Native bridge disconnected before sending a response');
			}
		});

		port.postMessage({
			action: 'getEvents',
			start: start.getTime() / 1000, // Seconds since epoch
			end: end.getTime() / 1000,
			calendarIDs,
		});
	});
}
