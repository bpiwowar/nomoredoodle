import {createApp} from '../calendar-app.js';
import {type CalendarEvent, type CalendarSlot} from '../events.js';
import {browserAPI} from '../browser-compat.js';
import {DirectFormFiller} from './form-filler.js';

type FrenchLabelMapping = {
	pattern: RegExp;
	startHour: number;
	startMinute: number;
	endHour: number;
	endMinute: number;
};

const frenchLabelMappings: FrenchLabelMapping[] = [
	{
		pattern: /^matin$/i, startHour: 8, startMinute: 0, endHour: 12, endMinute: 0,
	},
	{
		pattern: /^apr[eè]s[- ]?midi$/i, startHour: 12, startMinute: 0, endHour: 18, endMinute: 0,
	},
	{
		pattern: /^soir(?:[eé]e)?$/i, startHour: 18, startMinute: 0, endHour: 22, endMinute: 0,
	},
];

const timeRangeRegex = /(\d{1,2})[h:](\d{2})?\s*[-\u2013]\s*(\d{1,2})[h:](\d{2})?/;

function parseLabelToTimeRange(label: string, baseDate: Date): {startDate: Date; endDate: Date} {
	// Try exact time range: "10h-12h", "10h30-12h00", "10:30-12:00"
	const match = timeRangeRegex.exec(label);
	if (match) {
		const startDate = new Date(baseDate);
		startDate.setHours(Number.parseInt(match[1], 10), Number.parseInt(match[2] ?? '0', 10), 0, 0);
		const endDate = new Date(baseDate);
		endDate.setHours(Number.parseInt(match[3], 10), Number.parseInt(match[4] ?? '0', 10), 0, 0);
		return {startDate, endDate};
	}

	// Try French labels
	for (const mapping of frenchLabelMappings) {
		if (mapping.pattern.test(label.trim())) {
			const startDate = new Date(baseDate);
			startDate.setHours(mapping.startHour, mapping.startMinute, 0, 0);
			const endDate = new Date(baseDate);
			endDate.setHours(mapping.endHour, mapping.endMinute, 0, 0);
			return {startDate, endDate};
		}
	}

	// Fallback: full day
	const startDate = new Date(baseDate);
	startDate.setHours(0, 0, 0, 0);
	const endDate = new Date(baseDate);
	endDate.setHours(23, 59, 0, 0);
	return {startDate, endDate};
}

