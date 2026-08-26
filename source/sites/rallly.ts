import {createApp} from '../calendar-app.js';
import {type CalendarEvent, type CalendarSlot} from '../events.js';
import {browserAPI} from '../browser-compat.js';
import {FormFiller} from './form-filler.js';

/**
 * Rallly (app.rallly.co) support.
 *
 * READING — the candidate grid comes from Rallly's own tRPC query
 * `polls.get`, not from the DOM: the option cells only carry localized
 * day/month/time labels, whereas the query returns each option as
 * `{id, startTime, duration}`. How to read those depends on the poll
 * (see `createOptionsContextValue` in Rallly's `poll-context.tsx`):
 *  - `duration > 0` and `timeZone` set: `startTime` is an absolute instant.
 *  - `duration > 0` and `timeZone` null: the times are floating — they are
 *    stored as UTC wall times and shown unshifted, so the UTC clock parts are
 *    the local clock parts.
 *  - `duration === 0`: an all-day option, also floating; it covers the whole
 *    calendar day named by the UTC parts.
 *
 * WRITING — we click the vote controls and let the user press Continue/Save
 * and enter their name, as on Doodle. Rallly renders two variants of the same
 * control (`data-testid="vote-selector"`), picked by a 640px breakpoint in
 * `responsive-results.tsx`, so {@link RalllyFormFiller} delegates to a
 * {@link VoteControl} strategy per variant:
 *  - desktop: a single button that *cycles* pending → yes → ifNeedBe → no.
 *  - mobile: a radiogroup whose three radios are always in that same order.
 *
 * Both read the current vote without touching any localized text: the desktop
 * icon's colour class comes from `voteIconVariants` (`packages/ui/src/
 * vote-icon.tsx`) and the mobile radios expose `aria-checked`.
 */

type RalllyOption = {
	id: string;
	startTime: string;
	duration: number; // Minutes; 0 means an all-day option
};

type RalllyPoll = {
	id: string;
	timeZone: string | undefined; // Null for floating times
	options: RalllyOption[];
};

/** Rallly's vote types, in the order its controls present/cycle through them. */
const voteTypes = ['yes', 'ifNeedBe', 'no'] as const;
type RalllyVote = typeof voteTypes[number];

const vote2Status: Record<RalllyVote, CalendarSlot['status']> = {
	yes: 'yes',
	ifNeedBe: 'if-need-be',
	no: 'no',
};

function status2Vote(status: CalendarSlot['status']): RalllyVote {
	switch (status) {
		case 'yes': {
			return 'yes';
		}

		case 'if-need-be':
		case 'could-be': {
			return 'ifNeedBe';
		}

		case 'no': {
			return 'no';
		}
	}
}

const voteSelectorQuery = '[data-testid="vote-selector"]';

/** Tailwind colour classes of the vote icon, one per vote type. */
const iconClass2Vote: Record<string, RalllyVote> = {
	'text-green-500': 'yes',
	'text-amber-400': 'ifNeedBe',
	'text-zinc-500': 'no',
	// `text-zinc-300` is the pending icon: no vote yet.
};

/**
 * One option's vote control. The two Rallly layouts differ in how a vote is
 * read and set, but not in how the filler drives them.
 */
type VoteControl = {
	/** The current vote, or undefined while the option is still pending. */
	read(element: HTMLElement): RalllyVote | undefined;
	/**
	 * Move one step towards `target`. The desktop control only cycles, so this
	 * may need to be called several times; {@link FormFiller} keeps clicking
	 * until the wanted status is observed.
	 */
	step(element: HTMLElement, target: RalllyVote): void;
};

/** Desktop: a lone button cycling pending → yes → ifNeedBe → no. */
const cyclingButtonControl: VoteControl = {
	read(element) {
		const icon = element.querySelector('svg');
		if (!icon) {
			return undefined;
		}

		for (const [className, vote] of Object.entries(iconClass2Vote)) {
			if (icon.classList.contains(className)) {
				return vote;
			}
		}

		return undefined;
	},
	step(element) {
		element.click();
	},
};

