import {browserAPI} from '../browser-compat.js';
import {type SelectedCalendars} from '../events.js';
import {calendarId, nativeSourceId, sourceOf} from './types.js';

export type SourceSettings = Record<string, {enabled: boolean}>;

/** Bumped when the shape of the stored selection changes; see {@link loadCalendarStatuses}. */
const selectionVersion = 2;

/**
 * Until v2 the selection was keyed by the bare EventKit identifier, which stops
 * being unique as soon as there is a second source. Every key gains its source
 * prefix.
 *
 * The version is stored explicitly rather than inferred from whether a key
 * already looks namespaced, because getting this wrong is invisible: unknown
 * keys read back as "off", no events reach `calculateSlotStatus`, and the fill
 * then answers "yes" to every slot and submits it. A silently wrong poll is a
 * worse outcome than any error, so the migration does not guess.
 */
export async function loadCalendarStatuses(): Promise<SelectedCalendars> {
	const stored = await browserAPI.storage.local.get(['selectedCalendars', 'selectedCalendarsVersion']) as {
		selectedCalendars?: SelectedCalendars;
		selectedCalendarsVersion?: number;
	};
	const statuses = stored.selectedCalendars ?? {};

	if ((stored.selectedCalendarsVersion ?? 1) >= selectionVersion) {
		return statuses;
	}

	const migrated: SelectedCalendars = {};
	for (const [id, status] of Object.entries(statuses)) {
		migrated[calendarId(nativeSourceId, id)] = status;
	}

	// Announced because it rewrites existing state exactly once, and its failure
	// mode is silent: without a line here there is nothing to check afterwards.
	console.log(`Migrating ${Object.keys(migrated).length} calendar selection(s) to source-namespaced ids`, migrated);

	await browserAPI.storage.local.set({
		selectedCalendars: migrated,
		selectedCalendarsVersion: selectionVersion,
	});
	return migrated;
}

export async function saveCalendarStatuses(statuses: SelectedCalendars) {
	await browserAPI.storage.local.set({
		selectedCalendars: statuses,
		selectedCalendarsVersion: selectionVersion,
	});
}

export async function loadSourceSettings(): Promise<SourceSettings> {
	const {sourceSettings = {}} = await browserAPI.storage.local.get('sourceSettings') as {sourceSettings?: SourceSettings};
	return sourceSettings;
}

/** A source nobody has touched is on: the native bridge must keep working untouched. */
export function isSourceEnabled(settings: SourceSettings, sourceId: string): boolean {
	return settings[sourceId]?.enabled ?? true;
}

export async function setSourceEnabled(sourceId: string, enabled: boolean) {
	const settings = await loadSourceSettings();
	await browserAPI.storage.local.set({
		sourceSettings: {...settings, [sourceId]: {enabled}},
	});
}

/**
 * Drops everything remembered about a source. Called when a CalDAV account is
 * deleted: the statuses would otherwise sit in storage forever, keyed by an id
 * nothing can resolve, and reappear if the same account id were ever reused.
 */
export async function forgetSource(sourceId: string) {
	const [statuses, settings] = await Promise.all([loadCalendarStatuses(), loadSourceSettings()]);

	const kept: SelectedCalendars = {};
	for (const [id, status] of Object.entries(statuses)) {
		if (sourceOf(id) !== sourceId) {
			kept[id] = status;
		}
	}

	const {[sourceId]: _removed, ...remaining} = settings;
	await browserAPI.storage.local.set({
		selectedCalendars: kept,
		selectedCalendarsVersion: selectionVersion,
		sourceSettings: remaining,
	});
}
