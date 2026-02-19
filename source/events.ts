export type CalendarStatus = 'yes' | 'could-be' | 'if-need-be' | 'no';

// Combine "off" with event statuses for calendar selection
export type OptionsCalendarStatus = 'off' | CalendarStatus;
export type SelectedCalendars = Record<string, OptionsCalendarStatus>;

export type TimeRange = {
	startDate: Date;
	endDate: Date;
};

export type CalendarSlot = {
	id: string;
	status: CalendarStatus;
	overridden?: boolean;
	label?: string;
} & TimeRange;

export type CalendarEvent = {
	id: string;
	status: CalendarStatus;
	title: string;
	calendarId: string;
	overridden?: boolean;
	bridgeStatus?: CalendarStatus; // Original status from iCal availability
	calendarDefaultStatus?: CalendarStatus; // Status from calendar selection
} & TimeRange;

export const statusOrder = {
	yes: 0,
	'could-be': 1,
	'if-need-be': 2,
	no: 3,
};

export function doRangesIntersect(range1: CalendarSlot, range2: TimeRange): boolean {
	return range1.startDate < range2.endDate && range1.endDate > range2.startDate;
}

export function calculateSlotStatus(slot: CalendarSlot, events: CalendarEvent[]): CalendarSlot {
	const intersectingEvents = events.filter(event => doRangesIntersect(slot, event));

	if (intersectingEvents.length === 0) {
		return {...slot, status: 'yes', overridden: false};
	}

	// eslint-disable-next-line unicorn/no-array-reduce
	const minStatus = intersectingEvents.reduce((min, event) => statusOrder[event.status] > statusOrder[min] ? event.status : min, intersectingEvents[0].status);

	return {...slot, status: minStatus, overridden: false};
}
