import { createApp } from '../calendar-app'
import { CalendarSlot, TimeRange } from '../events';

function parseDoodleSlot(el: HTMLElement, year: number = new Date().getFullYear()): CalendarSlot | undefined {
	const monthStr = el.querySelector(".OptionHeader__date-month") ?.textContent ?.trim() ?? "";
	const dayStr = el.querySelector(".OptionHeader__date-day") ?.textContent ?.trim() ?? "";
	const startTimeStr = el.querySelector(".OptionHeader__date-start-time") ?.textContent ?.trim() ?? "";
	const endTimeStr = el.querySelector(".OptionHeader__date-end-time") ?.textContent ?.replace(/^-/, "").trim() ?? "";

	const slotId = el.querySelector(".OptionHeader__label")?.getAttribute("for")?.trim()?.replace(/^option_/, "")
	const month = new Date(`${monthStr} 1, ${year}`).getMonth(); // "SEP" -> 8
	const day = parseInt(dayStr, 10);

	const startDate = new Date(`${year}-${month + 1}-${day} ${startTimeStr}`);
	const endDate = new Date(`${year}-${month + 1}-${day} ${endTimeStr}`);

	const slot: CalendarSlot = {
		id: slotId ?? "",
		startDate: startDate,
		endDate: endDate,
		status: "yes"
	};
	if (slot.startDate.getTime() && slot.endDate.getTime()) {
		return slot;
	}
}

function get_slots() {
	const table = document.querySelector(".ParticipationTable")
	if (table) {
		const ranges: CalendarSlot[] = []
		table.querySelectorAll("thead tr th").forEach((el) => {
			const slot = parseDoodleSlot(el as HTMLElement);
			if (slot) ranges.push(slot)
		})
		return ranges;
	} else {
		console.log("No ranges detected")
		return []
	}
}

const STATUS2Attribute: {[key in CalendarSlot["status"]]: CalendarSlot["status"]} = {
	"no": "no",
	"could-be": "if-need-be",
	'if-need-be': "if-need-be",
	'yes': "yes"
}



/**
 * This class basically monitors changes until we get it right
 */
abstract class FormFiller {
	registeredSlots: {[key: string]: {
		id: string,
		wanted: CalendarSlot["status"],
		seen: Set<CalendarSlot["status"]>
	}} = {}

	abstract getStatus(slot_id: string): CalendarSlot["status"]|undefined
	abstract changeStatus(slot_id: string, target: CalendarSlot["status"]): void

	// Can be overwritten when less status in target form than
	// possible
	getWanted(slot: CalendarSlot) {
		return slot.status
	}

	close() {}

	changedStatus(slot_id: string, status: CalendarSlot["status"]) {
		console.log(this.registeredSlots)
		const item = this.registeredSlots[slot_id]
		if (!item) {
			console.error(`${slot_id} is not registered anymore`)
			return;
		}

		if (status == item.wanted) {
			console.log(`Status for ${slot_id} matches ${item.wanted}`)
			delete this.registeredSlots[slot_id]
			console.log("Delete registered", this.registeredSlots)
			return
		}

		if (item.seen.has(status)) {
			console.error(`Status ${status} has already been seen for ${slot_id}: stopping`)
			return
		}

		console.log(`Changing the status of ${slot_id}`)
		this.changeStatus(slot_id, item.wanted)
	}

	async fill(slots: CalendarSlot[]) {
		for(const slot of slots) {
			const status = this.getStatus(slot.id)
			if (!status) {
				console.error(`Cannot determine ${slot.id} status`)
			} else if (status == slot.status) {
				console.log(`${slot.id} status has already status ${status}`)
			} else {
				this.registeredSlots[slot.id] = {
					id: slot.id,
					wanted: this.getWanted(slot),
					seen: new Set([status])
				}
				console.log(`Register ${slot.id} => ${slot.status}`)
				this.changeStatus(slot.id, slot.status)
				console.log(this.registeredSlots)
			}
		}

		function handler(_this: FormFiller, resolve: () => void, reject: () => void) {
			console.log("Checking....")
			if (Object.keys(_this.registeredSlots).length == 0) {
				console.log("All good, exiting")

				resolve()
			}
		}

		return new Promise<void>((resolve, reject) => {
			const interval = setInterval(handler, 500, this, () =>  {
				clearInterval(interval)
				resolve()
			}, () => {
				clearInterval(interval)
				reject()
			})
		})
	}
}

class DoodleFormFiller extends FormFiller {
	row: HTMLElement
	observer: null|MutationObserver;

	getWanted(slot: CalendarSlot) {
		return STATUS2Attribute[slot.status]
	}

	getStatus(slot_id: string): undefined|CalendarSlot['status'] {
		const option: HTMLElement|null = this.row.querySelector(`[data-vote-id='${slot_id}']`)
		if (!option) return undefined;

		if (option.classList.contains("Vote--past")) return;

		for(const className of option.classList.values()) {
			// console.log("Looking at", className)
			switch(className.toString()) {
				case "Vote--no": return "no"
				case "Vote--if-need-be": return "if-need-be"
				case "Vote--accepted": return "yes"
			}
		}

		console.error("Could not determine the status of", option)
	}
	changeStatus(slot_id: string, target: CalendarSlot['status']): void {
		const option: HTMLElement|null = this.row.querySelector(`[data-vote-id='${slot_id}']`)
		console.log(`Clicking on ${slot_id}`, option)
		option?.click()
	}

	constructor() {
		super()

		const row = document.querySelector("tr[data-testid='table']")
		if (!row) {
			throw new Error("Could not get the current row")
		}
		this.row = row as HTMLElement


		this.observer = new MutationObserver((mutations) => {
			mutations.forEach(mutation => {
				console.log("Mutation detected:", mutation);
				if (mutation.target.nodeType == Node.ELEMENT_NODE) {
					const target = mutation.target as HTMLElement
					const vote_id = target.getAttribute("data-vote-id")
					if (vote_id) {
						const new_status = this.getStatus(vote_id)
						console.log(`${vote_id} has changed status: ${new_status}`)
						if (new_status) this.changedStatus(vote_id, new_status)
					}
				}
			});
		});

		this.observer.observe(row, {
			subtree: true,
			attributes: true,
			childList: false,
			characterData: false,
		});

	}

	close() {
		console.info("Disconnecting observer")
		if (this.observer) {
			this.observer.disconnect()
			this.observer = null
		}
	}
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
	if (msg.type == "get-range") {
		console.log("Getting slots...");
		const slots = get_slots()
		const range = {startDate: slots[0].startDate, endDate: slots[0].endDate}
		for(let i = 1; i < slots?.length; ++i) {
			if (range.startDate > slots[i].startDate) range.startDate = slots[i].startDate
			if (range.endDate < slots[i].endDate) range.endDate = slots[i].endDate
		}
		console.log(slots, " => ", range)
		sendResponse(range)
	}
	if (msg.type === "runFill") {
		console.log("Running doodle fill...");
		createApp(get_slots(), msg.payload, async (slots) => {
			// Filling slots
			console.log("Filling slots", slots)
			const filler = new DoodleFormFiller()
			return filler.fill(slots).finally(() => filler.close())
		})

	}
})

