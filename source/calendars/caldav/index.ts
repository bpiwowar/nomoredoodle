import {type CalendarEvent, type TimeRange} from '../../events.js';
import {type CalendarSource, calendarId} from '../types.js';
import {type CalDavAccount, rememberHomeSet} from './accounts.js';
import {CalDavError} from './dav.js';
import {discoverHomeSet, fetchEvents, listCalendars} from './client.js';

export {
	type CalDavAccount, type CalDavAccountSummary, type CalDavCheck, loadAccounts, newAccountId,
	recordCheck, removeAccount, saveAccount, summarize,
} from './accounts.js';
export {CalDavError} from './dav.js';
export {discoverHomeSet, listCalendars} from './client.js';

/**
 * Discovery costs two round trips, so its answer is cached on the account. The
 * cache is trusted until something fails against it, at which point discovery
 * runs again: a server that moves its calendar home should heal by itself
 * rather than need the account re-entered.
 */
async function homeSetFor(account: CalDavAccount): Promise<string> {
	if (account.homeSet) {
		return account.homeSet;
	}

	const homeSet = await discoverHomeSet(account);
	await rememberHomeSet(account.id, homeSet);
	return homeSet;
}

async function calendarsFor(account: CalDavAccount) {
	const cached = account.homeSet;
	try {
		return await listCalendars(account, await homeSetFor(account));
	} catch (error) {
		if (!cached) {
			throw error;
		}

		const homeSet = await discoverHomeSet(account);
		await rememberHomeSet(account.id, homeSet);
		return listCalendars(account, homeSet);
	}
}

/**
 * Runs one real query against each calendar to see whether the server expands
 * recurrences, and reports the ones that do not.
 *
 * This belongs in the setup dialog rather than at fill time: the failure it
 * looks for is fatal to a fill, and finding out while entering the account is
 * the difference between a warning and an aborted poll. A month is used because
 * a weekly meeting is the common case and one week would not prove anything.
 */
export async function probeExpand(account: CalDavAccount, calendarUrls: string[]): Promise<string[]> {
	const startDate = new Date();
	const endDate = new Date(startDate.getTime() + (30 * 86_400 * 1000));

	const results = await Promise.all(calendarUrls.map(async url => {
		try {
			const {recurringMasters} = await fetchEvents(account, url, url, {startDate, endDate});
			return recurringMasters > 0 ? url : undefined;
		} catch {
			// A calendar that will not answer a REPORT is a separate problem, and
			// one the fill will report properly. Do not turn it into an expand
			// complaint here.
			return undefined;
		}
	}));

	return results.filter((url): url is string => url !== undefined);
}

export function caldavSource(account: CalDavAccount): CalendarSource {
	const label = account.label.trim() || new URL(account.url).host;

	return {
		id: account.id,
		type: 'caldav',
		label,

		async listGroups() {
			const calendars = await calendarsFor(account);
			// One group per account: the label matches the source, which is the
			// picker's signal to draw a single header rather than a nested one.
			return [{
				id: `${account.id}:@calendars`,
				label,
				calendars: calendars.map(calendar => ({
					id: calendarId(account.id, calendar.url),
					title: calendar.title,
					nativeId: calendar.url,
				})),
			}];
		},

		async getEvents(range: TimeRange, nativeIds: string[]): Promise<CalendarEvent[]> {
			const results = await Promise.all(nativeIds.map(async url =>
				fetchEvents(account, url, calendarId(account.id, url), range)));

			const unexpanded = results.reduce((total, result) => total + result.recurringMasters, 0);
			if (unexpanded > 0) {
				throw new CalDavError(
					`${label} returned ${unexpanded} recurring event(s) without expanding them.`,
					[
						'This server ignores the CalDAV "expand" element, so repeating events arrive',
						'as a single master with a recurrence rule instead of one entry per occurrence.',
						'',
						'Filling was stopped rather than continued, because every occurrence after the',
						'first would have been missing and its slot would have been answered "yes".',
						'',
						'Switch this account off in the calendar picker to fill from the other sources.',
					].join('\n'),
				);
			}

			return results.flatMap(result => result.events);
		},
	};
}
