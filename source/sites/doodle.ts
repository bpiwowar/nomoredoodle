import {createApp} from '../calendar-app.js';
import {type CalendarSlot, TimeRange} from '../events.js';


const status2Attribute: {[key in CalendarSlot['status']]: CalendarSlot['status']} = {
	no: 'no',
	'could-be': 'if-need-be',
	'if-need-be': 'if-need-be',
	yes: 'yes',
};

/**
 * This class basically monitors changes until we get it right
 */
abstract class FormFiller {
	registeredSlots: Record<string, {
		id: string;
		wanted: CalendarSlot['status'];
		seen: Set<CalendarSlot['status']>;
	}> = {};

	// Can be overwritten when less status in target form than
	// possible
	getWanted(slot: CalendarSlot) {
		return slot.status;
	}

	close() {
		// Do nothing
	}

	changedStatus(slot_id: string, status: CalendarSlot['status']) {
		console.log(this.registeredSlots);
		const item = this.registeredSlots[slot_id];
		if (!item) {
			console.error(`${slot_id} is not registered anymore`);
			return;
		}

		if (status == item.wanted) {
			console.log(`Status for ${slot_id} matches ${item.wanted}`);
			delete this.registeredSlots[slot_id];
			console.log('Delete registered', this.registeredSlots);
			return;
		}

		if (item.seen.has(status)) {
			console.error(`Status ${status} has already been seen for ${slot_id}: stopping`);
			return;
		}

		console.log(`Changing the status of ${slot_id}`);
		this.changeStatus(slot_id, item.wanted);
	}

	async fill(slots: CalendarSlot[]) {
		for (const slot of slots) {
			const status = this.getStatus(slot.id);
			if (!status) {
				console.error(`Cannot determine ${slot.id} status`);
			} else if (status == slot.status) {
				console.log(`${slot.id} status has already status ${status}`);
			} else {
				this.registeredSlots[slot.id] = {
					id: slot.id,
					wanted: this.getWanted(slot),
					seen: new Set([status]),
				};
				console.log(`Register ${slot.id} => ${slot.status}`);
				this.changeStatus(slot.id, slot.status);
				console.log(this.registeredSlots);
			}
		}

		function handler(_this: FormFiller, resolve: () => void, reject: () => void) {
			console.log('Checking....');
			if (Object.keys(_this.registeredSlots).length === 0) {
				console.log('All good, exiting');

				resolve();
			}
		}

		return new Promise<void>((resolve, reject) => {
			const interval = setInterval(handler, 500, this, () => {
				clearInterval(interval);
				resolve();
			}, () => {
				clearInterval(interval);
				reject();
			});
		});
	}

	abstract getStatus(slot_id: string): CalendarSlot['status'] | undefined;
	abstract changeStatus(slot_id: string, target: CalendarSlot['status']): void;
	abstract extractSlots(): CalendarSlot[];
}

abstract class DoodleFormFiller extends FormFiller {
	container: HTMLElement;
	observer: null | MutationObserver;

	getWanted(slot: CalendarSlot) {
		return status2Attribute[slot.status];
	}

	constructor(container: HTMLElement) {
		super();

		this.container = container;

		this.observer = new MutationObserver(mutations => {
			for (const mutation of mutations) {
				console.log('Mutation detected:', mutation);
				if (mutation.target.nodeType == Node.ELEMENT_NODE) {
					const target = mutation.target as HTMLElement;
					let vote_id = target.dataset.voteId;
					if (vote_id) {
						const new_status = this.getStatus(vote_id);
						console.log(`${vote_id} has changed status: ${new_status}`);
						if (new_status) {
							this.changedStatus(vote_id, new_status);
						}
					}

					const test_id = target.dataset.testid
					vote_id = test_id?.split('-')?.pop();
					if (vote_id) {
						const new_status = this.getStatus(vote_id);
						console.log(`${vote_id} has changed status: ${new_status}`);
						if (new_status) {
							this.changedStatus(vote_id, new_status);
						}
					}
				}
			}
		});

		this.observer.observe(this.container, {
			subtree: true,
			attributes: true,
			childList: false,
			characterData: false,
		});
	}

	close() {
		console.info('Disconnecting observer');
		if (this.observer) {
			this.observer.disconnect();
			this.observer = null;
		}
	}
}

class TableDoodleFormFiller extends DoodleFormFiller {
	getStatus(slot_id: string): undefined | CalendarSlot['status'] {
		const option: HTMLElement | null = this.container.querySelector(`[data-vote-id='${slot_id}']`);
		if (!option) {
			return undefined;
		}

		if (option.classList.contains('Vote--past')) {
			return;
		}

		for (const className of option.classList.values()) {
			// Console.log("Looking at", className)
			switch (className.toString()) {
				case 'Vote--no': { return 'no';
				}

				case 'Vote--if-need-be': { return 'if-need-be';
				}

				case 'Vote--accepted': { return 'yes';
				}
			}
		}

	}
	changeStatus(slot_id: string, target: CalendarSlot['status']): void {
		const option: HTMLElement | null = this.container.querySelector(`[data-vote-id='${slot_id}']`);
		console.log(`Clicking on ${slot_id}`, option);
		option?.click();
	}