/** Mobile: a radiogroup whose radios follow {@link voteTypes}. */
const radioGroupControl: VoteControl = {
	read(element) {
		const radios = element.querySelectorAll('[role="radio"]');
		for (const [index, radio] of radios.entries()) {
			if (radio.getAttribute('aria-checked') === 'true') {
				return voteTypes[index];
			}
		}

		return undefined;
	},
	step(element, target) {
		const radio = element.querySelectorAll<HTMLElement>('[role="radio"]')[voteTypes.indexOf(target)];
		if (radio) {
			radio.click();
		} else {
			console.error(`Rallly: no radio for vote ${target}`);
		}
	},
};

function getControl(element: HTMLElement): VoteControl {
	return element.getAttribute('role') === 'radiogroup' ? radioGroupControl : cyclingButtonControl;
}

/**
 * The urlId of the poll. Both the participant's `/invite/{urlId}` page and the
 * organizer's `/poll/{urlId}` page name the same poll and render the same
 * voting form.
 */
function getUrlId(): string | undefined {
	return /\/(?:invite|poll)\/([^/?#]+)/.exec(globalThis.location.pathname)?.[1];
}

async function fetchPoll(): Promise<RalllyPoll | undefined> {
	const urlId = getUrlId();
	if (!urlId) {
		return undefined;
	}

	const input = encodeURIComponent(JSON.stringify({json: {urlId}}));
	try {
		const response = await fetch(`/api/trpc/polls.get?input=${input}`, {
			credentials: 'include',
			headers: {accept: 'application/json'},
		});
		if (!response.ok) {
			console.error(`Rallly: failed to fetch poll (${response.status})`);
			return undefined;
		}

		const body = await response.json() as {result?: {data?: {json?: RalllyPoll}}};
		return body.result?.data?.json;
	} catch (error) {
		console.error('Rallly: error fetching poll', error);
		return undefined;
	}
}

/** Read a floating time: its UTC clock parts are meant as local clock parts. */
function floatingToLocal(date: Date): Date {
	return new Date(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), date.getUTCHours(), date.getUTCMinutes(), 0, 0);
}

function buildSlots(poll: RalllyPoll): CalendarSlot[] {
	const slots: CalendarSlot[] = [];

	for (const option of poll.options) {
		const startTime = new Date(option.startTime);
		if (Number.isNaN(startTime.getTime())) {
			console.warn(`Rallly: could not parse option start time "${option.startTime}"`);
			continue;
		}

		if (option.duration <= 0) {
			// All-day option: the UTC parts name the calendar day.
			const startDate = floatingToLocal(startTime);
			startDate.setHours(0, 0, 0, 0);
			const endDate = new Date(startDate);
			endDate.setDate(endDate.getDate() + 1);
			slots.push({
				id: option.id, startDate, endDate, status: 'no',
			});
			continue;
		}

		const startDate = poll.timeZone ? startTime : floatingToLocal(startTime);
		const endDate = new Date(startDate.getTime() + (option.duration * 60 * 1000));
		slots.push({
			id: option.id, startDate, endDate, status: 'no',
		});
	}

	return slots;
}

class RalllyFormFiller extends FormFiller {
	supportedStatuses: Array<CalendarSlot['status']> = ['yes', 'if-need-be', 'no'];

	/// Option ids, in the order Rallly renders their vote controls.
	private readonly optionIds: string[];

	/// Last status seen per option, so the observer only reports real changes.
	private readonly lastStatuses = new Map<string, CalendarSlot['status'] | undefined>();

	private observer: MutationObserver | undefined;

	constructor(private readonly slots: CalendarSlot[]) {
		super();
		this.optionIds = slots.map(slot => slot.id);

		this.observe();
	}

	/**
	 * Watch the votes. React swaps the icon (desktop) or flips `aria-checked`
	 * (mobile) once the voting form state updates, which is what tells us a
	 * click landed. Re-arming is safe: the current votes are snapshotted first,
	 * so only later changes are reported.
	 */
	observe() {
		for (const id of this.optionIds) {
			this.lastStatuses.set(id, this.getStatus(id));
		}

		this.observer ??= new MutationObserver(() => {
			this.reportChanges();
		});
		this.observer.observe(document.body, {
			subtree: true,
			childList: true,
			attributes: true,
			attributeFilter: ['class', 'viewBox', 'aria-checked'],
		});
	}

	close() {
		console.info('Disconnecting Rallly observer');
		this.observer?.disconnect();
		this.observer = undefined;
	}

	async fill(slots: CalendarSlot[]) {
		// The overlay can be filled more than once; the previous run left the
		// observer disconnected.
		this.observe();
		return super.fill(slots);
	}

	getStatus(slotId: string): CalendarSlot['status'] | undefined {
		const element = this.getElement(slotId);
		if (!element) {
			return undefined;
		}

		const vote = getControl(element).read(element);
		return vote ? vote2Status[vote] : undefined;
	}

	changeStatus(slotId: string, target: CalendarSlot['status']): void {
		const element = this.getElement(slotId);
		if (!element) {
			console.error(`Rallly: no vote control for option ${slotId}`);
			return;
		}

		getControl(element).step(element, status2Vote(target));
	}

	extractSlots(): CalendarSlot[] {
		return this.slots;
	}

	/** The vote control of an option, matched by its position in the grid. */
	private getElement(slotId: string): HTMLElement | undefined {
		const index = this.optionIds.indexOf(slotId);
		if (index === -1) {
			return undefined;
		}

		const elements = document.querySelectorAll<HTMLElement>(voteSelectorQuery);
		if (elements.length !== this.optionIds.length) {
			console.warn(`Rallly: ${elements.length} vote controls for ${this.optionIds.length} options`);
			return undefined;
		}

		return elements[index];
	}

	/** Push the options whose vote changed since we last looked. */
	private reportChanges(): void {
		for (const id of this.optionIds) {
			const status = this.getStatus(id);
			if (this.lastStatuses.get(id) === status) {
				continue;
			}

			this.lastStatuses.set(id, status);
			if (status) {
				this.changedStatus(id, status);
			}
		}
	}
}

let slots: CalendarSlot[] | undefined;

/**
 * The vote controls only exist while the poll is being answered. A poll that
 * is closed, or already answered by this user, starts in view mode.
 */
function isVotingFormOpen(): boolean {
	return document.querySelector(voteSelectorQuery) !== null;
}

async function getSlots(): Promise<CalendarSlot[] | undefined> {
	if (slots) {
		return slots;
	}

	if (!isVotingFormOpen()) {
		console.error('Rallly: no voting form on this page');
		return undefined;
	}

	const poll = await fetchPoll();
	if (!poll?.options?.length) {
		console.error('Rallly: no poll options found');
		return undefined;
	}

	slots = buildSlots(poll);
	console.log(`Extracted ${slots.length} slots from Rallly poll`);

	return slots;
}

browserAPI.runtime.onMessage.addListener((message, _sender, sendResponse) => {
	if (message.type === 'get-range') {
		console.log('Getting Rallly slots...');
		(async () => {
			const slots = await getSlots();
			if (!slots || slots.length === 0) {
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

			console.log(`Rallly slots: ${slots.length}`, range);
			sendResponse(range);
		})();

		return true; // Async response
	}

	if (message.type === 'runFill') {
		console.log('Running Rallly fill...');
		(async () => {
			const slots = await getSlots();
			if (!slots) {
				return;
			}

			// A fresh filler per run: it snapshots the current votes and starts
			// its own observer, which is disconnected once the fill is done.
			const currentFiller = new RalllyFormFiller(slots);

			const events = (message.payload as CalendarEvent[]).map(event => ({
				...event,
				startDate: new Date(event.startDate),
				endDate: new Date(event.endDate),
			}));

			createApp(
				slots,
				events,
				async fillSlots => {
					console.log('Filling Rallly slots', fillSlots);
					return currentFiller.fill(fillSlots).finally(() => {
						currentFiller.close();
					});
				},
				{supportedStatuses: currentFiller.supportedStatuses},
			);
		})();

		return true;
	}

	return false;
});
