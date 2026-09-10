/**
 * The in-page overlay, on a poll that stands in for a real one.
 *
 * Which view ends up in the picture is chosen by the fragment - #calendar,
 * #list or #calendars - so every shot is a URL the capture script can ask for,
 * instead of a sequence of clicks it would have to drive from outside.
 */
import {installFakeExtension, slots, events} from './fixtures.js';
import {formatTime} from '../../source/events.js';

installFakeExtension();

function renderPoll(): void {
	const list = document.querySelector('#poll-slots')!;
	for (const slot of slots) {
		const row = document.createElement('li');
		const box = document.createElement('input');
		box.type = 'checkbox';
		box.disabled = true;
		const day = slot.startDate.toLocaleDateString('en-US', {weekday: 'long', month: 'long', day: 'numeric'});
		row.append(box, `${day} · ${formatTime(slot.startDate)}`);
		list.append(row);
	}
}

/** Everything the overlay draws lives in a shadow root, including its buttons. */
function overlayRoot(): ShadowRoot {
	const host = [...document.body.children].find(element => element.shadowRoot);
	if (!host?.shadowRoot) {
		throw new Error('The overlay did not render.');
	}

	return host.shadowRoot;
}

async function settle(): Promise<void> {
	await new Promise(resolve => {
		setTimeout(resolve, 150);
	});
}

/** Tabs and view switches are buttons; the emoji ones are matched loosely. */
async function press(label: string): Promise<void> {
	const buttons = [...overlayRoot().querySelectorAll('button')];
	const button = buttons.find(candidate => candidate.textContent?.trim() === label)
		?? buttons.find(candidate => candidate.textContent?.includes(label));
	if (!button) {
		throw new Error(`No "${label}" button in the overlay.`);
	}

	button.click();
	await settle();
}

async function main(): Promise<void> {
	renderPoll();

	const {createApp} = await import('../../source/calendar-app.js');
	// Every status the extension can give: a form that supports fewer adds a
	// mapping card at the top, which is worth a screenshot of its own, not the
	// one where the calendar is the subject.
	createApp(slots, events, async () => {
		// The Fill button is only ever photographed, never pressed.
	}, {supportedStatuses: ['yes', 'could-be', 'if-need-be', 'no']});
	await settle();

	switch (globalThis.location.hash) {
		case '#list': {
			await press('List');
			break;
		}

		case '#calendars': {
			await press('Calendars');
			// The overlay shrinks to 450px for this tab; the poll moves in with it
			// rather than leaving a column of nothing down the middle.
			document.documentElement.style.setProperty('--poll-left', '500px');
			break;
		}

		default: {
			// #calendar: the slots tab in its calendar view, which is what opens.
			break;
		}
	}

	await settle();
	document.documentElement.dataset.screenshot = 'ready';
}

void main();
