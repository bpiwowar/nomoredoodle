import {getCalendars, type CalendarsGrouped} from './nativeCalendar.js';

// Ask background if current tab is supported
const fillButton = document.querySelector('#fill')! as HTMLInputElement;
if (fillButton) {
	chrome.runtime.sendMessage({type: 'checkSupportedPage'}, resp => {
		console.log('Current page is supported', resp);
		fillButton.disabled = !resp?.supported;
	});
	// Handle click
	fillButton.addEventListener('click', () => {
		chrome.runtime.sendMessage({type: 'fillSlots'});
	});
}

async function loadCalendars() {
	const container = document.querySelector('#calendars')!;
	container.textContent = 'Loading calendars...';

	try {
		const calendars: CalendarsGrouped = await getCalendars();
		container.textContent = '';

		// Load previously selected calendars
		const {selectedCalendars = {}} = await browser.storage.local.get('selectedCalendars');

		for (const provider in calendars) {
			const groupDiv = document.createElement('div');
			groupDiv.className = 'group';

			const title = document.createElement('div');
			title.className = 'group-title';
			title.textContent = provider;
			groupDiv.append(title);

			for (const cal of calendars[provider]) {
				const calDiv = document.createElement('div');
				calDiv.className = 'calendar';

				const checkbox = document.createElement('input');
				checkbox.type = 'checkbox';
				checkbox.id = cal.id;
				checkbox.checked = Boolean(selectedCalendars[cal.id]);

				checkbox.addEventListener('change', async () => {
					// Update storage on change
					const {selectedCalendars = {}} = await browser.storage.local.get('selectedCalendars');
					if (checkbox.checked) {
						selectedCalendars[cal.id] = true;
					} else {
						delete selectedCalendars[cal.id];
					}

					await browser.storage.local.set({selectedCalendars});
				});

				const label = document.createElement('label');
				label.htmlFor = cal.id;
				label.textContent = cal.title;

				calDiv.append(checkbox);
				calDiv.append(label);
				groupDiv.append(calDiv);
			}

			container.append(groupDiv);
		}
	} catch (error) {
		container.textContent = `Failed to load calendars: ${error}`;
	}
}

loadCalendars();
