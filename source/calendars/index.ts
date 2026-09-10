import {type CalendarEvent, type SelectedCalendars, type TimeRange} from '../events.js';
import {nativeSource} from './native.js';
import {
	type CalendarSource, type SourceError, type SourceListing, nativeIdOf, sourceOf,
} from './types.js';
import {isSourceEnabled, loadSourceSettings} from './settings.js';
import {caldavSource, loadAccounts} from './caldav/index.js';

/**
 * Every source the extension currently has, newest configuration included.
 *
 * This is read per call rather than held in a module-level array because CalDAV
 * accounts are stored, not compiled in: a service worker that cached the list
 * would keep serving an account the user deleted minutes ago, and would never
 * see one they just added.
 */
async function allSources(): Promise<CalendarSource[]> {
	const accounts = await loadAccounts();
	return [nativeSource, ...accounts.map(account => caldavSource(account))];
}

/**
 * Duck-typed so that each source can throw its own error class and still carry
 * the "here is how to fix it" text — `NativeBridgeError.hint` today.
 */
function toSourceError(error: unknown): SourceError {
	const hint = (error as {hint?: unknown})?.hint;
	return {
		message: (error as Error)?.message ?? 'Unknown error',
		hint: typeof hint === 'string' ? hint : undefined,
	};
}

/**
 * Listing degrades: a source that is off is never contacted, and one that fails
 * reports its error in its own group rather than emptying the whole picker. A
 * missing native bridge must not hide working CalDAV calendars, and vice versa.
 */
export async function listSources(): Promise<SourceListing[]> {
	const [settings, sources] = await Promise.all([loadSourceSettings(), allSources()]);

	return Promise.all(sources.map(async source => {
		const listing = {
			sourceId: source.id,
			type: source.type,
			label: source.label,
			enabled: isSourceEnabled(settings, source.id),
			groups: [],
		} satisfies SourceListing;

		if (!listing.enabled) {
			return listing;
		}

		try {
			return {...listing, groups: await source.listGroups()};
		} catch (error) {
			return {...listing, error: toSourceError(error)};
		}
	}));
}

/**
 * Filling does *not* degrade: `Promise.all` propagates, so one unreachable
 * source aborts the fill. Dropping its events instead would leave the slots it
 * covered looking free, and the form would be submitted saying so.
 */
export async function getEventsForSelection(range: TimeRange, statuses: SelectedCalendars): Promise<CalendarEvent[]> {
	const [settings, sources] = await Promise.all([loadSourceSettings(), allSources()]);
	const wanted = new Map<string, string[]>();

	for (const [id, status] of Object.entries(statuses)) {
		const sourceId = sourceOf(id);
		if (status === 'off' || !isSourceEnabled(settings, sourceId)) {
			continue;
		}

		wanted.set(sourceId, [...wanted.get(sourceId) ?? [], nativeIdOf(id)]);
	}

	const results = await Promise.all([...wanted].map(async ([sourceId, nativeIds]) => {
		const source = sources.find(candidate => candidate.id === sourceId);
		// A selection can outlive its source — an account removed, or a key the
		// migration never reached. Silently ignoring it is right here: there is
		// nothing to ask, and the picker no longer offers it.
		return source ? source.getEvents(range, nativeIds) : [];
	}));

	return results.flat();
}

export {forgetSource, setSourceEnabled} from './settings.js';
export {loadCalendarStatuses, saveCalendarStatuses} from './settings.js';
