import {createApp} from '../calendar-app.js';
import {type CalendarEvent, type CalendarSlot} from '../events.js';
import {browserAPI} from '../browser-compat.js';
import {ApiFormFiller} from './form-filler.js';

/**
 * Timeful (timeful.app, formerly schej.it) support.
 *
 * Timeful renders a continuous availability grid and documents a plugin API
 * over `window.postMessage`
 * (https://github.com/schej-it/timeful.app/blob/main/PLUGIN_API_README.md):
 * `get-slots` (read every respondent's availability) and `set-slots`
 * (overwrite the current user's availability).
 *
 * READING — we reconstruct the candidate grid ourselves: the plugin API never
 * exposes the empty grid (slots nobody picked), so we read the event
 * definition (`dates`, `duration`, `type`, `daysOnly`, `timeIncrement`) from
 * Timeful's REST endpoint `/api/events/{shortId}`. The grid anchors are
 * absolute UTC instants, so each slot is a real `Date` range.
 *
 * WRITING — we POST directly to `/api/events/{id}/response` instead of using
 * the documented `set-slots` plugin call. Why: `set-slots` is implemented in
 * `Event.vue` against the *rendered, paginated* grid — `getAllValidTimeRanges()`
 * only covers `this.days`, which is `allDays.slice(page * maxDaysPerPage, …)`
 * with `maxDaysPerPage = 7` on desktop. So `set-slots` can only fill the 7
 * days currently visible, rejects any slot outside that page ("falls outside
 * the event's date/time range"), and each call OVERWRITES the whole response —
 * so it cannot fill a multi-week event even page-by-page. Internally
 * `set-slots` just does `POST /events/{id}/response` with
 * `{availability, ifNeeded, guest, name, email}` (plain JSON, cookie auth, no
 * CSRF). We build that payload for ALL dates and POST it directly, which is
 * exactly what `set-slots` does minus the pagination cap. Availability is a
 * flat array of UTC `timeIncrement`-aligned slot-start timestamps, matching the
 * shape Timeful's own save uses.
 *
 * {@link TimefulFormFiller} subclasses the generic {@link ApiFormFiller}: the
 * base owns the non-click "build grid then batch-fill" contract; this class
 * owns the schej-specific REST shape.
 */

type TimefulEvent = {
	_id?: string; // Mongo id; key for the `{_id}.guestName` localStorage entry
	shortId?: string;
	dates?: string[]; // ISO UTC anchors, one per day (window start for timed events)
	duration?: number; // Daily window length in hours
	timeIncrement?: number; // Slot size in minutes (15, 30 or 60)
	type?: string; // 'specific_dates' | 'dow' | ...
	daysOnly?: boolean; // Whole-day availability (no times)
	hasSpecificTimes?: boolean;
	times?: unknown;
	collectEmails?: boolean; // Whether a guest must provide an email
};

// Stored across fills so a guest only types their details once.
const GUEST_NAME_KEY = 'timefulGuestName';
const GUEST_EMAIL_KEY = 'timefulGuestEmail';

class TimefulFormFiller extends ApiFormFiller {
	supportedStatuses: Array<CalendarSlot['status']> = ['yes', 'if-need-be', 'no'];

	private slots: CalendarSlot[] | undefined;
	private eventPromise: Promise<TimefulEvent | undefined> | undefined;

	async extractSlots(): Promise<CalendarSlot[]> {
		if (this.slots) {
			return this.slots;
		}

		const event = await this.fetchEvent();
		if (!event?.dates?.length) {
			console.log('Timeful: no event dates found');
			this.slots = [];
			return this.slots;
		}

		this.slots = this.buildSlots(event);
		console.log(`Timeful: reconstructed ${this.slots.length} candidate slots`);
		return this.slots;
	}

