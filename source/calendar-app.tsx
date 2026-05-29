import React, {type CSSProperties, useMemo, useEffect} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {tailwindCSS} from './tailwind-css.js';
import {
	type CalendarSlot, type CalendarEvent, type CalendarStatus, calculateSlotStatus, doRangesIntersect, type OptionsCalendarStatus, type SelectedCalendars,
} from './events.js';
import {browserAPI} from './browser-compat.js';

type Calendar = {id: string; title: string};
type CalendarsGrouped = Record<string, Calendar[]>;

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

function formatTime(date: Date): string {
	return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function formatDate(timestamp: Date): string {
	return timestamp.toLocaleString(undefined, {
		year: 'numeric',
		month: 'short',
		day: 'numeric',
		hour: '2-digit',
		minute: '2-digit',
	});
}

function TimeSlotManager({
	slots: _slots,
	events: _events,
	fillForm,
	formOptions,
}: {
	slots: CalendarSlot[];
	events: CalendarEvent[];
	fillForm: (slots: CalendarSlot[]) => Promise<void>;
	formOptions?: FormOptions;
}) {
	const containerRef = React.useRef<HTMLDivElement>(null);
	const [slots, setSlots] = React.useState<CalendarSlot[]>(_slots);
	const [events, setEvents] = React.useState<CalendarEvent[]>(_events);
	const [visible, setVisible] = React.useState<boolean>(true);
	const [error, setError] = React.useState<string | undefined>(undefined);
	const [filling, setFilling] = React.useState<boolean>(false);
	const [activeTab, setActiveTab] = React.useState<string>('slots');
	const [calendars, setCalendars] = React.useState<CalendarsGrouped>({});
	const [calendarsLoading, setCalendarsLoading] = React.useState<boolean>(true);
	const [calendarsError, setCalendarsError] = React.useState<string | undefined>(undefined);
	const [calendarStatuses, setCalendarStatuses] = React.useState<Record<string, OptionsCalendarStatus>>({});
	const [statusMapping, setStatusMapping] = React.useState<{
		'could-be': CalendarSlot['status'];
		'if-need-be': CalendarSlot['status'];
	}>({
		'could-be': 'no',
		'if-need-be': 'no',
	});

	// Global label-to-time mappings: computed from initial slots
	const [labelTimeMappings, setLabelTimeMappings] = React.useState<Record<string, {start: string; end: string}>>(() => {
		const mappings: Record<string, {start: string; end: string}> = {};
		for (const slot of _slots) {
			if (slot.label && !mappings[slot.label]) {
				mappings[slot.label] = {
					start: formatTime(slot.startDate),
					end: formatTime(slot.endDate),
				};
			}
		}

		return mappings;
	});

	useEffect(() => {
		(async () => {
			try {
				console.log('Loading calendars...');
				setCalendarsLoading(true);
				setCalendarsError(undefined);

				// Request calendars from background script
				const response = await (browserAPI.runtime.sendMessage as (message: any) => Promise<any>)({type: 'getCalendars'}) as {error?: string; calendars?: CalendarsGrouped};

				if (response.error) {
					throw new Error(response.error);
				}

				console.log('Calendars loaded:', response.calendars);
				setCalendars(response.calendars || {});

				const statuses = await loadStatuses();
				console.log('Calendar statuses loaded:', statuses);
				setCalendarStatuses(statuses);
				setCalendarsLoading(false);
			} catch (error) {
				console.error('Error loading calendars:', error);
				setCalendarsError((error as Error)?.message ?? 'Failed to load calendars');
				setCalendarsLoading(false);
			}
		})();
	}, []);

	// Determine if we're in restricted mode
	const supportedStatuses = formOptions?.supportedStatuses ?? ['yes', 'could-be', 'if-need-be', 'no'];
	const isRestricted = supportedStatuses.length < 4;

	// Convert status based on what the form supports
	const convertStatus = (status: CalendarSlot['status']): CalendarSlot['status'] => {
		if (supportedStatuses.includes(status)) {
			return status;
		}

		// Map unsupported statuses using user preference
		if (status === 'could-be' || status === 'if-need-be') {
			return statusMapping[status];
		}

		return status;
	};

	// Merge events: use overridden status if set, otherwise use iCal status (bridgeStatus)
	const computedEvents = useMemo(() => events.map(event => {
		if (event.overridden) {
			return event;
		}

		// Priority: override > iCal status > calendar default (from current UI state)
		// Get current calendar status from state
		const currentCalendarStatus = calendarStatuses[event.calendarId] || 'off';
		const calendarDefaultStatus = currentCalendarStatus === 'off' ? 'yes' : currentCalendarStatus;

		// Logic: "free" events override calendar default, "busy" events respect calendar default
		const {bridgeStatus} = event;
		const status: CalendarStatus = (bridgeStatus === 'yes')
			? 'yes' // Free events override the calendar default
			: ((bridgeStatus === 'no')
				? calendarDefaultStatus // Busy events respect the calendar default
				: bridgeStatus ?? calendarDefaultStatus); // Tentative or fallback to calendar default

		// Update the calendarDefaultStatus to reflect current state
		return {...event, status, calendarDefaultStatus};
	}), [events, calendarStatuses]);

	// Only events overlapping at least one candidate slot affect the result, so
	// the Events tab lists just those (events between slots are noise — common
	// for grid schedulers like Timeful where the date range has many gaps).
	const intersectingEvents = useMemo(
		() => computedEvents.filter(event => slots.some(slot => doRangesIntersect(slot, event))),
		[computedEvents, slots],
	);

	const computedSlots = useMemo(() => slots.map(slot => {
		if (slot.overridden) {
			// Apply conversion even to overridden slots
			return {...slot, status: convertStatus(slot.status)};
		}

		// Filter out events from calendars that are "off"
		const activeEvents = computedEvents.filter(event => {
			const calendarStatus = calendarStatuses[event.calendarId] || 'off';
			return calendarStatus !== 'off';
		});

		// Convert event statuses for calculation only
		const eventsWithConvertedStatus = activeEvents.map(event => ({
			...event,
			status: convertStatus(event.status),
		}));
		const calculated = calculateSlotStatus(slot, eventsWithConvertedStatus);
		return {...calculated, status: convertStatus(calculated.status)};
	}), [slots, computedEvents, statusMapping, calendarStatuses]);

	const handleSlotStatusChange = (id: string, status: CalendarSlot['status']) => {
		setSlots(slots.map(slot =>
			slot.id === id ? {...slot, status, overridden: true} : slot));
	};

	const handleLabelTimeChange = (label: string, field: 'start' | 'end', time: string) => {
		setLabelTimeMappings(prev => ({
			...prev,
			[label]: {...prev[label], [field]: time},
		}));

		const slotField = field === 'start' ? 'startDate' : 'endDate';
		const [hours, minutes] = time.split(':').map(Number);
		setSlots(slots.map(slot => {
			if (slot.label !== label) {
				return slot;
			}

			const newDate = new Date(slot[slotField]);
			newDate.setHours(hours, minutes, 0, 0);
			return {...slot, [slotField]: newDate};
		}));
	};

	const handleResetSlot = (id: string) => {
		setSlots(slots.map(slot =>
			slot.id === id ? {...slot, overridden: false} : slot));
	};

	const handleResetAll = () => {
		setSlots(slots.map(slot => ({...slot, overridden: false})));
	};

	const eventGroupKey = (event: CalendarEvent) => `${event.title}\0${event.calendarId}`;

	const handleEventStatusChange = (id: string, status: CalendarSlot['status']) => {
		setEvents(events.map(event =>
			event.id === id ? {...event, status, overridden: true} : event));
	};

	const handleResetEvent = (id: string) => {
		setEvents(events.map(event =>
			event.id === id ? {...event, overridden: false} : event));
	};

	const handleResetAllEvents = () => {
		setEvents(events.map(event => ({...event, overridden: false})));
	};

	const getIntersectingEvents = (slot: CalendarSlot) => computedEvents.filter(event => doRangesIntersect(slot, event));

	// Get calendar name from calendar ID
	const getCalendarName = (calendarId: string): string => {
		for (const [provider, cals] of Object.entries(calendars)) {
			const cal = cals.find(c => c.id === calendarId);
			if (cal) {
				return `${cal.title} (${provider})`;
			}
		}

		return calendarId; // Fallback to ID if not found
	};

	const handleResetSlots = () => {
		handleResetAll();
	};

	const handleCalendarClick = async (id: string) => {
		const newStatus = nextStatus(calendarStatuses[id] || 'off');
		const newStatuses = {...calendarStatuses, [id]: newStatus};
		setCalendarStatuses(newStatuses);
		await saveStatuses(newStatuses);
	};

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

	const tabButtonStyle = (isActive: boolean): CSSProperties => ({
			padding: '12px 24px',
			fontWeight: '600',
			fontSize: '16px',
			backgroundColor: isActive ? '#2563eb' : '#e5e7eb',
			color: isActive ? 'white' : '#374151',
			border: 'none',
			borderTopLeftRadius: '8px',
			borderTopRightRadius: '8px',
			cursor: 'pointer',
			boxShadow: isActive ? '0 4px 6px rgba(0,0,0,0.1)' : 'none',
		});

	if (!visible) {
		const showButtonStyle: CSSProperties = {
			...style,
			height: 'auto',
			width: 'auto',
			padding: '12px 24px',
			fontSize: '14px',
			fontWeight: 'bold',
			cursor: 'pointer',
			backgroundColor: '#3b82f6',
			color: 'white',
			border: 'none',
			borderRadius: '8px',
			boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
		};
		return <button style={showButtonStyle} onClick={() => {
			setVisible(true);
		}}>📅 Show Time Slot Manager</button>;
	}

	return (<div ref={containerRef} style={style}>
		{/* Header */}
		<div style={{padding: '16px', borderBottom: '1px solid #d1d5db', background: 'linear-gradient(to right, #eff6ff, #f9fafb)'}}>
			<div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'center'}}>
				<h1 style={{
fontSize: '24px', fontWeight: 'bold', color: '#1f2937', margin: 0,
}}>Time Slot Manager</h1>
				<button
					onClick={() => {
						setVisible(false);
					}}
					style={{
						backgroundColor: '#ef4444',
						color: 'white',
						fontWeight: '600',
						borderRadius: '8px',
						fontSize: '14px',
						padding: '8px 16px',
						border: 'none',
						cursor: 'pointer',
						boxShadow: '0 1px 3px rgba(0,0,0,0.1)',
					}}
					onMouseEnter={e => {
						e.currentTarget.style.backgroundColor = '#dc2626';
					}}
					onMouseLeave={e => {
						e.currentTarget.style.backgroundColor = '#ef4444';
					}}
				>
					✕ Hide
				</button>
			</div>
		</div>

		{/* Tabs */}
		<div style={{
display: 'flex', gap: '8px', padding: '12px 16px 0 16px', backgroundColor: '#f3f4f6',
}}>
			<button
				onClick={() => {
					setActiveTab('slots');
				}}
				style={tabButtonStyle(activeTab === 'slots')}
				onMouseEnter={e => {
					if (activeTab !== 'slots') {
e.currentTarget.style.backgroundColor = '#d1d5db';
}
				}}
				onMouseLeave={e => {
					if (activeTab !== 'slots') {
e.currentTarget.style.backgroundColor = '#e5e7eb';
}
				}}
			>
				Slots
			</button>
			<button
				onClick={() => {
					setActiveTab('calendars');
				}}
				style={tabButtonStyle(activeTab === 'calendars')}
				onMouseEnter={e => {
					if (activeTab !== 'calendars') {
e.currentTarget.style.backgroundColor = '#d1d5db';
}
				}}
				onMouseLeave={e => {
					if (activeTab !== 'calendars') {
e.currentTarget.style.backgroundColor = '#e5e7eb';
}
				}}
			>
				Calendars
			</button>
			<button
				onClick={() => {
					setActiveTab('events');
				}}
				style={tabButtonStyle(activeTab === 'events')}
				onMouseEnter={e => {
					if (activeTab !== 'events') {
e.currentTarget.style.backgroundColor = '#d1d5db';
}
				}}
				onMouseLeave={e => {
					if (activeTab !== 'events') {
e.currentTarget.style.backgroundColor = '#e5e7eb';
}
				}}
			>
				Events
			</button>
		</div>

		{/* Tab content */}
		<div className='overflow-auto bg-gray-50' style={{height: 'calc(100% - 130px)'}}>
			{/* Slots Tab */}
			{activeTab === 'slots' && (
				<div>
					{/* Action buttons - sticky at top */}
					<div style={{
position: 'sticky', top: 0, backgroundColor: 'white', borderBottom: '1px solid #d1d5db', padding: '16px', boxShadow: '0 1px 3px rgba(0,0,0,0.1)', zIndex: 10,
}}>
						<div style={{display: 'flex', gap: '12px'}}>
							<button
								onClick={handleResetSlots}
								style={{
									backgroundColor: '#ef4444',
									color: 'white',
									fontWeight: 'bold',
									borderRadius: '8px',
									fontSize: '16px',
									padding: '12px 24px',
									border: 'none',
									cursor: 'pointer',
									boxShadow: '0 4px 6px rgba(0,0,0,0.1)',
								}}
								onMouseEnter={e => {
									e.currentTarget.style.backgroundColor = '#dc2626';
								}}
								onMouseLeave={e => {
									e.currentTarget.style.backgroundColor = '#ef4444';
								}}
							>
								🔄 Reset All Slots
							</button>
							<button
								onClick={() => {
									setError(undefined);
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
								}}
								disabled={filling}
								style={{
									backgroundColor: filling ? '#93c5fd' : '#3b82f6',
									color: 'white',
									fontWeight: 'bold',
									borderRadius: '8px',
									fontSize: '16px',
									padding: '12px 24px',
									border: 'none',
									cursor: filling ? 'not-allowed' : 'pointer',
									boxShadow: '0 4px 6px rgba(0,0,0,0.1)',
									opacity: filling ? 0.5 : 1,
								}}
								onMouseEnter={e => {
									if (!filling) {
e.currentTarget.style.backgroundColor = '#2563eb';
}
								}}
								onMouseLeave={e => {
									if (!filling) {
e.currentTarget.style.backgroundColor = '#3b82f6';
}
								}}
							>
								{filling ? '⏳ Filling...' : '✓ Fill Form'}
							</button>
						</div>

						{/* Error display */}
						{error && (
							<div className='mt-3 p-3 bg-red-100 border border-red-400 text-red-700 rounded'>
								<strong>Error:</strong> {error}
							</div>
						)}
					</div>

					{/* Slots content */}
					<div className='p-4 space-y-4'>

						{/* Status Mapping Controls (if restricted mode) */}
						{isRestricted && (
							<div className='bg-white p-6 rounded-lg shadow'>
								<h2 className='text-xl font-semibold mb-4'>Status Mapping</h2>
								<p className='text-sm text-gray-600 mb-4'>
									This form only supports: {supportedStatuses.join(', ')}. Choose how to map other statuses:
								</p>
								<div className='space-y-3'>
									{!supportedStatuses.includes('could-be') && (
										<div className='flex items-center gap-3'>
											<label className='text-sm font-medium w-32'>"Could be" →</label>
											<select
												value={statusMapping['could-be']}
												onChange={e => {
													setStatusMapping({...statusMapping, 'could-be': e.target.value as CalendarSlot['status']});
												}}
												className='border rounded px-2 py-1'
											>
												{supportedStatuses.map(status => (
													<option key={status} value={status}>{status}</option>
												))}
											</select>
										</div>
									)}
									{!supportedStatuses.includes('if-need-be') && (
										<div className='flex items-center gap-3'>
											<label className='text-sm font-medium w-32'>"If need be" →</label>
											<select
												value={statusMapping['if-need-be']}
												onChange={e => {
													setStatusMapping({...statusMapping, 'if-need-be': e.target.value as CalendarSlot['status']});
												}}
												className='border rounded px-2 py-1'
											>
												{supportedStatuses.map(status => (
													<option key={status} value={status}>{status}</option>
												))}
											</select>
										</div>
									)}
								</div>
							</div>
						)}

						{/* Label Time Mappings */}
						{Object.keys(labelTimeMappings).length > 0 && (
							<div className='bg-white p-6 rounded-lg shadow'>
								<h2 className='text-xl font-semibold mb-4'>Label Time Mappings</h2>
								<p className='text-sm text-gray-600 mb-4'>
									Adjust the time range for each label. Changes apply to all slots with the same label.
								</p>
								<div className='space-y-3'>
									{Object.entries(labelTimeMappings).map(([label, times]) => (
										<div key={label} className='flex items-center gap-3'>
											<span className='text-sm font-bold w-28 truncate' title={label}>{label}</span>
											<input
												type='time'
												value={times.start}
												onChange={e => {
													handleLabelTimeChange(label, 'start', e.target.value);
												}}
												className='border rounded px-2 py-1 text-sm'
											/>
											<span className='text-sm'>-</span>
											<input
												type='time'
												value={times.end}
												onChange={e => {
													handleLabelTimeChange(label, 'end', e.target.value);
												}}
												className='border rounded px-2 py-1 text-sm'
											/>
										</div>
									))}
								</div>
							</div>
						)}

						{/* Slots list */}
						<div className='bg-white p-6 rounded-lg shadow'>
							<h2 className='text-xl font-semibold mb-4'>Time Slots</h2>
							<div className='space-y-4'>
								{computedSlots.map(slot => {
									const intersectingEvents = getIntersectingEvents(slot);
									const overriddenStyle = slot.overridden ? 'border-4 border-purple-500' : 'border';
									const originalSlot = slots.find(s => s.id === slot.id);
									return (
										<div key={slot.id} className={`${overriddenStyle} rounded p-4 ${statusColors[slot.status]}`}>
											<div className='flex justify-between items-start'>
												<div>
													{originalSlot?.label && (
														<p className='font-bold text-base mb-1'>{originalSlot.label}</p>
													)}
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
															↺
														</button>
													)}
												</div>
											</div>

											{intersectingEvents.length > 0 && (
												<div className='mt-3'>
													<p className='text-sm font-medium mb-1'>Intersecting Events:</p>
													<ul className='space-y-1'>
														{intersectingEvents.map(event => {
															const calendarIsOff = (calendarStatuses[event.calendarId] || 'off') === 'off';
															const textStyle = calendarIsOff ? 'text-gray-500 line-through' : '';
															return (
																<li key={event.id} className={`text-sm pl-2 border-l-2 border-gray-300 ${textStyle}`}>
																	<div>{event.title} ({event.status})</div>
																	<div>{formatDate(event.startDate)} - {formatDate(event.endDate)}</div>
																</li>
															);
														})}
													</ul>
												</div>
											)}
										</div>
									);
								})}
							</div>
						</div>
					</div>
				</div>
			)}

			{/* Calendars Tab */}
			{activeTab === 'calendars' && (
				<div className='p-4 space-y-4'>
					<div className='bg-white p-6 rounded-lg shadow'>
						<h2 className='text-xl font-semibold mb-4'>Calendar Selection</h2>
						<p className='text-sm text-gray-600 mb-4'>
							Click on a calendar to cycle through statuses: Off → If Need Be → Could Be → No → Yes
						</p>
						{calendarsLoading
? (
							<div className='text-center text-gray-500 py-4'>
								Loading calendars...
							</div>
						)
: calendarsError
? (
							<div className='p-4 bg-red-100 border border-red-400 text-red-700 rounded'>
								<strong>Error:</strong> {calendarsError}
							</div>
						)
: Object.keys(calendars).length === 0
? (
							<div className='text-center text-gray-500 py-4'>
								No calendars found
							</div>
						)
: (
							<>
								{Object.entries(calendars).map(([provider, cals]) => (
									<div key={provider} className='mb-4'>
										<div className='font-bold mb-2 text-lg text-gray-800'>{provider}</div>
										{cals.map(cal => {
											const status = calendarStatuses[cal.id] || 'off';
											return (
												<div
													key={cal.id}
													className='flex items-center gap-3 mb-2 p-3 hover:bg-gray-100 cursor-pointer rounded border border-gray-200'
													onClick={async () => handleCalendarClick(cal.id)}
												>
													<StatusIcon status={status} />
													<span className='text-base'>{cal.title}</span>
												</div>
											);
										})}
									</div>
								))}
							</>
						)}

						<div className='mt-6 pt-4 border-t border-gray-300'>
							<div className='font-semibold mb-3 text-base'>Legend</div>
							<div className='grid grid-cols-2 gap-3'>
								{Statuses.map(s => (
									<div key={s} className='flex items-center gap-2'>
										<StatusIcon status={s} />
										<span className='text-sm'>{statusIcon[s].label}</span>
									</div>
								))}
							</div>
						</div>
					</div>
				</div>
			)}

			{/* Events Tab */}
			{activeTab === 'events' && (
				<div>
					{/* Reset button - sticky at top */}
					<div style={{
position: 'sticky', top: 0, backgroundColor: 'white', borderBottom: '1px solid #d1d5db', padding: '16px', boxShadow: '0 1px 3px rgba(0,0,0,0.1)', zIndex: 10,
}}>
						<button
							onClick={handleResetAllEvents}
							style={{
								backgroundColor: '#ef4444',
								color: 'white',
								fontWeight: 'bold',
								borderRadius: '8px',
								fontSize: '16px',
								padding: '12px 24px',
								border: 'none',
								cursor: 'pointer',
								boxShadow: '0 4px 6px rgba(0,0,0,0.1)',
							}}
							onMouseEnter={e => {
								e.currentTarget.style.backgroundColor = '#dc2626';
							}}
							onMouseLeave={e => {
								e.currentTarget.style.backgroundColor = '#ef4444';
							}}
						>
							🔄 Reset All Events
						</button>
					</div>

					{/* Events content */}
					<div className='p-4 space-y-4'>
						<div className='bg-white p-6 rounded-lg shadow'>
							<h2 className='text-xl font-semibold mb-4'>Events</h2>
							<p className='text-sm text-gray-600 mb-4'>
								Event status priority: <strong>Manual Override</strong> &gt; <strong>iCal Availability</strong> &gt; <strong>Calendar Setting</strong>.
								Click reset to restore the iCal status.
							</p>
							<div className='space-y-4'>
								{(() => {
									// Group events by title + calendarId to collapse recurring events
									const seen = new Set<string>();
									const groupCounts = new Map<string, number>();
									for (const event of intersectingEvents) {
										const key = eventGroupKey(event);
										groupCounts.set(key, (groupCounts.get(key) ?? 0) + 1);
									}

									return intersectingEvents.filter(event => {
										const key = eventGroupKey(event);
										if (seen.has(key)) {
											return false;
										}

										seen.add(key);
										return true;
									}).map(event => {
									const key = eventGroupKey(event);
									const count = groupCounts.get(key) ?? 1;
									const overriddenStyle = event.overridden ? 'border-4 border-purple-500' : 'border';
									const calendarIsOff = (calendarStatuses[event.calendarId] || 'off') === 'off';
									const boxColor = calendarIsOff ? 'bg-gray-100 border-gray-400 text-gray-600' : statusColors[event.status];
									return (
										<div key={event.id} className={`${overriddenStyle} rounded p-4 ${boxColor}`}>
											<div className='flex justify-between items-start'>
												<div className='flex-1'>
													<p className='font-medium'>{event.title}</p>
													<p className='text-sm text-gray-600 italic'>{getCalendarName(event.calendarId)}</p>
													<p className='text-sm'>
														{formatDate(event.startDate)} - {formatDate(event.endDate)}
														{count > 1 && <span className='ml-2 text-gray-500'>(and {count - 1} more)</span>}
													</p>
													<div className='mt-2 space-y-1'>
														{event.bridgeStatus && (
															<p className='text-xs text-gray-600'>
																<span className='font-semibold'>iCal Availability:</span> {event.bridgeStatus}
															</p>
														)}
														<div className='flex items-center gap-2'>
															<span className='text-xs font-semibold text-gray-600'>Calendar Setting:</span>
															<select
																value={calendarStatuses[event.calendarId] || 'off'}
																onChange={async e => {
																	const newStatus = e.target.value as OptionsCalendarStatus;
																	const newStatuses = {...calendarStatuses, [event.calendarId]: newStatus};
																	setCalendarStatuses(newStatuses);
																	await saveStatuses(newStatuses);
																}}
																className='text-xs border rounded px-1 py-0.5'
																onClick={e => {
																	e.stopPropagation();
																}}
															>
																{Statuses.map(s => (
																	<option key={s} value={s}>{statusIcon[s].label}</option>
																))}
															</select>
														</div>
														<p className='text-sm font-medium'>
															<span className='font-semibold'>Effective Status:</span> {event.status} {event.overridden && '(manual override)'}
														</p>
													</div>
												</div>
												<div className='flex space-x-2'>
													<select
														value={event.status}
														onChange={e => {
															handleEventStatusChange(event.id, e.target.value as CalendarSlot['status']);
														}}
														className='bg-white border rounded p-1 text-sm'
													>
														{statusOptions.map(option => (
															<option key={option.value} value={option.value}>{option.label}</option>
														))}
													</select>
													{event.overridden && (
														<button
															onClick={() => {
																handleResetEvent(event.id);
															}}
															className='bg-gray-200 hover:bg-gray-300 px-2 rounded text-sm'
															title='Reset to iCal status'
														>
															↺
														</button>
													)}
												</div>
											</div>
										</div>
									);
								});
								})()}
							</div>
						</div>
					</div>
				</div>
			)}

		</div>
	</div>);
}

const wrapperDivId = 'no-more-doodle-dialog';
let root: Root | undefined;

type FormOptions = {
	supportedStatuses: Array<CalendarSlot['status']>;
};

export function createApp(
	slots: CalendarSlot[],
	events: CalendarEvent[],
	fillForm: (slots: CalendarSlot[]) => Promise<void>,
	formOptions?: FormOptions,
) {
	console.log('Creating app with', slots, events, formOptions);

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

		const tailwindStyle = document.createElement('style');
		tailwindStyle.textContent = tailwindCSS; // Your compiled CSS as string
		shadowRoot.append(tailwindStyle);
	}

	// Render React inside the shadow root
	console.log('Creating React APP in', wrapper);
	if (root) {
		console.log('Re-using old container');
	} else {
		root = createRoot(wrapper);
	}

	root.render(<TimeSlotManager slots={slots} events={events} fillForm={fillForm} formOptions={formOptions}/>);
}
