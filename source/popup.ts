import { getCalendars, CalendarsGrouped } from "./nativeCalendar";

// Ask background if current tab is supported
const fillBtn = document.getElementById("fill") as HTMLButtonElement;
	if (fillBtn) {
		chrome.runtime.sendMessage({ type: "checkSupportedPage" }, (resp) => {
		console.log("Current page is supported", resp)
		if (resp ?.supported) {
			fillBtn.disabled = false;
		} else {
			fillBtn.disabled = true;
		}
	});
	// Handle click
	fillBtn.addEventListener("click", () => {
		chrome.runtime.sendMessage({ type: "fillSlots" });
	});
}

async function loadCalendars() {
	const container = document.getElementById("calendars")!;
	container.textContent = "Loading calendars...";

	try {
		const calendars: CalendarsGrouped = await getCalendars();
		container.textContent = "";

		// Load previously selected calendars
		const { selectedCalendars = {} } = await browser.storage.local.get("selectedCalendars");

		for (const provider in calendars) {
			const groupDiv = document.createElement("div");
			groupDiv.className = "group";

			const title = document.createElement("div");
			title.className = "group-title";
			title.textContent = provider;
			groupDiv.appendChild(title);

			calendars[provider].forEach((cal) => {
				const calDiv = document.createElement("div");
				calDiv.className = "calendar";

				const checkbox = document.createElement("input");
				checkbox.type = "checkbox";
				checkbox.id = cal.id;
				checkbox.checked = !!selectedCalendars[cal.id];

				checkbox.addEventListener("change", async () => {
					// Update storage on change
					const { selectedCalendars = {} } = await browser.storage.local.get("selectedCalendars");
					if (checkbox.checked) {
						selectedCalendars[cal.id] = true;
					} else {
						delete selectedCalendars[cal.id];
					}
					await browser.storage.local.set({ selectedCalendars });
				});

				const label = document.createElement("label");
				label.htmlFor = cal.id;
				label.textContent = cal.title;

				calDiv.appendChild(checkbox);
				calDiv.appendChild(label);
				groupDiv.appendChild(calDiv);
			});

			container.appendChild(groupDiv);
		}
	} catch (err) {
		container.textContent = `Failed to load calendars: ${err}`;
	}
}

loadCalendars();
