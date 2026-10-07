import {createApp} from '../calendar-app.js';
import {type CalendarEvent, type CalendarSlot} from '../events.js';
import {browserAPI} from '../browser-compat.js';
import {DirectFormFiller} from './form-filler.js';

/**
 * When2meet (www.when2meet.com) support.
 *
 * READING — the participant's own grid ("{name}'s Availability") is a set of
 * `div#YouTime{t}` cells carrying `data-time` (the slot start, in UNIX
 * seconds), `data-col` (the day) and `data-row` (the time of day). The times
 * are absolute instants: switching the page's time zone reloads the grid but
 * keeps the same `data-time` values. Slots have no explicit end, so a slot
 * lasts one grid step (the smallest gap between two slot starts — 15 minutes
 * on every poll we have seen).
 *
 * The grid only reflects the participant's answers once they have signed in:
 * before that every cell is drawn unavailable and `#YouGrid` is hidden. We
 * read the current answer from the cell colour, which the page's own
 * `ReColorIndividual()` sets inline (#339900 available, #ffdede not).
 *
 * WRITING — When2meet only knows available / unavailable, and saves on every
 * drag: `SelectFromHere` (mousedown on a cell) picks the direction from that
 * first cell, `SelectToHere` (mouseover) extends the rectangle, and
 * `document.onmouseup` (`SelectStop`) applies it and POSTs `SaveTimes.php`.
 * We replay those events on the page's own handlers rather than posting
 * ourselves, so the page's in-memory state, its group grid and the server all
 * stay in step. To keep the number of saves down, each day is filled in runs
 * of consecutive cells that should end up the same, one drag per run.
 *
 * Every save carries the participant's whole availability, so only the last
 * one to reach the server matters. Drags are spaced out, and the last one is
 * held back a little longer, so that it is also the last one saved.
 */

const AVAILABLE_COLOR = 'rgb(51, 153, 0)'; // #339900, as the browser reports it

/// Pause between two drags, i.e. between two saves.
const DRAG_DELAY_MS = 150;

/// Extra pause before the last drag, so that its save lands last.
const LAST_DRAG_DELAY_MS = 1000;

const cellQuery = '#YouGrid [id^="YouTime"][data-time]';

type Cell = {
	element: HTMLElement;
	col: number;
	row: number;
};

/** Thrown reasons travel back to the background worker, which notifies the user. */
class NoSlotsError extends Error {}

async function sleep(ms: number) {
	return new Promise(resolve => {
		globalThis.setTimeout(resolve, ms);
	});
}

function getCell(slotId: string): HTMLElement | undefined {
	return document.querySelector<HTMLElement>(`#YouTime${CSS.escape(slotId)}`) ?? undefined;
}

function isSignedIn(): boolean {
	const grid = document.querySelector<HTMLElement>('#YouGrid');
	return grid !== null && grid.style.display !== 'none';
}

/** Build the slot list from the participant grid. */
function buildSlots(): CalendarSlot[] {
	const times = [...document.querySelectorAll<HTMLElement>(cellQuery)]
		.map(element => Number(element.dataset.time))
		.filter(time => Number.isFinite(time) && time > 0)
		.sort((a, b) => a - b);

	// One grid step: the smallest gap between two consecutive slots.
	let step = Number.POSITIVE_INFINITY;
	for (let i = 1; i < times.length; i++) {
		const gap = times[i] - times[i - 1];
		if (gap > 0 && gap < step) {
			step = gap;
		}
	}

	if (!Number.isFinite(step)) {
		step = 15 * 60;
	}

	return times.map(time => ({
		id: String(time),
		startDate: new Date(time * 1000),
		endDate: new Date((time + step) * 1000),
		status: 'no',
	}));
}

class When2meetFormFiller extends DirectFormFiller {
	supportedStatuses: Array<CalendarSlot['status']> = ['yes', 'no'];

	constructor(private readonly slots: CalendarSlot[]) {
		super();
	}

	getWanted(slot: CalendarSlot): CalendarSlot['status'] {
		return slot.status === 'yes' ? 'yes' : 'no';
	}

	getStatus(slotId: string): CalendarSlot['status'] | undefined {
		const element = getCell(slotId);
		if (!element) {
			return undefined;
		}

		return element.style.backgroundColor === AVAILABLE_COLOR ? 'yes' : 'no';
	}

	changeStatus(slotId: string, _target: CalendarSlot['status']): void {
		// A one-cell drag toggles the cell.
		const element = getCell(slotId);
		if (element) {
			this.drag(element, element);
		}
	}

	extractSlots(): CalendarSlot[] {
		return this.slots;
	}

