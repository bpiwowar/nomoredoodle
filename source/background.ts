// eslint-disable-next-line import/no-unassigned-import
import './options-storage.js';
import { getEvents } from "./nativeCalendar";

async function getSelectedCalendarIDs() : Promise<string[]> {
	const { selectedCalendars = {} } = await browser.storage.local.get("selectedCalendars");
	return Object.entries(selectedCalendars).filter(([_, sel]) => sel).map(([calId, _]) => calId)
}


async function fillSlots(tab_id: number) {
	console.log("Filling on", tab_id)
	const {startDate, endDate} = await chrome.tabs.sendMessage(tab_id, {
		type: "get-range"
	})

	console.log("Searching for events in range", startDate, endDate)

	const selectedIDs = await getSelectedCalendarIDs()
	const events = await getEvents(startDate, endDate, selectedIDs);

	chrome.tabs.sendMessage(tab_id, {
		type: "runFill",
		payload: events
	});

}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
	console.log("Got message", msg)
	if (msg.type === "checkSupportedPage") {
		console.log("Checking if current page is supported")
		chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
			const tab = tabs[0];
			const isSupported = !!(tab ?.url && tab.url.includes("doodle.com"));
			sendResponse({ supported: isSupported });
			console.log(`Is supported: ${isSupported}`)
		});
		return true; // keep channel open for async response
	}

	else if (msg.type === "fillSlots") {
		console.log("Got a message: fill slot")
		chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
			if (tabs[0] ?.id) fillSlots(tabs[0]?.id)
		})
	}

	else
	{
		console.warn("Unprocessed", msg)
	}
});
