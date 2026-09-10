/**
 * The world the screenshots are taken in: two calendar sources, a week of
 * events, and the poll they are matched against.
 *
 * All of it is invented. Screenshots of a real session publish whoever took
 * them - their calendars, their colleagues' meetings, the poll they were
 * answering - and the store listing is the last place to find that out. The
 * dates are fixed for the same reason a build is: a regenerated PNG should
 * differ only when the interface does, never because it is a different Tuesday.
 */
import {type CalendarEvent, type CalendarSlot, type SelectedCalendars} from '../../source/events.js';
import {type SourceListing} from '../../source/calendars/types.js';

/** Monday to Thursday of one week that will never arrive. */
const days = ['2026-09-14', '2026-09-15', '2026-09-16', '2026-09-17'];

/**
 * Parsed as local time, and read back through the same clock by the views, so
 * the images do not depend on the timezone the capture ran in.
 */
function at(day: string, time: string): Date {
	return new Date(`${day}T${time}:00`);
}

const nativeSource = 'native';
const caldavSource = 'caldav-demo';

const work = `${nativeSource}:work`;
const personal = `${nativeSource}:personal`;
const team = `${caldavSource}:team`;

export const listings: SourceListing[] = [
	{
		sourceId: nativeSource,
		type: 'native',
		label: 'macOS calendars',
		enabled: true,
		groups: [
			{
				id: 'icloud',
				label: 'iCloud',
				calendars: [
					{id: work, nativeId: 'work', title: 'Work'},
					{id: personal, nativeId: 'personal', title: 'Personal'},
				],
			},
			{
				id: 'google',
				label: 'Google',
				calendars: [
					{id: `${nativeSource}:holidays`, nativeId: 'holidays', title: 'Public holidays'},
				],
			},
		],
	},
	{
		sourceId: caldavSource,
		type: 'caldav',
		label: 'Nextcloud',
		enabled: true,
		groups: [
			{
				id: 'nextcloud',
				label: 'cloud.example.org',
				calendars: [
					{id: team, nativeId: 'team', title: 'Team calendar'},
					{id: `${caldavSource}:travel`, nativeId: 'travel', title: 'Conference travel'},
				],
			},
		],
	},
];

export const calendarStatuses: SelectedCalendars = {
	[work]: 'no',
	[personal]: 'if-need-be',
	[team]: 'no',
	[`${caldavSource}:travel`]: 'could-be',
	[`${nativeSource}:holidays`]: 'off',
};

/** What the poll asks: three times a day, four days running. */
export const slots: CalendarSlot[] = days.flatMap(day => [
	['09:00', '10:00'],
	['11:00', '12:00'],
	['14:00', '15:00'],
].map(([start, end]) => ({
	id: `${day}-${start}`,
	status: 'yes' as const,
	startDate: at(day, start),
	endDate: at(day, end),
})));

/**
 * Enough overlap to show every answer the extension can give: a standup that
 * rules out every morning, a "personal" calendar that only argues, and two days
 * that stay free.
 */
export const events: CalendarEvent[] = [
	...days.map((day, index) => ({
		id: `standup-${index}`,
		title: 'Daily standup',
		calendarId: work,
		status: 'no' as const,
		bridgeStatus: 'no' as const,
		startDate: at(day, '09:15'),
		endDate: at(day, '09:45'),
	})),
	{
		id: 'design-review',
		title: 'Design review with the whole team',
		calendarId: work,
		status: 'no',
		bridgeStatus: 'no',
		startDate: at(days[1], '10:30'),
		endDate: at(days[1], '12:00'),
	},
	{
		id: 'lunch',
		title: 'Lunch with the design team',
		calendarId: personal,
		status: 'if-need-be',
		bridgeStatus: 'no',
		startDate: at(days[2], '12:00'),
		endDate: at(days[2], '13:30'),
	},
	{
		id: 'quarterly',
		title: 'Quarterly planning',
		calendarId: team,
		status: 'no',
		bridgeStatus: 'no',
		startDate: at(days[2], '14:30'),
		endDate: at(days[2], '17:00'),
	},
	{
		id: 'dentist',
		title: 'Dentist',
		calendarId: personal,
		status: 'if-need-be',
		bridgeStatus: 'no',
		startDate: at(days[3], '16:00'),
		endDate: at(days[3], '17:00'),
	},
];

const accounts = [
	{
		id: caldavSource,
		label: 'Nextcloud',
		url: 'https://cloud.example.org/remote.php/dav',
		username: 'sam',
		// Relative to the capture, so the listing always reads "2 hours ago".
		lastCheck: {at: Date.now() - (2 * 60 * 60 * 1000), ok: true, calendars: 2},
	},
];

/**
 * Stands in for the background worker and extension storage, so the real
 * components can run in an ordinary page. It has to be installed before the
 * modules under it are imported: `browser-compat.ts` reads the global once, at
 * import time, which is why every entry point here imports its screen
 * dynamically.
 */
export function installFakeExtension(): void {
	const local: Record<string, unknown> = {
		selectedCalendars: {...calendarStatuses},
		selectedCalendarsVersion: 2,
	};
	const state = {listings: structuredClone(listings), local};

	const respond = async (message: {type: string; sourceId?: string; enabled?: boolean}) => {
		switch (message.type) {
			case 'listCalendarSources': {
				return {listings: state.listings};
			}

			case 'setSourceEnabled': {
				for (const listing of state.listings) {
					if (listing.sourceId === message.sourceId) {
						listing.enabled = message.enabled ?? true;
					}
				}

				return {listings: state.listings};
			}

			case 'listCalDavAccounts': {
				return {accounts};
			}

			default: {
				return {};
			}
		}
	};

	const fake = {
		runtime: {
			// The id the unpacked build gets from the manifest key, so the bridge
			// registration command on the options page is the real one.
			id: 'aiahhmaoljmnhhalhkdcioidlpkhbeof',
			sendMessage: respond,
		},
		storage: {
			local: {
				async get(keys: string | string[]) {
					const wanted = Array.isArray(keys) ? keys : [keys];
					return Object.fromEntries(wanted
						.filter(key => key in state.local)
						.map(key => [key, state.local[key]]));
				},
				async set(values: Record<string, unknown>) {
					Object.assign(state.local, values);
				},
			},
		},
		permissions: {
			async request() {
				return true;
			},
		},
	};

	(globalThis as Record<string, unknown>).chrome = fake;
}
