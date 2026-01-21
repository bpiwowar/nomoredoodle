import React, {type CSSProperties, useMemo} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {tailwindCSS} from './tailwind-css.js';
import {
	type CalendarSlot, type CalendarEvent, calculateSlotStatus, doRangesIntersect,
} from './events.js';

const statusColors = {
	yes: 'bg-green-100 border-green-500 text-green-800',
	'could-be': 'bg-blue-100 border-blue-500 text-blue-800',
	'if-need-be': 'bg-yellow-100 border-yellow-500 text-yellow-800',
	no: 'bg-red-100 border-red-500 text-red-800',
};

const statusOptions = [
	{value: 'yes', label: 'Yes'},
	{value: 'could-be', label: 'Could Be'},
	{value: 'if-need-be', label: 'If Need Be'},
	{value: 'no', label: 'No'},
];

function formatDate(timestamp: Date): string {
	return timestamp.toLocaleString();
}

function TimeSlotManager({slots: _slots, events, fillForm}: {slots: CalendarSlot[]; events: CalendarEvent[]; fillForm: (slots: CalendarSlot[]) => Promise<void>}) {
	const [slots, setSlots] = React.useState<CalendarSlot[]>(_slots);
	const [visible, setVisible] = React.useState<boolean>(true);
	const [error, setError] = React.useState<string | null>(null);
	const [filling, setFilling] = React.useState<boolean>(false);

	const computedSlots = useMemo(() => slots.map(slot => {
		if (slot.overridden) {
			return slot;
		}

		return calculateSlotStatus(slot, events);
	}), [slots]);

	const handleSlotStatusChange = (id: string, status: CalendarSlot['status']) => {
		setSlots(slots.map(slot =>
			slot.id === id ? {...slot, status, overridden: true} : slot,
		));
	};

	const handleResetSlot = (id: string) => {
		setSlots(slots.map(slot =>
			slot.id === id ? {...slot, overridden: false} : slot,
		));
	};

	const getIntersectingEvents = (slot: CalendarSlot) => events.filter(event => doRangesIntersect(slot, event));

	const style: CSSProperties = {
		position: 'fixed',
		top: '10px', // Small offset from top
		left: '10px', // Small offset from left

		width: '100%',
		maxWidth: '450px',
		height: '100%',
		zIndex: '9999',

		backgroundColor: '#fff', // Opaque white for visibility
		border: '1px solid #ccc',
		borderRadius: '8px',
		boxShadow: '0 2px 12px rgba(0,0,0,0.3)',
		overflow: 'auto',
	};

	if (!visible) {
		return <button style={{...style, height: '50px', width: '200px'}} onClick={() => {
			setVisible(true);
		}}>Show Time Slot Manager</button>;
	}

	return (<div style={style}>
		<div className='space-y-8'>
			<h1 className='text-3xl font-bold text-gray-800'>Time Slot Manager</h1>

			<button onClick={() => {
				setVisible(false);
			}}>Hide</button>

			<div className='grid grid-cols-1 md:grid-cols-2 gap-8'>
				{/* Slots Section */}
				<div className='bg-white p-6 rounded-lg shadow'>
					<h2 className='text-xl font-semibold mb-4'>Time Slots</h2>

					<div className='space-y-4'>
						{computedSlots.map(slot => {
							const intersectingEvents = getIntersectingEvents(slot);
							return (
								<div key={slot.id} className={`border rounded p-4 ${statusColors[slot.status]}`}>
									<div className='flex justify-between items-start'>
										<div>
											<p className='font-medium'>{formatDate(slot.startDate)} - {formatDate(slot.endDate)}</p>
											<p className='text-sm'>Status: {slot.status} {slot.overridden && '(overridden)'}</p>
										</div>
										<div className='flex space-x-2'>
											<select
												value={slot.status}
												onChange={event => {
													handleSlotStatusChange(slot.id, event.target.value as CalendarSlot['status']);
												}}
												className='bg-white border rounded p-1 text-sm'
											>
												{statusOptions.map(option => (
													<option key={option.value} value={option.value}>{option.label}</option>
												))}
											</select>
											{slot.overridden && (
												<button
													onClick={() => {
														handleResetSlot(slot.id);
													}}
													className='bg-gray-200 hover:bg-gray-300 px-2 rounded text-sm'
													title='Reset to calculated status'
												>
													<i data-feather='refresh-cw' className='w-4 h-4'></i>
												</button>
											)}
										</div>
									</div>

									{intersectingEvents.length > 0 && (
										<div className='mt-3'>
											<p className='text-sm font-medium mb-1'>Intersecting Events:</p>
											<ul className='space-y-1'>
												{intersectingEvents.map(event => (
													<li key={event.id} className='text-sm pl-2 border-l-2 border-gray-300'>
														{event.title} ({event.status}): {formatDate(event.startDate)} - {formatDate(event.endDate)}
													</li>
												))}
											</ul>
										</div>
									)}
								</div>
							);
						})}
					</div>
				</div>

				{/* Submit */}
				<div className='content-center'>
					<button type='button' onClick={() => {
						console.log('Clicked on \'fill form\'');
						setError(null);
						setFilling(true);
						fillForm(computedSlots)
							.then(() => {
								setFilling(false);
							})
							.catch((error: unknown) => {
								console.error('Error when filling the form', error);
								setFilling(false);
								setError((error as Error)?.message ?? 'Unknown error occurred');
							});
					}} disabled={filling} className='text-white bg-blue-500 hover:bg-blue-800 focus:ring-4 focus:ring-blue-300 font-medium rounded-lg text-sm px-5 py-2.5 me-2 mb-2 dark:bg-blue-600 dark:hover:bg-blue-700 focus:outline-none dark:focus:ring-blue-800 disabled:opacity-50 disabled:cursor-not-allowed'>
						{filling ? 'Filling...' : 'Fill the form'}
					</button>
					{error && (
						<div className='mt-4 p-4 bg-red-100 border border-red-400 text-red-700 rounded'>
							<strong>Error:</strong> {error}
						</div>
					)}
				</div>

				{/* Events Section */}
				<div className='bg-white p-6 rounded-lg shadow'>
					<h2 className='text-xl font-semibold mb-4'>Events</h2>

					<div className='space-y-4'>
						{events.map(event => (
							<div key={event.id} className={`border rounded p-4 ${statusColors[event.status]}`}>
								<div className='flex justify-between'>
									<div>
										<p className='font-medium'>{event.title}</p>
										<p className='text-sm'>{formatDate(event.startDate)} - {formatDate(event.endDate)}</p>
									</div>
									<span className='px-2 py-1 text-xs font-medium rounded-full bg-white'>
										{event.status}
									</span>
								</div>
							</div>
						))}
					</div>
				</div>
			</div>
		</div>
	</div>);
}

