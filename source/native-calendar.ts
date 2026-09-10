// Types for calendars

import {type CalendarStatus, type CalendarEvent, type CalendarSlot} from './events.js';
import {browserAPI} from './browser-compat.js';

const bridgeId = 'fr.piwowarski.calendar.bridge';

type Calendar = {
	id: string;
	name: string;
	status: CalendarStatus;
};

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
	availability?: string;
};

export class NativeBridgeError extends Error {
	/** See CalDavError for why this is not a constructor parameter property. */
	readonly hint?: string;

	constructor(message: string, hint?: string) {
		super(message);
		this.name = 'NativeBridgeError';
		this.hint = hint;
	}
}

/**
 * A host that is missing or not allowed for this extension never sends a
 * message: the only description of what went wrong is on the disconnect, and
 * Chrome and Firefox word it differently. The extension id is the useful part —
 * the host manifest allowlists exactly one, and an unpacked extension gets a new
 * one whenever the manifest "key" changes.
 */
function bridgeError(detail = ''): NativeBridgeError {
	const forbidden = /forbidden|does not have permission/i.test(detail);
	const missing = /not found|no such native application/i.test(detail);

	if (!forbidden && !missing) {
		return new NativeBridgeError(detail || 'The native calendar bridge disconnected before answering.');
	}

	const id = browserAPI.runtime.id;
	return new NativeBridgeError(
		forbidden
			? 'The native calendar bridge is installed, but not for this extension.'
			: 'The native calendar bridge is not installed.',
		[
			forbidden
				? `Its host manifest allows a different extension id than this one (${id}).`
				: `No native messaging host named "${bridgeId}" is registered for this browser.`,
			'',
			'Build and register it, then reload the extension:',
			'',
			'  cd <your nomoredoodle checkout>/bridge',
			'  swiftc -framework EventKit calendar-bridge.swift -o calendar-bridge',
			`  ./calendar-bridge --register --chrome-id ${id}`,
			'',
			'The same steps, with the download, are on the extension options page and at',
			'https://github.com/bpiwowar/nomoredoodle',
		].join('\n'),
	);
}

/**
 * One request/response round trip over the native messaging port.
 * `read` returns undefined for messages that are not the answer we are after.
 */
async function askBridge<T>(
	request: Record<string, unknown>,
	read: (message: any) => T | undefined,
	hostName: string = bridgeId,
): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		let port: ReturnType<typeof browserAPI.runtime.connectNative>;
		try {
			port = browserAPI.runtime.connectNative(hostName);
		} catch (error) {
			reject(bridgeError((error as Error)?.message));
			return;
		}

		let settled = false;
		const settle = (answer: () => void) => {
			if (settled) {
				return;
			}

			settled = true;
			clearTimeout(timeout);
			answer();
			// Disconnect slightly after settling
			setTimeout(() => {
				port.disconnect();
			}, 0);
		};

		const timeout = setTimeout(() => {
			settle(() => {
				reject(new NativeBridgeError('The native calendar bridge timed out.'));
			});
		}, 5000);

		port.onMessage.addListener((message: any) => {
			const answer = read(message);
			if (answer === undefined) {
				if (message?.error) {
					settle(() => {
						reject(new NativeBridgeError(String(message.error)));
					});
				}

				return;
			}

			settle(() => {
				resolve(answer);
			});
		});

		port.onDisconnect.addListener(() => {
			settle(() => {
				reject(bridgeError(browserAPI.runtime.lastError?.message));
			});
		});

		port.postMessage(request);
	});
}

export async function getCalendars(hostName: string = bridgeId): Promise<CalendarsGrouped> {
	return askBridge<CalendarsGrouped>(
		{action: 'listCalendars'},
		message => message.calendars as CalendarsGrouped | undefined,
		hostName,
	);
}

/**
 * Returns the events in a given time range for a subset of calendars
 *
 * @param start Events should start after this date
 * @param end Events should end before
 * @param calendarIds A list of calendar IDs
 * @returns A list of events
 */
export async function getEvents(start: Date, end: Date, calendarIds: string[]): Promise<CalendarEvent[]> {
	return askBridge<CalendarEvent[]>(
		{
			action: 'getEvents',
			start: start.getTime() / 1000, // Seconds since epoch
			end: end.getTime() / 1000,
			calendarIds,
		},
		message => {
			const items = message.events as EventItem[] | undefined;
			return items?.map(event => {
				// Map iCal availability to status
				let status: CalendarSlot['status'] = 'no';
				if (event.availability === 'free') {
					status = 'yes';
				} else if (event.availability === 'tentative') {
					status = 'if-need-be';
				} else {
					// 'busy', 'unavailable', or missing => 'no'
					status = 'no';
				}

				return {
					startDate: new Date(event.startDate * 1000),
					endDate: new Date(event.endDate * 1000),
					status,
					title: event.title,
					id: event.id,
					calendarId: event.calendarID,
				};
			});
		},
	);
}
