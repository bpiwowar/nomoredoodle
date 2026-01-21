import {createApp} from '../calendar-app.js';
import {type CalendarEvent, type CalendarSlot} from '../events.js';
import {browserAPI} from '../browser-compat.js';
import {FormFiller} from './form-filler.js';

abstract class DoodleFormFiller extends FormFiller {
	container: HTMLElement;
	observer: undefined | MutationObserver;
	supportedStatuses: Array<CalendarSlot['status']>;

	constructor(container: HTMLElement) {
		super();

		this.container = container;

		// Detect what statuses this form supports
		this.supportedStatuses = this.detectSupportedStatuses();

		this.observer = new MutationObserver(mutations => {
			for (const mutation of mutations) {
				// Console.log('Mutation detected:', mutation);
				if (mutation.target.nodeType === Node.ELEMENT_NODE) {
					const target = mutation.target as HTMLElement;
					let {voteId} = target.dataset;
					if (voteId) {
						const newStatus = this.getStatus(voteId);
						console.log(`${voteId} has changed status: ${newStatus}`);
						if (newStatus) {
							this.changedStatus(voteId, newStatus);
							continue;
						}
					}

					const testId = target.dataset.testid;
					voteId = testId?.split('-')?.pop();
					if (voteId) {
						const newStatus = this.getStatus(voteId);
						console.log(`${voteId} has changed status: ${newStatus}`);
						if (newStatus) {
							this.changedStatus(voteId, newStatus);
							continue;
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

	getWanted(slot: CalendarSlot) {
		// The calendar-app now handles status conversion based on user preferences.
		// This just returns the status as-is since it's already been converted.
		return slot.status;
	}

	close() {
		console.info('Disconnecting observer');
		if (this.observer) {
			this.observer.disconnect();
			this.observer = undefined;
		}
	}

	abstract detectSupportedStatuses(): Array<CalendarSlot['status']>;
}

class TableDoodleFormFiller extends DoodleFormFiller {
	getStatus(slot_id: string): undefined | CalendarSlot['status'] {
		const option = this.container.querySelector<HTMLElement>(`[data-vote-id='${slot_id}']`);
		if (!option) {
			return undefined;
		}

		if (option.classList.contains('Vote--past')) {
			return;
		}

		for (const className of option.classList.values()) {
			// Console.log("Looking at", className)
			switch (className.toString()) {
				case 'Vote--no': {return 'no';
				}

				case 'Vote--if-need-be': {return 'if-need-be';
				}

				case 'Vote--accepted': {return 'yes';
				}

				default:
					// Just do nothing
			}
		}
	}

	changeStatus(slot_id: string, target: CalendarSlot['status']): void {
		const option = this.container.querySelector<HTMLElement>(`[data-vote-id='${slot_id}']`);
		console.log(`Clicking on ${slot_id}`, option);
		option?.click();
	}

	extractSlots(): CalendarSlot[] {
		const ranges: CalendarSlot[] = [];
		const year: number = new Date().getFullYear();
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

		return ranges;
	}

	detectSupportedStatuses(): Array<CalendarSlot['status']> {
		// For table-based Doodle, assume yes/if-need-be/no
		// Could detect by checking first slot's available states
		return ['yes', 'if-need-be', 'no'];
	}
}

class ListDoodleFormFiller extends DoodleFormFiller {
	getStatus(slot_id: string): undefined | CalendarSlot['status'] {
		const checkbox = this.container.querySelector<HTMLLIElement>(`#time-slot-checkbox-${slot_id}`);
		const item = checkbox?.closest('[data-testid="time-slot-item"]');
		if (item) {
			for (const className of item.classList.values()) {
				if (className.startsWith('time-slot-item_yes')) {
					return 'yes';
				}

				if (className.startsWith('time-slot-item_if_need_be')) {
					return 'if-need-be';
				}
			}

			return 'no';
		}

		console.error(`Could not find #time-slot-checkbox-${slot_id}`);
	}

	changeStatus(slot_id: string, target: CalendarSlot['status']): void {
		const item = this.container.querySelector<HTMLInputElement>(`#time-slot-checkbox-${slot_id}`);
		console.log(`Clicking on ${slot_id}`, item);
		item?.click();
	}

	extractSlots(): CalendarSlot[] {
		const slots: CalendarSlot[] = [];

		const sections = this.container.querySelectorAll('section[aria-labelledby^=\'date-heading\']');
		for (const section of sections) {
			const dateHeading = section.querySelector('h4')?.textContent?.trim();
			if (!dateHeading) {
				continue;
			}

			const baseDate = new Date(dateHeading); // E.g. "Monday, September 15, 2025"

			const items = section.querySelectorAll('li[data-testid=\'time-slot-item\']');
			for (const li of items) {
				const input = li.querySelector<HTMLInputElement>('input[type=checkbox]');
				if (!input?.value) {
					continue;
				}

				const id = input.value;

				const timeString = li.querySelector<HTMLElement>('[data-testid=\'time-slot-time\']')?.textContent?.trim();
				const durationString = li.querySelector<HTMLElement>('[class^=\'time-slot-details_time-slot-duration\']')?.textContent?.trim();

				if (!timeString || !durationString) {
					continue;
				}

				// Parse start date+time
				const startDate = new Date(`${baseDate.toDateString()} ${timeString}`);

				// Parse duration
				const endDate = new Date(startDate);
				const match = /(\d+)\s*(h|min)/.exec(durationString);
				if (match) {
					const amount = Number.parseInt(match[1], 10);
					if (match[2] === 'h') {
						endDate.setHours(endDate.getHours() + amount);
					} else {
						endDate.setMinutes(endDate.getMinutes() + amount);
					}
				}

				slots.push({
					id,
					startDate,
					endDate,
					status: 'no', // Default
				});
			}
		}

		return slots;
	}

	detectSupportedStatuses(): Array<CalendarSlot['status']> {
		// For list-based Doodle, assume yes/if-need-be/no
		// Could detect by checking first slot's available states
		return ['yes', 'if-need-be', 'no'];
	}
}

let slots: undefined | CalendarSlot[];
let filler: undefined | DoodleFormFiller;

function getSlots() {
	if (slots === null) {
		return null;
	}

	if (slots) {
		return slots;
	}

	const table = document.querySelector<HTMLElement>('.ParticipationTable');
	if (table) {
		filler = new TableDoodleFormFiller(table);
	}

	const section = document.querySelector<HTMLElement>('div[data-testid=\'time-slot-list\']');
	if (section) {
		filler = new ListDoodleFormFiller(section);
	}

	if (!filler) {
		return;
	}

	slots = filler.extractSlots();
	return slots;
}

browserAPI.runtime.onMessage.addListener((message, sender, sendResponse) => {
	if (message.type === 'get-range') {
		console.log('Getting slots...');
		const slots = getSlots();
		if (!slots) {
			return;
		}

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
		console.log(slots, filler);
		if (filler !== undefined && slots !== undefined) {
			console.log('Running doodle fill...');
			// Convert date strings back to Date objects (they get serialized during message passing)
			const events = (message.payload as CalendarEvent[]).map(event => ({
				...event,
				startDate: new Date(event.startDate),
				endDate: new Date(event.endDate),
			}));

			createApp(
				slots,
				events,
				async slots => {
					// Filling slots
					console.log('Filling slots', slots);
					return filler?.fill(slots).finally(() => {
						filler?.close();
					});
				},
				{supportedStatuses: filler.supportedStatuses},
			);
		}
	}
});

