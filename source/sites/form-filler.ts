import {type CalendarEvent, type CalendarSlot} from '../events.js';

type SlotChangedEvent = {
	slot_id: string;
	status: CalendarSlot['status']
};

class EventQueue<T> {
	private queue: T[] = [];
	private resolvers: ((value: T) => void)[] = [];

	push(ev: T) {
		if (this.resolvers.length > 0) {
			// someone is awaiting
			const resolve = this.resolvers.shift()!;
			resolve(ev);
		} else {
			this.queue.push(ev);
		}
	}

	next(): Promise<T> {
		if (this.queue.length > 0) {
			return Promise.resolve(this.queue.shift()!);
		}
		return new Promise<T>(resolve => {
			this.resolvers.push(resolve);
		});
	}
}

type RequestChange = () => Promise<void>;

class RequestQueue {
	public lastPromise: Promise<void> = Promise.resolve();
	public errors: string[] = [];

	// Add a request to the queue
	enqueue(request: RequestChange): Promise<void> {
		// Chain the new request after the last one
		this.lastPromise = this.lastPromise
			.then(() => request())
			.catch((error: Error) => {
				this.errors.push(error.message);
			});

		return this.lastPromise;
	}
}


/**
 * This class basically monitors changes until we get it right
 */
export abstract class FormFiller {
	/// Maximum number of changes before reporting a failure
	maxChanges = 10;

	/// Queue of change requests
	queue: RequestQueue;

	/// Manages changed events
	eventQueue: EventQueue<SlotChangedEvent>;

	constructor() {
		this.eventQueue = new EventQueue<SlotChangedEvent>();
		this.queue = new RequestQueue();
	}

	// Can be overwritten when less status in target form than
	// possible (status conversion)
	getWanted(slot: CalendarSlot) {
		return slot.status;
	}

	close() {
		// Do nothing in this abstract class
	}

	changedStatus(slot_id: string, status: CalendarSlot['status']) {
		this.eventQueue.push({ slot_id, status })
	}

	async changeStatusAsync(slot_id: string, wanted: CalendarSlot['status']): Promise<void> {
		let status = this.getStatus(slot_id);
		let changes = 0;

		if (status == wanted) {
			console.log(`Slot ${slot_id} has wanted status ${wanted}`)
			return; // all good
		}

		console.log(`==== Changing ${slot_id} => ${wanted}`)
		this.changeStatus(slot_id, wanted);
		while (status != wanted) {
			const event = await this.eventQueue.next();
			console.log("[EVENT]", event)

			if (event.slot_id != slot_id) {
				console.warn(`Slot ID mismatch ${event.slot_id} vs expected ${slot_id}`)
			} else if (event.status === wanted) {
				// all good
				break
			} else if (status != event.status) {
				// Only change if the status has changed
				status = event.status;
				this.changeStatus(slot_id, wanted);
				if (++changes > this.maxChanges) {
					console.error(`Got too many changes ${changes} without reaching target: failure`);
					throw Error(`Got too many changes ${changes} without reaching target: failure`);
				}
			}
		}

		console.log(`Slot ${slot_id} has wanted status ${wanted}`)
	}

	async fill(slots: CalendarSlot[]) {
		const queue = new RequestQueue();

		for (const slot of slots) {
			queue.enqueue(() => this.changeStatusAsync(slot.id, slot.status));
		}

		// Wait that everything has been processed
		await queue.lastPromise;

		if (queue.errors.length > 0) {
			console.error("Got errors during the filling process", queue.errors);
			throw new Error(queue.errors.join(', '));
		}
	}

	abstract getStatus(slot_id: string): CalendarSlot['status'] | undefined;
	abstract changeStatus(slot_id: string, target: CalendarSlot['status']): void;
	abstract extractSlots(): CalendarSlot[];
}
