import {createApp} from '../calendar-app.js';
import {type CalendarEvent, type CalendarSlot} from '../events.js';
import {FormFiller} from './form-filler.js';
import {browserAPI} from '../browser-compat.js';

const radioValue2Status: Record<string, CalendarSlot['status']> = {
	selected_value_yes: 'yes',
	selected_value_maybe: 'if-need-be',
	selected_value_no: 'no',
};

class EventoFormFiller extends FormFiller {
	container: HTMLElement;
	observer: MutationObserver | undefined;
	supportsTernary: boolean;

	constructor(container: HTMLElement) {
		super();

		this.container = container;

		// Detect if ternary mode (with "Peut-être") is supported
		const firstButtonGroup = container.querySelector('span.button-group.field-yes-no-maybe-radio');
		const hasMaybeOption = firstButtonGroup?.querySelector('input[value="selected_value_maybe"]') !== null;
		this.supportsTernary = hasMaybeOption;

		console.log(`Evento form detected. Ternary mode (Peut-être): ${this.supportsTernary}`);

		// Set up MutationObserver to watch for label class changes
		this.observer = new MutationObserver(mutations => {
			for (const mutation of mutations) {
				if (mutation.type === 'attributes' && mutation.attributeName === 'class') {
					const target = mutation.target as HTMLElement;
					if (target.tagName === 'LABEL') {
						// Only process when a label gains "selected" class (not when losing it)
						if (!target.classList.contains('selected')) {
							continue;
						}

						// Find the radio input inside this label
						const radio = target.querySelector<HTMLInputElement>('input[type="radio"]');
						if (radio && radio.name.startsWith('proposition_')) {
							const slotId = radio.name.replace('proposition_', '');
							const newStatus = this.getStatus(slotId);
							if (newStatus) {
								console.log(`Slot ${slotId} changed to ${newStatus}`);
								this.changedStatus(slotId, newStatus);
							}
						}
					}
				}
			}
		});

		this.observer.observe(this.container, {
			subtree: true,
			attributes: true,
			attributeFilter: ['class'],
		});
	}

	/**
	 * Map internal 4-status system to Evento's 2 or 3 statuses
	 */
	getWanted(slot: CalendarSlot): CalendarSlot['status'] {
		if (this.supportsTernary) {
			// Ternary mode: yes/could-be/if-need-be/no → yes/if-need-be/no
			if (slot.status === 'could-be') {
				return 'if-need-be';
			}

			return slot.status;
		}

		// Binary mode: yes/could-be/if-need-be/no → yes/no
		// Only "yes" maps to "yes", everything else is "no"
		if (slot.status === 'yes') {
			return 'yes';
		}

		return 'no';
	}

	close() {
		console.info('Disconnecting Evento observer');
		if (this.observer) {
			this.observer.disconnect();
			this.observer = undefined;
		}
	}

	getStatus(slotId: string): CalendarSlot['status'] | undefined {
		// Find all radios for this slot
		const radios = this.container.querySelectorAll<HTMLInputElement>(
			`input[type="radio"][name="proposition_${slotId}"]`,
		);

		for (const radio of radios) {
			if (radio.checked) {
				return radioValue2Status[radio.value];
			}
		}

		return undefined;
	}

	changeStatus(slotId: string, target: CalendarSlot['status']): void {
		// Determine the radio value to select
		let radioValue: string;
		if (target === 'yes') {
			radioValue = 'selected_value_yes';
		} else if (target === 'if-need-be') {
			radioValue = 'selected_value_maybe';
		} else {
			radioValue = 'selected_value_no';
		}

		// Find the radio with this value
		const radio = this.container.querySelector<HTMLInputElement>(
			`input[type="radio"][name="proposition_${slotId}"][value="${radioValue}"]`,
		);

		if (!radio) {
			console.error(`Could not find radio for slot ${slotId} with value ${radioValue}`);
			return;
		}

		// Find the label associated with this radio (it's the parent)
		const label = radio.closest('label');
		if (label) {
			console.log(`Clicking label for slot ${slotId} to set status ${target}`);
			label.click();
		} else {
			console.error(`Could not find label for slot ${slotId}`);
		}
	}