function parseFramadateDate(text: string): Date | undefined {
	// Try parsing as a date string (e.g., "Mercredi 19 février 2026" or "19/02/2026")
	// First try native Date parsing
	const date = new Date(text);
	if (!Number.isNaN(date.getTime())) {
		return date;
	}

	// Try French date format: "Mercredi 19 février 2026" or "19 février 2026"
	const frenchMonths: Record<string, number> = {
		janvier: 0, février: 1, fevrier: 1, mars: 2, avril: 3, mai: 4, juin: 5,
		juillet: 6, août: 7, aout: 7, septembre: 8, octobre: 9, novembre: 10, décembre: 11, decembre: 11,
	};

	const frenchDateMatch = /(\d{1,2})\s+(\w+)\s+(\d{4})/.exec(text);
	if (frenchDateMatch) {
		const day = Number.parseInt(frenchDateMatch[1], 10);
		const monthName = frenchDateMatch[2].toLowerCase();
		const year = Number.parseInt(frenchDateMatch[3], 10);
		const month = frenchMonths[monthName];
		if (month !== undefined) {
			return new Date(year, month, day);
		}
	}

	// Try dd/mm/yyyy format
	const slashMatch = /(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(text);
	if (slashMatch) {
		return new Date(
			Number.parseInt(slashMatch[3], 10),
			Number.parseInt(slashMatch[2], 10) - 1,
			Number.parseInt(slashMatch[1], 10),
		);
	}

	return undefined;
}

class FramadateFormFiller extends DirectFormFiller {
	supportedStatuses: Array<CalendarSlot['status']>;

	constructor() {
		super();
		this.supportedStatuses = this.detectSupportedStatuses();
	}

	detectSupportedStatuses(): Array<CalendarSlot['status']> {
		const firstRadioGroup = document.querySelector('input[name^="vote[answers]"][value="maybe"]');
		return firstRadioGroup ? ['yes', 'if-need-be', 'no'] : ['yes', 'no'];
	}

	getStatus(slotId: string): CalendarSlot['status'] | undefined {
		const checked = document.querySelector<HTMLInputElement>(
			`input[name="vote[answers][${slotId}][value]"]:checked`,
		);

		if (!checked) {
			return undefined;
		}

		switch (checked.value) {
			case 'yes': {
				return 'yes';
			}

			case 'maybe': {
				return 'if-need-be';
			}

			default: {
				return 'no';
			}
		}
	}

	changeStatus(slotId: string, target: CalendarSlot['status']): void {
		let radioValue: string;
		switch (target) {
			case 'yes': {
				radioValue = 'yes';
				break;
			}

			case 'if-need-be':
			case 'could-be': {
				radioValue = 'maybe';
				break;
			}

			case 'no': {
				radioValue = 'no';
				break;
			}
		}

		const radio = document.querySelector<HTMLInputElement>(
			`input[name="vote[answers][${slotId}][value]"][value="${radioValue}"]`,
		);

		if (!radio) {
			console.error(`Could not find radio for slot ${slotId} with value ${radioValue}`);
			return;
		}

		// Use click() to trigger the Stimulus toggle-radio controller
		radio.click();
	}

	extractSlots(): CalendarSlot[] {
		const slots: CalendarSlot[] = [];

		// Use table view headers (always present in DOM)
		const headers = document.querySelectorAll<HTMLElement>('th[scope="col"]');
		const voteCells = document.querySelectorAll<HTMLElement>('td[data-poll-view-target="tableVoteSlot"]');

		// Build a map from column index to header info
		let columnIndex = 0;
		for (const header of headers) {
			const dayMonthElement = header.querySelector('.proposal__day-month');
			const monthElement = header.querySelector('.proposal__month');
			const labelElement = header.querySelector('.proposal__label');

			if (!dayMonthElement && !labelElement) {
				columnIndex++;
				continue;
			}

			const dayMonthText = dayMonthElement?.textContent?.trim() ?? '';
			const monthText = monthElement?.textContent?.trim() ?? '';
			const labelText = labelElement?.textContent?.trim() ?? '';

			// Find corresponding vote cell to get proposal/answer IDs
			const voteCell = voteCells[columnIndex];
			if (!voteCell) {
				columnIndex++;
				continue;
			}

			// Get the answer ID from the radio button name
			const radio = voteCell.querySelector<HTMLInputElement>('input[type="radio"]');
			if (!radio) {
				columnIndex++;
				continue;
			}

			const nameMatch = /vote\[answers]\[(\d+)]\[value]/.exec(radio.name);
			if (!nameMatch) {
				columnIndex++;
				continue;
			}

			const answerId = nameMatch[1];

			// Parse the date
			const dateText = `${dayMonthText} ${monthText}`.trim();
			const baseDate = parseFramadateDate(dateText);

			if (!baseDate) {
				console.warn(`Could not parse date: "${dateText}"`);
				columnIndex++;
				continue;
			}

			// Parse the label into time range
			const {startDate, endDate} = parseLabelToTimeRange(labelText, baseDate);

			slots.push({
				id: answerId,
				startDate,
				endDate,
				status: 'no',
				label: labelText || undefined,
			});

			columnIndex++;
		}

		console.log(`Extracted ${slots.length} slots from Framadate form`);
		return slots;
	}
}

let slots: CalendarSlot[] | undefined;
let filler: FramadateFormFiller | undefined;

function getSlots(): CalendarSlot[] | undefined {
	if (slots) {
		return slots;
	}

	// Check if we're on a poll voting page
	const radio = document.querySelector<HTMLInputElement>('input[name^="vote[answers]"]');
	if (!radio) {
		console.log('No Framadate vote form found');
		return undefined;
	}

	filler = new FramadateFormFiller();
	slots = filler.extractSlots();

	return slots;
}

browserAPI.runtime.onMessage.addListener((message, _sender, sendResponse) => {
	if (message.type === 'get-range') {
		console.log('Getting Framadate slots...');
		const slots = getSlots();
		if (!slots || slots.length === 0) {
			console.error('No Framadate slots found');
			return false;
		}

		const range = {startDate: slots[0].startDate, endDate: slots[0].endDate};
		for (let i = 1; i < slots.length; i++) {
			if (range.startDate > slots[i].startDate) {
				range.startDate = slots[i].startDate;
			}

			if (range.endDate < slots[i].endDate) {
				range.endDate = slots[i].endDate;
			}
		}

		console.log(`Framadate slots: ${slots.length}`, range);
		sendResponse(range);
		return true;
	}

	if (message.type === 'runFill') {
		console.log('Running Framadate fill...');
		if (filler && slots) {
			const events = (message.payload as CalendarEvent[]).map(event => ({
				...event,
				startDate: new Date(event.startDate),
				endDate: new Date(event.endDate),
			}));

			createApp(
				slots,
				events,
				async fillSlots => {
					console.log('Filling Framadate slots', fillSlots);
					return filler?.fill(fillSlots);
				},
				{supportedStatuses: filler.supportedStatuses},
			);
		}

		return true;
	}

	return false;
});
