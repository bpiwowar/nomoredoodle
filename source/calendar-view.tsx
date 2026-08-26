import React, {type CSSProperties, useMemo} from 'react';
import {
	type CalendarSlot, type CalendarEvent, type CalendarStatus, type OptionsCalendarStatus, formatTime, eventGroupKey,
} from './events.js';

export const statusPalette: Record<CalendarStatus, {bg: string; border: string; text: string}> = {
	yes: {bg: '#dcfce7', border: '#22c55e', text: '#166534'},
	'could-be': {bg: '#dbeafe', border: '#3b82f6', text: '#1e40af'},
	'if-need-be': {bg: '#fef9c3', border: '#eab308', text: '#854d0e'},
	no: {bg: '#fee2e2', border: '#ef4444', text: '#991b1b'},
};

export const offPalette = {bg: '#f3f4f6', border: '#9ca3af', text: '#6b7280'};

const pixelsPerHour = 56;
const gutterWidth = 48;
const headerHeight = 42;

function startOfDay(date: Date): Date {
	return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function dayKey(date: Date): string {
	return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

/** Minutes elapsed since `day` (00:00), clamped to [0, 1440] for other days. */
function minutesSince(day: Date, date: Date): number {
	return Math.min(1440, Math.max(0, (date.getTime() - day.getTime()) / 60_000));
}

function slotTooltip(slot: CalendarSlot): string {
	return [
		slot.label,
		`${formatTime(slot.startDate)} - ${formatTime(slot.endDate)}`,
		`Status: ${slot.status}${slot.overridden ? ' (overridden)' : ''}`,
		slot.overridden ? 'Click to change, ↺ to restore the calculated status' : 'Click to change',
	].filter(Boolean).join('\n');
}

function eventTooltip(event: CalendarEvent, calendarName: string, isOff: boolean, group: GroupInfo): string {
	return [
		event.title,
		calendarName,
		`${formatTime(event.startDate)} - ${formatTime(event.endDate)}`,
		`Status: ${isOff ? 'ignored (calendar off)' : event.status}${event.overridden ? ' (overridden)' : ''}`,
		group.count > 1
			? `Repeats ${group.count}×${group.broken ? ', occurrences differ' : ''} — click to change them all, shift-click for this one only`
			: 'Click to change the status',
		event.overridden ? '↺ restores the calendar status' : undefined,
	].filter(Boolean).join('\n');
}

type Interval<T> = {item: T; start: number; end: number};
type LaidOut<T> = Interval<T> & {lane: number; lanes: number};

/**
 * Assigns overlapping intervals to side-by-side lanes, the way a week view
 * splits concurrent events. Non-overlapping clusters each get their own lane
 * count so isolated items still take the full width.
 */
function layoutLanes<T>(intervals: Array<Interval<T>>): Array<LaidOut<T>> {
	const sorted = [...intervals].sort((a, b) => (a.start - b.start) || (a.end - b.end));
	const result: Array<LaidOut<T>> = [];
	let cluster: Array<Interval<T>> = [];
	let clusterEnd = Number.NEGATIVE_INFINITY;

	const flush = () => {
		const laneEnds: number[] = [];
		const assigned = cluster.map(entry => {
			let lane = laneEnds.findIndex(end => end <= entry.start);
			if (lane === -1) {
				lane = laneEnds.length;
			}

			laneEnds[lane] = entry.end;
			return {...entry, lane};
		});

		for (const entry of assigned) {
			result.push({...entry, lanes: laneEnds.length});
		}

		cluster = [];
		clusterEnd = Number.NEGATIVE_INFINITY;
	};

	for (const entry of sorted) {
		if (cluster.length > 0 && entry.start >= clusterEnd) {
			flush();
		}

		cluster.push(entry);
		clusterEnd = Math.max(clusterEnd, entry.end);
	}

	if (cluster.length > 0) {
		flush();
	}

	return result;
}

type HoverHandlers = {
	onMouseEnter: (mouseEvent: React.MouseEvent) => void;
	onMouseMove: (mouseEvent: React.MouseEvent) => void;
	onMouseLeave: () => void;
};

function Block({
	top, height, lane, lanes, palette, muted, dashed, highlighted, hover, onClick, children,
}: {
	top: number;
	height: number;
	lane: number;
	lanes: number;
	palette: {bg: string; border: string; text: string};
	muted?: boolean;
	dashed?: boolean;
	highlighted?: boolean;
	hover?: HoverHandlers;
	onClick?: (mouseEvent: React.MouseEvent) => void;
	children: React.ReactNode;
}) {
	return (
		<div
			onClick={onClick}
			{...hover}
			style={{
				position: 'absolute',
				top: `${top}px`,
				height: `${Math.max(height, 16)}px`,
				left: `${(lane / lanes) * 100}%`,
				width: `${(1 / lanes) * 100}%`,
				paddingRight: '2px',
				boxSizing: 'border-box',
				cursor: onClick ? 'pointer' : 'default',
				zIndex: onClick ? 2 : 1,
			}}
		>
			<div style={{
				height: '100%',
				// Without border-box the padding and borders push the box past its
				// slot, hiding the bottom edge.
				boxSizing: 'border-box',
				overflow: 'hidden',
				borderRadius: '4px',
				backgroundColor: palette.bg,
				color: palette.text,
				opacity: muted ? 0.8 : 1,
				// Events get a solid box with a thick coloured spine; slots a plain
				// dashed outline, so the two bands never read as the same thing.
				border: `${highlighted ? '2px' : '1px'} ${dashed ? 'dashed' : 'solid'} ${highlighted ? '#a855f7' : palette.border}`,
				// Spread rather than an undefined value: React clears the property
				// when it sees undefined, which would wipe the shorthand's left edge.
				...(dashed ? {} : {borderLeft: `4px solid ${palette.border}`}),
				padding: '1px 3px',
				fontSize: '10px',
				lineHeight: '1.2',
			}}>
				{children}
			</div>
		</div>
	);
}

const eventStatuses: CalendarStatus[] = ['yes', 'could-be', 'if-need-be', 'no'];

type GroupInfo = {count: number; broken: boolean};

/**
 * 🔁 the whole series still shares one status, 🔂 this occurrence was set on its
 * own and the series no longer agrees. Single events get no icon.
 */
function RecurrenceIcon({group}: {group: GroupInfo}) {
	if (group.count < 2) {
		return null;
	}

	return <span style={{flex: '0 0 auto'}}>{group.broken ? '🔂' : '🔁'}</span>;
}

/**
 * Floating tooltip: the blocks are laid out on an absolute grid, so growing one
 * on hover would shove the day's other lanes around. This draws over them instead.
 */
function HoverPopup({text, x, y}: {text: string; x: number; y: number}) {
	const width = 260;
	return (
		<div style={{
			position: 'fixed',
			left: `${Math.min(x + 14, window.innerWidth - width - 8)}px`,
			top: `${Math.min(y + 14, window.innerHeight - 96)}px`,
			zIndex: 10_000,
			maxWidth: `${width}px`,
			padding: '6px 8px',
			borderRadius: '6px',
			backgroundColor: '#1f2937',
			color: '#f9fafb',
			fontSize: '11px',
			lineHeight: '1.4',
			whiteSpace: 'pre-line',
			overflowWrap: 'anywhere',
			boxShadow: '0 4px 14px rgba(0, 0, 0, 0.35)',
			pointerEvents: 'none',
		}}>
			{text}
		</div>
	);
}

export function CalendarSlotsView({
	slots, events, calendarStatuses, supportedStatuses, onSlotStatusChange, onResetSlot, onEventStatusChange, onResetEvent, getCalendarName,
}: {
	slots: CalendarSlot[];
	events: CalendarEvent[];
	calendarStatuses: Record<string, OptionsCalendarStatus>;
	supportedStatuses: Array<CalendarSlot['status']>;
	onSlotStatusChange: (id: string, status: CalendarSlot['status']) => void;
	onResetSlot: (id: string) => void;
	onEventStatusChange: (id: string, status: CalendarStatus, applyToSeries: boolean) => void;
	onResetEvent: (id: string, applyToSeries: boolean) => void;
	getCalendarName: (calendarId: string) => string;
}) {
	// Occurrences of one recurring event share a key; a series counts as broken
	// once its occurrences no longer all carry the same status.
	const groups = useMemo(() => {
		const byKey = new Map<string, GroupInfo>();
		const statuses = new Map<string, CalendarStatus>();
		for (const event of events) {
			const key = eventGroupKey(event);
			const entry = byKey.get(key) ?? {count: 0, broken: false};
			entry.count++;
			const seen = statuses.get(key);
			if (seen === undefined) {
				statuses.set(key, event.status);
			} else if (seen !== event.status) {
				entry.broken = true;
			}

			byKey.set(key, entry);
		}

		return byKey;
	}, [events]);

	const groupOf = (event: CalendarEvent): GroupInfo => groups.get(eventGroupKey(event)) ?? {count: 1, broken: false};

	const cycleEventStatus = (event: CalendarEvent, mouseEvent: React.MouseEvent) => {
		const next = eventStatuses[(eventStatuses.indexOf(event.status) + 1) % eventStatuses.length];
		onEventStatusChange(event.id, next, !mouseEvent.shiftKey);
	};

	const days = useMemo(() => {
		const byDay = new Map<string, {day: Date; slots: CalendarSlot[]}>();
		for (const slot of slots) {
			const day = startOfDay(slot.startDate);
			const key = dayKey(day);
			const entry = byDay.get(key) ?? {day, slots: []};
			entry.slots.push(slot);
			byDay.set(key, entry);
		}

		return [...byDay.values()].sort((a, b) => a.day.getTime() - b.day.getTime());
	}, [slots]);

	// The visible time window is driven by the slots (events are clipped to it),
	// so an all-day event cannot stretch the grid to a useless 24h scale.
	const [startHour, endHour] = useMemo(() => {
		let earliest = 24 * 60;
		let latest = 0;
		for (const slot of slots) {
			const day = startOfDay(slot.startDate);
			earliest = Math.min(earliest, minutesSince(day, slot.startDate));
			latest = Math.max(latest, minutesSince(day, slot.endDate));
		}

		if (earliest > latest) {
			return [8, 20];
		}

		return [
			Math.max(0, Math.floor(earliest / 60) - 1),
			Math.min(24, Math.ceil(latest / 60) + 1),
		];
	}, [slots]);

	const [popup, setPopup] = React.useState<{text: string; x: number; y: number} | undefined>(undefined);

	const hoverHandlers = (text: string): HoverHandlers => ({
		onMouseEnter(mouseEvent) {
			setPopup({text, x: mouseEvent.clientX, y: mouseEvent.clientY});
		},
		onMouseMove(mouseEvent) {
			setPopup({text, x: mouseEvent.clientX, y: mouseEvent.clientY});
		},
		onMouseLeave() {
			setPopup(undefined);
		},
	});

	const windowStartMinutes = startHour * 60;
	const windowEndMinutes = endHour * 60;
	const bodyHeight = ((windowEndMinutes - windowStartMinutes) / 60) * pixelsPerHour;
	const toPixels = (minutes: number) => ((minutes - windowStartMinutes) / 60) * pixelsPerHour;

	const cycleStatus = (current: CalendarSlot['status']): CalendarSlot['status'] => {
		const index = supportedStatuses.indexOf(current);
		return supportedStatuses[(index + 1) % supportedStatuses.length];
	};

	if (days.length === 0) {
		return <div style={{padding: '16px', color: '#6b7280'}}>No time slots found on this page.</div>;
	}

	const hours = Array.from({length: endHour - startHour + 1}, (_, index) => startHour + index);

	// Events covering the whole visible window (all-day entries, mostly) become
	// chips above the grid: drawn as full-height bars they squeeze every other
	// event of that day into an unreadable sliver.
	const perDay = days.map(({day, slots: daySlots}) => {
		const windowStart = new Date(day.getTime() + (windowStartMinutes * 60_000));
		const windowEnd = new Date(day.getTime() + (windowEndMinutes * 60_000));
		const visibleEvents = events.filter(event => event.startDate < windowEnd && event.endDate > windowStart);
		const allDayEvents = visibleEvents.filter(event => event.startDate <= windowStart && event.endDate >= windowEnd);
		const timedEvents = visibleEvents.filter(event => !allDayEvents.includes(event));
		return {
			day, daySlots, windowStart, windowEnd, allDayEvents, timedEvents,
		};
	});

	const allDayRows = Math.max(0, ...perDay.map(entry => entry.allDayEvents.length));
	const allDayHeight = allDayRows === 0 ? 0 : (allDayRows * 18) + 6;

	return (
		<div style={{overflowX: 'auto', userSelect: 'none'}}>
			<div style={{display: 'flex', minWidth: `${gutterWidth + (days.length * 160)}px`}}>
				{/* Hour gutter */}
				<div style={{width: `${gutterWidth}px`, flex: '0 0 auto'}}>
					<div style={{height: `${headerHeight}px`}}/>
					{allDayRows > 0 && (
						<div style={{
							height: `${allDayHeight}px`,
							boxSizing: 'border-box',
							fontSize: '9px',
							color: '#9ca3af',
							textAlign: 'right',
							paddingRight: '4px',
							borderBottom: '1px solid #d1d5db',
						}}>
							all day
						</div>
					)}
					<div style={{position: 'relative', height: `${bodyHeight}px`}}>
						{hours.map(hour => (
							<div
								key={hour}
								style={{
									position: 'absolute',
									top: `${toPixels(hour * 60)}px`,
									right: '4px',
									transform: 'translateY(-50%)',
									fontSize: '10px',
									color: '#6b7280',
									whiteSpace: 'nowrap',
								}}
							>
								{String(hour).padStart(2, '0')}:00
							</div>
						))}
					</div>
				</div>

				{/* Day columns */}
				{perDay.map(({
					day, daySlots, windowStart, windowEnd, allDayEvents, timedEvents,
				}) => {
					const laidOutEvents = layoutLanes(timedEvents.map(event => ({
						item: event,
						start: Math.max(windowStartMinutes, minutesSince(day, event.startDate)),
						end: Math.min(windowEndMinutes, minutesSince(day, event.endDate)),
					})));

					const laidOutSlots = layoutLanes(daySlots.map(slot => ({
						item: slot,
						start: minutesSince(day, slot.startDate),
						end: minutesSince(day, slot.endDate),
					})));

					return (
						<div key={dayKey(day)} style={{flex: '1 0 160px', borderLeft: '2px solid #94a3b8', minWidth: '160px'}}>
							<div style={{
								height: `${headerHeight}px`,
								display: 'flex',
								flexDirection: 'column',
								alignItems: 'center',
								justifyContent: 'center',
								borderBottom: '1px solid #d1d5db',
								backgroundColor: '#f9fafb',
							}}>
								<div style={{fontSize: '12px', fontWeight: 700, color: '#1f2937'}}>
									{day.toLocaleDateString(undefined, {weekday: 'short', day: 'numeric', month: 'short'})}
								</div>
								<div style={{
									fontSize: '9px', color: '#9ca3af', display: 'flex', width: '100%',
								}}>
									<span style={{width: '78%', textAlign: 'center'}}>events</span>
									<span style={{flex: 1, textAlign: 'center'}}>slots</span>
								</div>
							</div>

							{allDayRows > 0 && (
								<div style={{
									height: `${allDayHeight}px`,
									boxSizing: 'border-box',
									padding: '3px 2px 0 2px',
									borderBottom: '1px solid #d1d5db',
									backgroundColor: '#fbfbfc',
								}}>
									{allDayEvents.map(event => {
										const isOff = (calendarStatuses[event.calendarId] || 'off') === 'off';
										const palette = isOff ? offPalette : statusPalette[event.status];
										const group = groupOf(event);
										return (
											<div
												key={event.id}
												{...hoverHandlers(eventTooltip(event, getCalendarName(event.calendarId), isOff, group))}
												onClick={mouseEvent => {
													cycleEventStatus(event, mouseEvent);
												}}
												style={{
													display: 'flex',
													alignItems: 'center',
													gap: '3px',
													height: '16px',
													boxSizing: 'border-box',
													marginBottom: '2px',
													borderRadius: '3px',
													padding: '0 4px',
													fontSize: '10px',
													lineHeight: '15px',
													cursor: 'pointer',
													backgroundColor: palette.bg,
													color: palette.text,
													opacity: isOff ? 0.8 : 1,
													border: `${event.overridden ? '2px solid #a855f7' : `1px solid ${palette.border}`}`,
													overflow: 'hidden',
												}}
											>
												<span style={{
													flex: 1,
													minWidth: 0,
													overflow: 'hidden',
													textOverflow: 'ellipsis',
													whiteSpace: 'nowrap',
													textDecoration: isOff ? 'line-through' : 'none',
												}}>
													{event.title}
												</span>
												<RecurrenceIcon group={group}/>
												{event.overridden && (
													<span
														onClick={mouseEvent => {
															mouseEvent.stopPropagation();
															onResetEvent(event.id, !mouseEvent.shiftKey);
														}}
														style={{flex: '0 0 auto', color: '#7e22ce', fontWeight: 700}}
													>
														↺
													</span>
												)}
											</div>
										);
									})}
								</div>
							)}

							<div style={{position: 'relative', height: `${bodyHeight}px`}}>
								{/* Hour grid lines */}
								{hours.map(hour => (
									<div
										key={hour}
										style={{
											position: 'absolute',
											top: `${toPixels(hour * 60)}px`,
											left: 0,
											right: 0,
											borderTop: '1px solid #eef0f2',
										}}
									/>
								))}

								{/* Events (left band) */}
								<div style={{
									position: 'absolute',
									top: 0,
									bottom: 0,
									left: 0,
									width: '78%',
									backgroundColor: 'rgba(100, 116, 139, 0.05)',
									borderRight: '1px solid #e5e7eb',
								}}>
									{laidOutEvents.map(({item: event, start, end, lane, lanes}) => {
										const isOff = (calendarStatuses[event.calendarId] || 'off') === 'off';
										const palette = isOff ? offPalette : statusPalette[event.status];
										const clippedTop = event.startDate < windowStart;
										const clippedBottom = event.endDate > windowEnd;
										const group = groupOf(event);
										return (
											<Block
												key={event.id}
												top={toPixels(start)}
												height={toPixels(end) - toPixels(start)}
												lane={lane}
												lanes={lanes}
												palette={palette}
												muted={isOff}
												highlighted={event.overridden}
												hover={hoverHandlers(eventTooltip(event, getCalendarName(event.calendarId), isOff, group))}
												onClick={mouseEvent => {
													cycleEventStatus(event, mouseEvent);
												}}
											>
												<div style={{display: 'flex', alignItems: 'flex-start', gap: '2px'}}>
													<span style={{
														flex: 1,
														minWidth: 0,
														fontWeight: 600,
														textDecoration: isOff ? 'line-through' : 'none',
														overflow: 'hidden',
														textOverflow: 'ellipsis',
														whiteSpace: 'nowrap',
													}}>
														{clippedTop && '▲ '}{event.title}{clippedBottom && ' ▼'}
													</span>
													<RecurrenceIcon group={group}/>
													{event.overridden && (
														<span
															onClick={mouseEvent => {
																mouseEvent.stopPropagation();
																onResetEvent(event.id, !mouseEvent.shiftKey);
															}}
															style={{flex: '0 0 auto', color: '#7e22ce', fontWeight: 700}}
														>
															↺
														</span>
													)}
												</div>
												<div style={{opacity: 0.8}}>{formatTime(event.startDate)}</div>
											</Block>
										);
									})}
								</div>

								{/* Slots (right band) */}
								<div style={{
									position: 'absolute', top: 0, bottom: 0, left: '80%', right: 0,
								}}>
									{laidOutSlots.map(({item: slot, start, end, lane, lanes}) => (
										<Block
											key={slot.id}
											top={toPixels(start)}
											height={toPixels(end) - toPixels(start)}
											lane={lane}
											lanes={lanes}
											palette={statusPalette[slot.status]}
											highlighted={slot.overridden}
											dashed
											hover={hoverHandlers(slotTooltip(slot))}
											onClick={() => {
												onSlotStatusChange(slot.id, cycleStatus(slot.status));
											}}
										>
											{/* Colour alone carries the status here, so the strip can stay
											narrow and leave the width to the events; the details are in the
											tooltip and in the list view. */}
											{slot.overridden && (
												<div
													onClick={event => {
														event.stopPropagation();
														onResetSlot(slot.id);
													}}
													style={{
														textAlign: 'right', cursor: 'pointer', color: '#7e22ce', fontWeight: 700,
													}}
												>
													↺
												</div>
											)}
										</Block>
									))}
								</div>
							</div>
						</div>
					);
				})}
			</div>

			{popup && <HoverPopup text={popup.text} x={popup.x} y={popup.y}/>}
		</div>
	);
}