	extractSlots(): CalendarSlot[] {
		const ranges: CalendarSlot[] = [];
		const year: number = new Date().getFullYear()
		for (const element of this.container.querySelectorAll('thead tr th')) {
			const monthString = element.querySelector('.OptionHeader__date-month')?.textContent?.trim() ?? '';
			const dayString = element.querySelector('.OptionHeader__date-day')?.textContent?.trim() ?? '';
			const startTimeString = element.querySelector('.OptionHeader__date-start-time')?.textContent?.trim() ?? '';
			const endTimeString = element.querySelector('.OptionHeader__date-end-time')?.textContent?.replace(/^-/, '').trim() ?? '';

			const slotId = element.querySelector('.OptionHeader__label')?.getAttribute('for')?.trim()?.replace(/^option_/, '');
			const month = new Date(`${monthString} 1, ${year}`).getMonth(); // "SEP" -> 8
			const day = Number.parseInt(dayString, 10);

			const startDate = new Date(`${year}-${month + 1}-${day} ${startTimeString}`);
			const endDate = new Date(`${year}-${month + 1}-${day} ${endTimeString}`);

			const slot: CalendarSlot = {
				id: slotId ?? '',
				startDate,
				endDate,
				status: 'yes',
			};
			if (slot.startDate.getTime() && slot.endDate.getTime()) {
				ranges.push(slot);
			}
		}
		return ranges
	}
}

class ListDoodleFormFiller extends DoodleFormFiller {
	getStatus(slot_id: string): undefined | CalendarSlot['status'] {
		const checkbox: HTMLLIElement | null = this.container.querySelector(`#time-slot-checkbox-${slot_id}`);
		const item = checkbox?.closest('[data-testid="time-slot-item"]');
		if (item) {
			for(const className of item.classList.values()) {
				if (className.startsWith("time-slot-item_yes")) {
					return "yes"
				}
				if (className.startsWith("time-slot-item_if_need_be")) {
					return "if-need-be"
				}
			}
			return "no"
		} else {
			console.error(`Could not find #time-slot-checkbox-${slot_id}`)
		}
	}

	changeStatus(slot_id: string, target: CalendarSlot['status']): void {
		const item: HTMLInputElement | null = this.container.querySelector(`#time-slot-checkbox-${slot_id}`);
		console.log(`Clicking on ${slot_id}`, item);
		item?.click()
	}


	extractSlots(): CalendarSlot[] {
		const slots: CalendarSlot[] = [];

		const sections = this.container.querySelectorAll("section[aria-labelledby^='date-heading']");
		sections.forEach(section => {
			const dateHeading = section.querySelector("h4")?.textContent?.trim();
			if (!dateHeading) return;

			const baseDate = new Date(dateHeading); // e.g. "Monday, September 15, 2025"

			const items = section.querySelectorAll("li[data-testid='time-slot-item']");
			items.forEach(li => {
			const input = li.querySelector<HTMLInputElement>("input[type=checkbox]");
			if (!input?.value) return;
			const id = input.value;

			const timeStr = li.querySelector<HTMLElement>("[data-testid='time-slot-time']")?.innerText.trim();
			const durationStr = li.querySelector<HTMLElement>("[class^='time-slot-details_time-slot-duration']")?.innerText.trim();

			if (!timeStr || !durationStr) return;

			// Parse start date+time
			const startDate = new Date(`${baseDate.toDateString()} ${timeStr}`);

			// Parse duration
			let endDate = new Date(startDate);
			const match = durationStr.match(/(\d+)\s*(h|min)/);
			if (match) {
				const amount = parseInt(match[1], 10);
				if (match[2] === "h") {
				endDate.setHours(endDate.getHours() + amount);
				} else {
				endDate.setMinutes(endDate.getMinutes() + amount);
				}
			}

			slots.push({
				id,
				startDate,
				endDate,
				status: "no", // default
			});
			});
		});

		return slots;
	}
}

let slots: undefined|CalendarSlot[]|null
let filler: undefined|DoodleFormFiller

function getSlots() {
	if (slots === null) return null;
	if (slots) return slots;

	const table = document.querySelector<HTMLElement>('.ParticipationTable');
	if (table) {
		filler = new TableDoodleFormFiller(table)
	}

	const section = document.querySelector<HTMLElement>("div[data-testid='time-slot-list']")
	if (section) {
		filler = new ListDoodleFormFiller(section)
	}

	if (!filler) return

	slots = filler.extractSlots()
	return slots
}


chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
	if (message.type == 'get-range') {
		console.log('Getting slots...');
		const slots = getSlots();
		if (!slots) return null

		const range = {startDate: slots[0].startDate, endDate: slots[0].endDate};
		for (let i = 1; i < slots?.length; ++i) {
			if (range.startDate > slots[i].startDate) {
				range.startDate = slots[i].startDate;
			}

			if (range.endDate < slots[i].endDate) {
				range.endDate = slots[i].endDate;
			}
		}

		console.log(slots, '=>', range);
		sendResponse(range);
	}

	if (message.type === 'runFill') {
		console.log(slots, filler)
		if (filler != null && slots != null) {
			console.log('Running doodle fill...');
			createApp(slots, message.payload, async slots => {
				// Filling slots
				console.log('Filling slots', slots);
				return filler?.fill(slots).finally(() => {
					filler?.close();
					});
			});
		}
	}
});

