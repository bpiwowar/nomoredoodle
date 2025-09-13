import {type CalendarEvent, type CalendarSlot} from '../events.js';

type FormFillerInformation = {
	id: string;
	wanted: CalendarSlot['status'];
	seen: Set<CalendarSlot['status']>;
};

/**
 * This class basically monitors changes until we get it right
 */
export abstract class FormFiller {
	registeredSlots: Map<string, FormFillerInformation> = new Map<string, FormFillerInformation>();

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
		const item = this.registeredSlots.get(slot_id);
		if (!item) {
			console.error(`${slot_id} is not registered anymore`);
			return;
		}

		if (status === item.wanted) {
			console.log(`Status for ${slot_id} matches ${item.wanted}`);
			this.registeredSlots.delete(slot_id);
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
			} else if (status === slot.status) {
				console.log(`${slot.id} status has already status ${status}`);
			} else {
				this.registeredSlots.set(slot.id, {
					id: slot.id,
					wanted: this.getWanted(slot),
					seen: new Set([status]),
				});
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
			}, (error: Error) => {
				clearInterval(interval);
				reject(error);
			});
		});
	}

	abstract getStatus(slot_id: string): CalendarSlot['status'] | undefined;
	abstract changeStatus(slot_id: string, target: CalendarSlot['status']): void;
	abstract extractSlots(): CalendarSlot[];
}