	extractSlots(): CalendarSlot[] {
		const slots: CalendarSlot[] = [];

		// Find all button groups (one per slot)
		const buttonGroups = this.container.querySelectorAll('span.button-group.field-yes-no-maybe-radio');

		for (const buttonGroup of buttonGroups) {
			// Find a radio button to extract the slot ID
			const radio = buttonGroup.querySelector<HTMLInputElement>('input[type="radio"]');
			if (!radio || !radio.name.startsWith('proposition_')) {
				continue;
			}

			const slotId = radio.name.replace('proposition_', '');

			// Find the parent <td> cell
			const cell = buttonGroup.closest('td');
			if (!cell) {
				console.warn(`Could not find parent <td> for slot ${slotId}`);
				continue;
			}

			// Find the label with timestamps
			const label = cell.querySelector('label[class*="label-for-small"]');
			if (!label) {
				console.warn(`Could not find label for slot ${slotId}`);
				continue;
			}

			// Get the timestamp spans
			const timestampSpans = label.querySelectorAll<HTMLSpanElement>('span[data-timestamp]');
			if (timestampSpans.length !== 2) {
				console.warn(`Expected 2 timestamps for slot ${slotId}, found ${timestampSpans.length}`);
				continue;
			}

			// Convert Unix timestamps to Date objects
			const startTimestamp = Number.parseInt(timestampSpans[0].dataset.timestamp ?? '0', 10);
			const endTimestamp = Number.parseInt(timestampSpans[1].dataset.timestamp ?? '0', 10);

			if (!startTimestamp || !endTimestamp) {
				console.warn(`Invalid timestamps for slot ${slotId}`);
				continue;
			}

			const startDate = new Date(startTimestamp * 1000);
			const endDate = new Date(endTimestamp * 1000);

			// Get current status
			const currentStatus = this.getStatus(slotId) ?? 'no';

			slots.push({
				id: slotId,
				startDate,
				endDate,
				status: currentStatus,
			});
		}

		console.log(`Extracted ${slots.length} slots from Evento form`);
		return slots;
	}
}

let slots: CalendarSlot[] | undefined;
let filler: EventoFormFiller | undefined;

function getSlots(): CalendarSlot[] | undefined {
	if (slots) {
		return slots;
	}

	// Find the container - use document.body since there's no form element
	const container = document.body;
	if (!container) {
		console.error('Could not find body element');
		return undefined;
	}

	filler = new EventoFormFiller(container);
	slots = filler.extractSlots();

	return slots;
}

browserAPI.runtime.onMessage.addListener((message, _sender, sendResponse) => {
	if (message.type === 'get-range') {
		console.log('Getting Evento slots...');
		const slots = getSlots();
		if (!slots || slots.length === 0) {
			console.error('No slots found');
			return false;
		}

		// Calculate the overall date range
		const range = {startDate: slots[0].startDate, endDate: slots[0].endDate};
		for (let i = 1; i < slots.length; i++) {
			if (range.startDate > slots[i].startDate) {
				range.startDate = slots[i].startDate;
			}

			if (range.endDate < slots[i].endDate) {
				range.endDate = slots[i].endDate;
			}
		}

		console.log(`Evento slots: ${slots.length}`, range);
		sendResponse(range);
		return true;
	}

	if (message.type === 'runFill') {
		console.log('Running Evento fill...');
		if (filler && slots) {
			// Convert date strings back to Date objects (they get serialized during message passing)
			const rawEvents = (message.payload as CalendarEvent[]).map(event => ({
				...event,
				startDate: new Date(event.startDate),
				endDate: new Date(event.endDate),
			}));

			// Apply status conversion for the form's supported statuses
			// This ensures the overlay shows what will actually be filled
			const currentFiller = filler; // Capture for TypeScript
			const slotsWithConvertedStatus = slots.map(slot => ({
				...slot,
				status: currentFiller.getWanted(slot),
			}));

			// Also convert event statuses so the overlay displays correctly
			const eventsWithConvertedStatus = rawEvents.map(event => ({
				...event,
				status: currentFiller.getWanted(event),
			}));

			createApp(slotsWithConvertedStatus, eventsWithConvertedStatus, async slots => {
				console.log('Filling Evento slots', slots);
				return filler?.fill(slots).finally(() => {
					filler?.close();
				});
			});
		}

		return true;
	}

	return false;
});
