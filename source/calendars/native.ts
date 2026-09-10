import {type TimeRange} from '../events.js';
import {getCalendars, getEvents} from '../native-calendar.js';
import {
	type CalendarSource, calendarId, nativeSourceId,
} from './types.js';

/**
 * The macOS EventKit bridge. It already groups calendars by account, so those
 * groups pass straight through; the only translation is namespacing the ids.
 */
export const nativeSource: CalendarSource = {
	id: nativeSourceId,
	type: 'native',
	label: 'macOS calendars',

	async listGroups() {
		const grouped = await getCalendars();
		return Object.entries(grouped).map(([provider, entries]) => ({
			id: `${nativeSourceId}:${provider}`,
			label: provider,
			calendars: entries.map(entry => ({
				id: calendarId(nativeSourceId, entry.id),
				title: entry.title,
				nativeId: entry.id,
			})),
		}));
	},

	async getEvents(range: TimeRange, nativeIds: string[]) {
		const events = await getEvents(range.startDate, range.endDate, nativeIds);
		return events.map(event => ({
			...event,
			calendarId: calendarId(nativeSourceId, event.calendarId),
		}));
	},
};