	async fill(slots: CalendarSlot[]): Promise<void> {
		// Each kept slot is already one `timeIncrement`-aligned cell, so its
		// start (in UTC) is exactly one availability timestamp.
		const availability: string[] = [];
		const ifNeeded: string[] = [];
		for (const slot of slots) {
			if (slot.status === 'yes') {
				availability.push(slot.startDate.toISOString());
			} else if (slot.status === 'if-need-be' || slot.status === 'could-be') {
				ifNeeded.push(slot.startDate.toISOString());
			}
		}

		console.log(`Filling Timeful: ${availability.length} available, ${ifNeeded.length} if-needed`);
		await this.submitResponse(availability, ifNeeded);
	}

	/**
	 * Write the response directly to `/api/events/{id}/response` (see the file
	 * header for why we bypass the paginated `set-slots` plugin call). Logged-in
	 * users are identified by their session cookie; guests must supply a name
	 * (and an email when the event collects them).
	 */
	private async submitResponse(availability: string[], ifNeeded: string[]): Promise<void> {
		const event = await this.fetchEvent();
		const shortId = this.getShortId();
		if (!event || !shortId) {
			throw new Error('Timeful: could not resolve the event to fill.');
		}

		const payload: Record<string, unknown> = {availability, ifNeeded};

		if (await this.isLoggedIn()) {
			payload.guest = false;
		} else {
			payload.guest = true;
			payload.name = await this.resolveGuestName(event);
			if (event.collectEmails) {
				payload.email = await this.resolveGuestEmail();
			}
		}

		const sanitizedId = shortId.split('.').join('');
		const response = await fetch(`/api/events/${sanitizedId}/response`, {
			method: 'POST',
			credentials: 'include',
			headers: {'Content-Type': 'application/json'},
			body: JSON.stringify(payload),
		});

		if (!response.ok) {
			const body = await response.text();
			throw new Error(`Timeful: failed to save response (${response.status}). ${body.slice(0, 300)}`);
		}
	}

	/** Whether a Timeful account session is active (so we submit as that user). */
	private async isLoggedIn(): Promise<boolean> {
		try {
			const response = await fetch('/api/user/profile', {credentials: 'include', headers: {accept: 'application/json'}});
			if (!response.ok) {
				return false;
			}

			const user = await response.json() as {_id?: string};
			return Boolean(user?._id);
		} catch {
			return false;
		}
	}

	/**
	 * Resolve the guest name: reuse Timeful's own stored name for this event,
	 * then our cached name, otherwise ask once and remember it.
	 */
	private async resolveGuestName(event: TimefulEvent): Promise<string> {
		const timefulName = event._id ? globalThis.localStorage.getItem(`${event._id}.guestName`)?.trim() : undefined;
		if (timefulName) {
			return timefulName;
		}

		const stored = await browserAPI.storage.local.get(GUEST_NAME_KEY) as Record<string, string>;
		if (stored[GUEST_NAME_KEY]) {
			return stored[GUEST_NAME_KEY];
		}

		// eslint-disable-next-line no-alert
		const name = globalThis.prompt('Timeful needs a name to submit your availability as a guest:')?.trim();
		if (!name) {
			throw new Error('Timeful: a guest name is required to fill this poll.');
		}

		await browserAPI.storage.local.set({[GUEST_NAME_KEY]: name});
		return name;
	}

	/** Resolve the guest email for events that collect emails (cached or asked once). */
	private async resolveGuestEmail(): Promise<string> {
		const stored = await browserAPI.storage.local.get(GUEST_EMAIL_KEY) as Record<string, string>;
		if (stored[GUEST_EMAIL_KEY]) {
			return stored[GUEST_EMAIL_KEY];
		}

		// eslint-disable-next-line no-alert
		const email = globalThis.prompt('This poll also requires your email:')?.trim();
		if (!email) {
			throw new Error('Timeful: an email is required to fill this poll.');
		}

		await browserAPI.storage.local.set({[GUEST_EMAIL_KEY]: email});
		return email;
	}

