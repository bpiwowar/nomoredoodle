import {type CalendarEvent, type CalendarSlot} from '../events.js';

type SlotChangedEvent = {
	slotId: string;
	status: CalendarSlot['status'];
};

class EventQueue<T> {
	private readonly queue: T[] = [];
	private readonly resolvers: Array<(value: T) => void> = [];

	push(event_: T) {
		if (this.resolvers.length > 0) {
			// Someone is awaiting
			const resolve = this.resolvers.shift()!;
			resolve(event_);
		} else {
			this.queue.push(event_);
		}
	}

	async next(): Promise<T> {
		if (this.queue.length > 0) {
			return this.queue.shift()!;
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
	async enqueue(request: RequestChange): Promise<void> {
		// Chain the new request after the last one
		this.lastPromise = this.lastPromise
			.then(async () => request())
			.catch((error: unknown) => {
				this.errors.push((error as Error)?.message);
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

	changedStatus(slotId: string, status: CalendarSlot['status']) {
		this.eventQueue.push({slotId, status});
	}

	async changeStatusAsync(slotId: string, wanted: CalendarSlot['status']): Promise<void> {
		let status = this.getStatus(slotId);
		let changes = 0;

		if (status === wanted) {
			console.log(`Slot ${slotId} has wanted status ${wanted}`);
			return; // All good
		}

		console.log(`==== Changing ${slotId} => ${wanted}`);
		this.changeStatus(slotId, wanted);
		while (status !== wanted) {
			/* eslint-disable-next-line no-await-in-loop */
			const event = await this.eventQueue.next();
			console.log('[EVENT]', event);

			if (event.slotId !== slotId) {
				console.warn(`Slot ID mismatch ${event.slotId} vs expected ${slotId}`);
			} else if (event.status === wanted) {
				// All good
				break;
			} else if (status !== event.status) {
				// Only change if the status has changed
				status = event.status;
				this.changeStatus(slotId, wanted);
				if (++changes > this.maxChanges) {
					console.error(`Got too many changes ${changes} without reaching target: failure`);
					throw new Error(`Got too many changes ${changes} without reaching target: failure`);
				}
			}
		}

		console.log(`Slot ${slotId} has wanted status ${wanted}`);
	}

	async fill(slots: CalendarSlot[]) {
		const queue = new RequestQueue();

		for (const slot of slots) {
			/* eslint-disable-next-line @typescript-eslint/no-floating-promises */
			queue.enqueue(async () => this.changeStatusAsync(slot.id, slot.status));
		}

		// Wait that everything has been processed
		await queue.lastPromise;

		if (queue.errors.length > 0) {
			console.error('Got errors during the filling process', queue.errors);
			throw new Error(queue.errors.join(', '));
		}
	}

	abstract getStatus(slotId: string): CalendarSlot['status'] | undefined;
	abstract changeStatus(slotId: string, target: CalendarSlot['status']): void;
	abstract extractSlots(): CalendarSlot[];
}
