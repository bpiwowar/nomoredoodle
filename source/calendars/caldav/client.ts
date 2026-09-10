import {type TimeRange} from '../../events.js';
import {
	type CalDavCredentials, type DavResource, CalDavError, asArray, davHref, davRequest, davResources,
} from './dav.js';
import {type IcsParseResult, parseCalendar} from './ics.js';

const xmlHeader = '<?xml version="1.0" encoding="utf-8"?>';
const namespaces = 'xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"';

const discoveryBody = `${xmlHeader}
<d:propfind ${namespaces}>
	<d:prop>
		<d:current-user-principal/>
		<d:resourcetype/>
		<c:calendar-home-set/>
	</d:prop>
</d:propfind>`;

const calendarListBody = `${xmlHeader}
<d:propfind ${namespaces}>
	<d:prop>
		<d:resourcetype/>
		<d:displayname/>
		<c:supported-calendar-component-set/>
	</d:prop>
</d:propfind>`;

/** `<C:expand>` asks the server to do the recurrence maths — see {@link fetchEvents}. */
function eventQueryBody(range: TimeRange): string {
	const start = toDavTime(range.startDate);
	const end = toDavTime(range.endDate);
	return `${xmlHeader}
<c:calendar-query ${namespaces}>
	<d:prop>
		<c:calendar-data>
			<c:expand start="${start}" end="${end}"/>
		</c:calendar-data>
	</d:prop>
	<c:filter>
		<c:comp-filter name="VCALENDAR">
			<c:comp-filter name="VEVENT">
				<c:time-range start="${start}" end="${end}"/>
			</c:comp-filter>
		</c:comp-filter>
	</c:filter>
</c:calendar-query>`;
}

/** CalDAV time-ranges are UTC iCalendar stamps: 20260920T070000Z. */
function toDavTime(date: Date): string {
	return date.toISOString().replaceAll(/[.:-]/g, '').replace(/\d{3}Z$/, 'Z');
}

function isCalendar(resource: DavResource): boolean {
	const type = resource.props.resourcetype;
	if (typeof type !== 'object' || type === null || !('calendar' in type)) {
		return false;
	}

	// A calendar that only holds tasks or contacts has nothing that blocks a slot.
	// The property is optional; when it is missing the collection takes everything.
	const components = resource.props['supported-calendar-component-set'];
	if (typeof components !== 'object' || components === null) {
		return true;
	}

	const names = asArray(components.comp).map((comp: any) => String(comp?.['@name'] ?? '').toUpperCase());
	return names.length === 0 || names.includes('VEVENT');
}

function lastPathSegment(url: string): string {
	const segments = new URL(url).pathname.split('/').filter(Boolean);
	return decodeURIComponent(segments.at(-1) ?? url);
}

export type DiscoveredCalendar = {url: string; title: string};

/**
 * Walks the RFC 4791 chain from whatever the user typed to the collection that
 * holds their calendars: URL → principal → calendar-home-set.
 *
 * Providers publish wildly different entry points — iCloud wants the numeric
 * principal path, Nextcloud a per-user one, Fastmail only the bare host — so
 * each step is attempted and the first that answers wins, with
 * `/.well-known/caldav` (RFC 6764) as the fallback for a bare host name.
 */
export async function discoverHomeSet(account: CalDavCredentials): Promise<string> {
	const attempted = new Set<string>();

	const probe = async (url: string): Promise<string | undefined> => {
		if (attempted.has(url)) {
			return undefined;
		}

		attempted.add(url);
		const result = await davRequest(account, 'PROPFIND', url, {body: discoveryBody});
		const resources = davResources(result);

		for (const resource of resources) {
			const home = davHref(resource.props['calendar-home-set'], result.url);
			if (home) {
				return home;
			}
		}

		// The address was already a calendar (or a folder of them): treat where it
		// lives as the home set, so the listing below finds it and its siblings.
		if (resources.some(resource => isCalendar(resource))) {
			return new URL('.', result.url).href;
		}

		for (const resource of resources) {
			const principal = davHref(resource.props['current-user-principal'], result.url);
			if (principal && !attempted.has(principal)) {
				// Sequential on purpose: each hop is only worth making if the one
				// before it failed to produce a home set, and a server should not be
				// hit with speculative PROPFINDs for principals we may not need.
				// eslint-disable-next-line no-await-in-loop
				const home = await probe(principal);
				if (home) {
					return home;
				}
			}
		}

		return undefined;
	};

	const entered = new URL(account.url);
	const wellKnown = new URL('/.well-known/caldav', entered).href;

	let firstError: Error | undefined;
	for (const start of [entered.href, wellKnown]) {
		try {
			// Same reasoning: /.well-known is a fallback, not a second guess to race.
			// eslint-disable-next-line no-await-in-loop
			const home = await probe(start);
			if (home) {
				return home;
			}
		} catch (error) {
			// A wrong password fails the same way at every entry point, so there is
			// nothing to gain from trying the next one — and its own error would
			// replace the one that actually explains the problem. Only a 401 says
			// that: a 403 can be one path being closed while another is open.
			if (error instanceof CalDavError && error.status === 401) {
				throw error;
			}

			firstError ??= error as Error;
		}
	}

	if (firstError) {
		throw firstError;
	}

	throw new CalDavError(
		`No calendars are published at ${account.url}.`,
		[
			'The server answered, but it does not advertise a CalDAV calendar home there.',
			'',
			'Try the address your calendar app uses. Common shapes:',
			'',
			'  • Nextcloud — https://cloud.example.org/remote.php/dav',
			'  • Baïkal / SabreDAV — https://dav.example.org/dav.php',
			'  • Radicale — https://radicale.example.org/',
			'  • iCloud — https://caldav.icloud.com',
			'  • Fastmail — https://caldav.fastmail.com',
		].join('\n'),
	);
}

export async function listCalendars(account: CalDavCredentials, homeSet: string): Promise<DiscoveredCalendar[]> {
	const result = await davRequest(account, 'PROPFIND', homeSet, {depth: '1', body: calendarListBody});

	return davResources(result)
		.filter(resource => isCalendar(resource))
		.map(resource => ({
			url: resource.href,
			title: String(resource.props.displayname ?? '').trim() || lastPathSegment(resource.href),
		}));
}

/**
 * Asks the server to expand recurrences itself, which is the whole reason this
 * stays cheap: without `<C:expand>` the client would have to hold every RRULE,
 * EXDATE and RECURRENCE-ID override in the account and replay them.
 *
 * `expand` is a MUST in RFC 4791, but a server may ignore an element it does not
 * implement and return the master events instead. Those are detected and
 * refused rather than used: a weekly meeting returned once would leave every
 * later week looking free, and the poll would be submitted saying so.
 */
export async function fetchEvents(
	account: CalDavCredentials,
	calendarUrl: string,
	calendarId: string,
	range: TimeRange,
): Promise<IcsParseResult> {
	const result = await davRequest(account, 'REPORT', calendarUrl, {
		depth: '1',
		body: eventQueryBody(range),
	});

	const parsed = davResources(result)
		.map(resource => resource.props['calendar-data'])
		.filter((data): data is string => typeof data === 'string' && data.length > 0)
		.map(data => parseCalendar(data, calendarId));

	return {
		events: parsed.flatMap(one => one.events),
		recurringMasters: parsed.reduce((total, one) => total + one.recurringMasters, 0),
	};
}
