import React, {useEffect, useState} from 'react';
import {createRoot} from 'react-dom/client';
import {getCalendars} from './native-calendar.js';
import {type CalendarEvent} from './events.js';
import {browserAPI} from './browser-compat.js';

type Calendar = {id: string; title: string};
type CalendarsGrouped = Record<string, Calendar[]>;
export type SelectedCalendars = Record<string, OptionsCalendarStatus>;

// Combine "off" with event statuses
export type OptionsCalendarStatus = 'off' | CalendarEvent['status'];

const Statuses: OptionsCalendarStatus[] = ['off', 'if-need-be', 'could-be', 'no', 'yes'];

function nextStatus(status: OptionsCalendarStatus): OptionsCalendarStatus {
	const index = Statuses.indexOf(status);
	return Statuses[(index + 1) % Statuses.length];
}

async function loadStatuses(): Promise<SelectedCalendars> {
	const {selectedCalendars = {}} = await browserAPI.storage.local.get('selectedCalendars');
	return selectedCalendars as SelectedCalendars;
}

async function saveStatuses(statuses: SelectedCalendars) {
	await browserAPI.storage.local.set({selectedCalendars: statuses});
}

const statusIcon: Record<OptionsCalendarStatus, {icon: string; label: string}> = {
	off: {icon: '⬜', label: 'Off'},
	'if-need-be': {icon: '🟦', label: 'If need be'},
	'could-be': {icon: '🟩', label: 'Could be'},
	no: {icon: '❌', label: 'No'},
	yes: {icon: '✅', label: 'Yes'},
};

const StatusIcon: React.FC<{status: OptionsCalendarStatus}> = ({status}) => <span title={statusIcon[status].label}>{statusIcon[status].icon}</span>;

function Popup() {
	const [calendars, setCalendars] = useState<CalendarsGrouped>({});
	const [statuses, setStatuses] = useState<Record<string, OptionsCalendarStatus>>({});

	useEffect(() => {
		(async () => {
			const cals = await getCalendars();
			setCalendars(cals);
			setStatuses(await loadStatuses());
		})();
	}, []);

	const handleClick = async (id: string) => {
		const newStatus = nextStatus(statuses[id] || 'off');
		const newStatuses = {...statuses, [id]: newStatus};
		setStatuses(newStatuses);
		await saveStatuses(newStatuses);
	};

	return (
		<div className='p-2 text-sm'>
			{Object.entries(calendars).map(([provider, cals]) => (
				<div key={provider} className='mb-2'>
					<div className='font-bold mb-1'>{provider}</div>
					{cals.map(cal => {
						const status = statuses[cal.id] || 'off';
						return (
							<div
								key={cal.id}
								className='flex items-center space-x-2 mb-1 cursor-pointer'
								onClick={async () => handleClick(cal.id)}
							>
								<StatusIcon status={status} />{' '}
								<span>{cal.title}</span>
							</div>
						);
					})}
				</div>
			))}

			<div className='mt-3 pt-2 border-t border-gray-300 text-xs'>
				<div className='font-semibold mb-1'>Legend</div>
				{Statuses.map(s => (
					<div key={s} className='flex items-center space-x-1'>
						<StatusIcon status={s} />{' '}
						<span>{statusIcon[s].label}</span>
					</div>
				))}
			</div>
		</div>
	);
}

const root = createRoot(document.querySelector('#calendars')!);
root.render(<Popup />);

// --- The "fill form button"

const fillButton = document.querySelector<HTMLInputElement>('#fill');
if (fillButton) {
	browserAPI.runtime.sendMessage({type: 'checkSupportedPage'}, resp => {
		console.log('Current page is supported', resp);
		fillButton.disabled = !resp?.supported;
	});

	// Handle click
	fillButton.addEventListener('click', () => {
		browserAPI.runtime.sendMessage({type: 'fillSlots'}).catch(() => {
			console.error('Error when filling slots');
		});
	});
}