const wrapperDivId = 'no-more-doodle-dialog';
let root: Root | undefined;

export function createApp(slots: CalendarSlot[], events: CalendarEvent[], fillForm: (slots: CalendarSlot[]) => Promise<void>) {
	console.log('Creating app with', slots, events);

	// Create a host element in the DOM
	let wrapper = document.querySelector(`#${wrapperDivId}`);
	if (!wrapper) {
		const shadowHost = document.createElement('div');
		document.body.append(shadowHost);
		// Attach a shadow root
		const shadowRoot = shadowHost.attachShadow({mode: 'open'});

		// Create a wrapper div inside the shadow root
		wrapper = document.createElement('div');
		wrapper.id = wrapperDivId;
		shadowRoot.append(wrapper);

		// Optional: inject styles inside shadow
		const style = document.createElement('style');
		style.textContent = `
		body, div, button { font-family: sans-serif; }
		button { padding: 6px 12px; font-size: 14px; cursor: pointer; }
		`;
		shadowRoot.append(style);

		const otherstyle = document.createElement('style');
		otherstyle.textContent = tailwindCSS; // Your compiled CSS as string
		shadowRoot.append(otherstyle);
	}

	// Render React inside the shadow root
	console.log('Creating React APP in', wrapper);
	if (root) {
		console.log('Re-using old container');
	} else {
		root = createRoot(wrapper);
	}

	root.render(<TimeSlotManager slots={slots} events={events} fillForm={fillForm}/>);
}