	/** The event short id from the `/e/{shortId}` URL. */
	private getShortId(): string | undefined {
		return /\/e\/([^/?#]+)/.exec(globalThis.location.pathname)?.[1];
	}

	/** Fetch (and cache) the event definition from the REST API. */
	private async fetchEvent(): Promise<TimefulEvent | undefined> {
		this.eventPromise ??= (async () => {
			const shortId = this.getShortId();
			if (!shortId) {
				return undefined;
			}

			try {
				const response = await fetch(`/api/events/${shortId}`, {headers: {accept: 'application/json'}});
				if (!response.ok) {
					console.error(`Timeful: failed to fetch event (${response.status})`);
					return undefined;
				}

				return await response.json() as TimefulEvent;
			} catch (error) {
				console.error('Timeful: error fetching event', error);
				return undefined;
			}
		})();

		return this.eventPromise;
	}

	/**
	 * Reconstruct the candidate slot grid from the event definition.
	 * Each `dates` entry is the absolute UTC instant of that day's window start
	 * (for daysOnly events it is the day itself).
	 */
	private buildSlots(event: TimefulEvent): CalendarSlot[] {
		const dates = event.dates ?? [];
		const slots: CalendarSlot[] = [];

		if (event.daysOnly) {
			// Whole-day availability: one slot per date spanning 24h.
			for (const iso of dates) {
				const startDate = new Date(iso);
				if (Number.isNaN(startDate.getTime())) {
					continue;
				}

				const endDate = new Date(startDate.getTime() + (24 * 60 * 60 * 1000));
				slots.push({
					id: startDate.toISOString(), startDate, endDate, status: 'no',
				});
			}

			return slots;
		}

		const increment = event.timeIncrement ?? 30; // Minutes
		const durationHours = event.duration ?? 24;
		const slotsPerDay = Math.max(1, Math.round((durationHours * 60) / increment));
		const incrementMs = increment * 60 * 1000;

		if (event.hasSpecificTimes) {
			console.warn('Timeful: event has per-day specific times; falling back to a uniform window based on `duration`.');
		}

		for (const iso of dates) {
			const dayStart = new Date(iso);
			if (Number.isNaN(dayStart.getTime())) {
				continue;
			}

			for (let i = 0; i < slotsPerDay; i++) {
				const startDate = new Date(dayStart.getTime() + (i * incrementMs));
				const endDate = new Date(startDate.getTime() + incrementMs);
				slots.push({
					id: startDate.toISOString(), startDate, endDate, status: 'no',
				});
			}
		}

		return slots;
	}
}

let filler: TimefulFormFiller | undefined;

function getFiller(): TimefulFormFiller {
	filler ??= new TimefulFormFiller();
	return filler;
}

browserAPI.runtime.onMessage.addListener((message, _sender, sendResponse) => {
	if (message.type === 'get-range') {
		console.log('Getting Timeful slots...');
		(async () => {
			const slots = await getFiller().extractSlots();
			if (slots.length === 0) {
				console.error('No Timeful slots found');
				sendResponse(undefined);
				return;
			}

			const range = {startDate: slots[0].startDate, endDate: slots[0].endDate};
			for (const slot of slots) {
				if (range.startDate > slot.startDate) {
					range.startDate = slot.startDate;
				}

				if (range.endDate < slot.endDate) {
					range.endDate = slot.endDate;
				}
			}

			console.log(`Timeful slots: ${slots.length}`, range);
			sendResponse(range);
		})();

		return true; // Async response
	}

	if (message.type === 'runFill') {
		console.log('Running Timeful fill...');
		(async () => {
			const currentFiller = getFiller();
			const slots = await currentFiller.extractSlots();
			if (slots.length === 0) {
				return;
			}

			const events = (message.payload as CalendarEvent[]).map(event => ({
				...event,
				startDate: new Date(event.startDate),
				endDate: new Date(event.endDate),
			}));

			createApp(
				slots,
				events,
				async fillSlots => currentFiller.fill(fillSlots),
				{supportedStatuses: currentFiller.supportedStatuses},
			);
		})();

		return true;
	}

	return false;
});