	async fill(slots: CalendarSlot[]) {
		if (!isSignedIn()) {
			throw new Error('Sign in on the When2meet page (your name, and a password if you want one), then fill again.');
		}

		const drags = this.planDrags(slots);
		console.log(`When2meet: ${drags.length} drag(s) to apply`);

		for (const [index, [from, to]] of drags.entries()) {
			// eslint-disable-next-line no-await-in-loop
			await sleep(index === drags.length - 1 ? LAST_DRAG_DELAY_MS : DRAG_DELAY_MS);
			this.drag(from, to);
		}

		const failed = slots.filter(slot => this.getStatus(slot.id) !== this.getWanted(slot));
		if (failed.length > 0) {
			throw new Error(`When2meet: ${failed.length} slot(s) did not take the wanted answer.`);
		}
	}

	/**
	 * Group the wanted answers into drags: within a day, a run of consecutive
	 * cells with the same wanted answer is set by one drag, started on the
	 * first cell of the run that is not already right — the start cell decides
	 * whether the drag marks cells available or unavailable.
	 */
	private planDrags(slots: CalendarSlot[]): Array<[HTMLElement, HTMLElement]> {
		const days = new Map<number, Array<Cell & {wanted: CalendarSlot['status']}>>();
		for (const slot of slots) {
			const element = getCell(slot.id);
			if (!element) {
				console.warn(`When2meet: no cell for slot ${slot.id}`);
				continue;
			}

			const col = Number(element.dataset.col);
			const row = Number(element.dataset.row);
			const day = days.get(col) ?? [];
			day.push({
				element, col, row, wanted: this.getWanted(slot),
			});
			days.set(col, day);
		}

		const drags: Array<[HTMLElement, HTMLElement]> = [];
		for (const cells of days.values()) {
			cells.sort((a, b) => a.row - b.row);

			let start = 0;
			while (start < cells.length) {
				let end = start;
				while (end + 1 < cells.length
					&& cells[end + 1].row === cells[end].row + 1
					&& cells[end + 1].wanted === cells[start].wanted) {
					end++;
				}

				const run = cells.slice(start, end + 1);
				const first = run.find(cell => this.getStatus(cell.element.dataset.time!) !== cell.wanted);
				if (first) {
					drags.push([first.element, run.at(-1)!.element]);
				}

				start = end + 1;
			}
		}

		return drags;
	}

	/** Replay a click-and-drag from one cell to another on the page's own handlers. */
	private drag(from: HTMLElement, to: HTMLElement) {
		const options = {bubbles: true, cancelable: true, view: globalThis.window};
		from.dispatchEvent(new MouseEvent('mousedown', options));
		to.dispatchEvent(new MouseEvent('mouseover', options));
		to.dispatchEvent(new MouseEvent('mouseup', options));
	}
}

function getSlots(): CalendarSlot[] {
	if (document.querySelector(cellQuery) === null) {
		throw new NoSlotsError('No When2meet availability grid on this page. Open the poll link, then try again.');
	}

	if (!isSignedIn()) {
		throw new NoSlotsError('Sign in on the When2meet page first (your name, and a password if you want one), then try again.');
	}

	const slots = buildSlots();
	if (slots.some(slot => slot.startDate.getUTCFullYear() < 2000)) {
		// "Days of the week" polls are laid out on placeholder dates.
		throw new NoSlotsError('When2meet "days of the week" polls are not supported: only polls on specific dates are.');
	}

	console.log(`Extracted ${slots.length} slots from When2meet poll`);
	return slots;
}

browserAPI.runtime.onMessage.addListener((message, _sender, sendResponse) => {
	if (message.type === 'get-range') {
		console.log('Getting When2meet slots...');
		let slots;
		try {
			slots = getSlots();
		} catch (error) {
			console.error(error);
			sendResponse({error: (error as Error).message});
			return false;
		}

		if (slots.length === 0) {
			sendResponse({error: 'This When2meet poll has no time slots to fill.'});
			return false;
		}

		const range = {startDate: slots[0].startDate, endDate: slots.at(-1)!.endDate};
		console.log(`When2meet slots: ${slots.length}`, range);
		sendResponse(range);
		return false;
	}

	if (message.type === 'runFill') {
		console.log('Running When2meet fill...');
		const slots = getSlots();
		const currentFiller = new When2meetFormFiller(slots);

		const events = (message.payload as CalendarEvent[]).map(event => ({
			...event,
			startDate: new Date(event.startDate),
			endDate: new Date(event.endDate),
		}));

		createApp(
			slots,
			events,
			async fillSlots => {
				console.log('Filling When2meet slots', fillSlots);
				return currentFiller.fill(fillSlots);
			},
			{supportedStatuses: currentFiller.supportedStatuses},
		);

		return false;
	}

	return false;
});
