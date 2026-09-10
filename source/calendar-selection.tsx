import React from 'react';
import {type OptionsCalendarStatus} from './events.js';
import {type SourceListing} from './calendars/types.js';

export const Statuses: OptionsCalendarStatus[] = ['off', 'if-need-be', 'could-be', 'no', 'yes'];

export function nextStatus(status: OptionsCalendarStatus): OptionsCalendarStatus {
	const index = Statuses.indexOf(status);
	return Statuses[(index + 1) % Statuses.length];
}

/**
 * `description` says what the mode does to a slot rather than restating its
 * name. The icons alone are a cipher — five coloured squares in an order nobody
 * can be expected to infer — and the row has room for the answer.
 */
export const statusIcon: Record<OptionsCalendarStatus, {icon: string; label: string; description: string}> = {
	off: {icon: '⬜', label: 'Off', description: 'ignored — its events never affect a slot'},
	'if-need-be': {icon: '🟦', label: 'If need be', description: 'slots it covers are answered “if need be”'},
	'could-be': {icon: '🟩', label: 'Could be', description: 'slots it covers are answered “could be”'},
	no: {icon: '❌', label: 'No', description: 'slots it covers are answered “no”'},
	yes: {icon: '✅', label: 'Yes', description: 'slots it covers stay “yes”'},
};

export const StatusIcon: React.FC<{status: OptionsCalendarStatus}> = ({status}) => <span title={statusIcon[status].label}>{statusIcon[status].icon}</span>;

/** A source failing is usually a setup problem, so its fix goes on screen with it. */
export function CalendarsError({message, hint, onRetry, retryLabel}: {
	message: string;
	hint?: string;
	onRetry?: () => void;
	/** Overrides "Retry" when the button does something more specific, such as granting access to a host. */
	retryLabel?: string;
}) {
	return (
		<div className='p-4 bg-red-100 border border-red-400 text-red-700 rounded'>
			<strong>Error:</strong> {message}
			{hint && (
				<pre style={{
					marginTop: '10px',
					padding: '10px',
					backgroundColor: '#fff',
					border: '1px solid #fca5a5',
					borderRadius: '4px',
					fontSize: '11px',
					lineHeight: '1.45',
					whiteSpace: 'pre-wrap',
					overflowWrap: 'anywhere',
					color: '#7f1d1d',
				}}>
					{hint}
				</pre>
			)}
			{onRetry && (
				<button
					type='button'
					className='mt-3 px-3 py-1 text-sm bg-white border border-red-400 rounded hover:bg-red-50'
					onClick={onRetry}
				>
					{retryLabel ?? 'Retry'}
				</button>
			)}
		</div>
	);
}

const sourceTypeLabel: Record<SourceListing['type'], string> = {
	native: 'native',
	caldav: 'CalDAV',
};

function SourceToggle({enabled, onChange}: {enabled: boolean; onChange: (enabled: boolean) => void}) {
	return (
		<label className='flex items-center gap-2 cursor-pointer' title={enabled ? 'Switch this source off' : 'Switch this source on'}>
			<input
				type='checkbox'
				checked={enabled}
				className='w-4 h-4 cursor-pointer'
				onChange={event => {
					onChange(event.target.checked);
				}}
			/>
		</label>
	);
}

/**
 * Shared by the in-page overlay and (later) the options page, so it stays
 * presentational: no storage, no messaging, and nothing that assumes whether it
 * is mounted in a shadow root or a normal page.
 */
export function CalendarSelection({
	listings, statuses, loading, onToggleSource, onCycleCalendar, onRetry,
}: {
	listings: SourceListing[];
	statuses: Record<string, OptionsCalendarStatus>;
	loading?: boolean;
	onToggleSource: (sourceId: string, enabled: boolean) => void;
	onCycleCalendar: (calendarId: string) => void;
	onRetry?: () => void;
}) {
	const anyCalendarOn = listings.some(listing => listing.enabled
		&& listing.groups.some(group => group.calendars.some(calendar => (statuses[calendar.id] ?? 'off') !== 'off')));
	const anyCalendarAtAll = listings.some(listing => listing.groups.some(group => group.calendars.length > 0));

	if (loading) {
		return <div className='text-center text-gray-500 py-4'>Loading calendars…</div>;
	}

	return (
		<div className='space-y-4'>
			{anyCalendarAtAll && !anyCalendarOn && (
				<div className='p-3 bg-amber-100 border border-amber-400 text-amber-800 rounded text-sm'>
					No calendar is switched on, so nothing will block a slot and every slot will be
					answered “yes”. Click a calendar below to use it.
				</div>
			)}

			{listings.map(listing => (
				<div key={listing.sourceId} className='border border-gray-200 rounded'>
					<div className='flex items-center gap-3 p-3 bg-gray-50 border-b border-gray-200'>
						<SourceToggle
							enabled={listing.enabled}
							onChange={enabled => {
								onToggleSource(listing.sourceId, enabled);
							}}
						/>
						<span className='font-bold text-base text-gray-800'>{listing.label}</span>
						<span className='text-xs text-gray-500 uppercase tracking-wide'>{sourceTypeLabel[listing.type]}</span>
						{!listing.enabled && <span className='text-xs text-gray-500 ml-auto'>off — not contacted</span>}
					</div>

					{listing.enabled && (
						<div className='p-3'>
							{listing.error
								? <CalendarsError message={listing.error.message} hint={listing.error.hint} onRetry={onRetry}/>
								: listing.groups.length === 0
									? <div className='text-sm text-gray-500'>No calendars found</div>
									: listing.groups.map(group => (
										<div key={group.id} className='mb-3 last:mb-0'>
											{group.label !== listing.label && (
												<div className='font-semibold mb-2 text-sm text-gray-700'>{group.label}</div>
											)}
											{group.calendars.map(calendar => {
												const status = statuses[calendar.id] ?? 'off';
												return (
													<div
														key={calendar.id}
														className='flex items-center gap-3 mb-2 p-3 hover:bg-gray-100 cursor-pointer rounded border border-gray-200'
														title='Click to change'
														onClick={() => {
															onCycleCalendar(calendar.id);
														}}
													>
														<StatusIcon status={status}/>
														<div className='min-w-0'>
															<div className='text-base'>{calendar.title}</div>
															<div className='text-xs'>
																<span className='text-gray-600 font-medium'>{statusIcon[status].label}</span>
																<span className='text-gray-400'> — {statusIcon[status].description}</span>
															</div>
														</div>
													</div>
												);
											})}
										</div>
									))}
						</div>
					)}
				</div>
			))}
		</div>
	);
}
