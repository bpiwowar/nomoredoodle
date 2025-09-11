export interface TimeRange {
	id: string;
    startDate: Date;
    endDate: Date;
	status: "yes" | "could-be" | "if-need-be" | "no";
}

export interface CalendarSlot extends TimeRange {
	overridden?: boolean
}

export interface CalendarEvent extends TimeRange {
	title: string;
}

export const statusOrder = {
	"yes": 0,
	"could-be": 1,
	"if-need-be": 2,
	"no": 3
};



export function doRangesIntersect(range1: CalendarSlot, range2: TimeRange): boolean {
	return range1.startDate < range2.endDate && range1.endDate > range2.startDate;
}

export function calculateSlotStatus(slot: CalendarSlot, events: CalendarEvent[]): CalendarSlot {
	const intersectingEvents = events.filter(event => doRangesIntersect(slot, event));

	if (intersectingEvents.length === 0) {
		return { ...slot, status: "yes", overridden: false };
	}

	const minStatus = intersectingEvents.reduce((min, event) => {
		return statusOrder[event.status] > statusOrder[min] ? event.status : min;
	}, intersectingEvents[0].status);

	return { ...slot, status: minStatus, overridden: false };
}