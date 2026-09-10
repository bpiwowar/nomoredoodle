import React from 'react';
import {DateTime} from 'luxon';
import {createRoot} from 'react-dom/client';
import {type SelectedCalendars} from './events.js';
import {type SourceListing} from './calendars/types.js';
import {loadCalendarStatuses, saveCalendarStatuses} from './calendars/settings.js';
import {CalendarSelection, CalendarsError, nextStatus} from './calendar-selection.js';
import {ProviderHelp} from './caldav-providers.js';
import {type CalDavCheck} from './calendars/caldav/accounts.js';
import {tailwindCSS} from './tailwind-css.js';
import {browserAPI} from './browser-compat.js';

type AccountSummary = {id: string; label: string; url: string; username: string; lastCheck?: CalDavCheck};
type Draft = {id: string; label: string; url: string; username: string; password: string; lastCheck?: CalDavCheck};
/** How every background request reports a failure it could not turn into a verdict. */
type Failure = {error: string; hint?: string; missingOrigin?: string};

const emptyDraft: Draft = {
	id: '', label: '', url: '', username: '', password: '',
};

async function ask<T>(message: Record<string, unknown>): Promise<T & Partial<Failure>> {
	const send = browserAPI.runtime.sendMessage as (message: any) => Promise<any>;
	return await send(message) as T & Partial<Failure>;
}

/**
 * Match patterns have no notion of a port, so an address like
 * `https://dav.example.org:8443/dav` has to be asked for as the whole host. The
 * scheme is kept: granting `http://` where the user typed `https://` would let
 * the credentials travel in clear if the server ever redirected.
 */
function originPattern(raw: string): string | undefined {
	try {
		return `${new URL(normalizeUrl(raw)).protocol}//${new URL(normalizeUrl(raw)).hostname}/*`;
	} catch {
		return undefined;
	}
}

/** For labelling a permission prompt: `https://p137-caldav.icloud.com/*` → the host. */
function hostOf(pattern: string): string {
	return pattern.replace(/^[a-z]+:\/\//i, '').replace(/\/\*$/, '');
}

/** People type host names, not URLs. Assume TLS rather than silently downgrading. */
function normalizeUrl(raw: string): string {
	const trimmed = raw.trim();
	return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

function Field({label, children, note}: {label: string; children: React.ReactNode; note?: string}) {
	return (
		<label className='block mb-3'>
			<span className='block text-sm font-medium text-gray-700 mb-1'>{label}</span>
			{children}
			{note && <span className='block text-xs text-gray-500 mt-1'>{note}</span>}
		</label>
	);
}

const inputClass = 'w-full px-2 py-1.5 border border-gray-300 rounded text-sm bg-white';
const buttonClass = 'px-3 py-1.5 text-sm border rounded disabled:opacity-50 disabled:cursor-not-allowed';

/** One line of verdict, used compactly in the account list and in full in the form. */
function CheckSummary({check}: {check: CalDavCheck}) {
	const when = DateTime.fromMillis(check.at).toRelative() ?? '';

	if (check.ok) {
		return (
			<span className='text-green-700'>
				✓ {check.calendars} calendar{check.calendars === 1 ? '' : 's'}
				{check.unexpanded && check.unexpanded.length > 0 && (
					<span className='text-amber-700'> · {check.unexpanded.length} without expanded repeats</span>
				)}
				<span className='text-gray-500'> · checked {when}</span>
			</span>
		);
	}

	return (
		<span className='text-red-700'>
			✗ {check.message}
			<span className='text-gray-500'> · {when}</span>
		</span>
	);
}

/**
 * The form's version, which has room for the parts that help you fix it: the
 * calendar names on success, the hint and the grant button on failure.
 */
function CheckReport({check, busy, onRetry}: {check: CalDavCheck; busy: boolean; onRetry: (alsoAllow?: string) => void}) {
	if (!check.ok) {
		return (
			<div className='my-3'>
				<CalendarsError
					message={check.message ?? 'The connection failed.'}
					hint={check.hint}
					retryLabel={check.missingOrigin ? `Allow ${hostOf(check.missingOrigin)} and try again` : undefined}
					onRetry={busy
? undefined
: () => {
						onRetry(check.missingOrigin);
					}}
				/>
			</div>
		);
	}

	return (
		<>
			<div className='my-3 p-3 bg-green-100 border border-green-400 text-green-800 rounded text-sm'>
				<strong>Connected.</strong> {check.calendars} calendar{check.calendars === 1 ? '' : 's'} found
				{check.message ? `: ${check.message}` : ''}
			</div>

			{check.unexpanded && check.unexpanded.length > 0 && (
				<div className='my-3 p-3 bg-amber-100 border border-amber-400 text-amber-800 rounded text-sm'>
					<strong>This server does not expand repeating events.</strong> It returns the
					recurrence rule instead of one entry per occurrence, for: {check.unexpanded.join(', ')}.
					<br/>
					You can still save the account, but a fill that reaches one of those calendars will
					stop with an error rather than answer “yes” to slots it cannot see.
				</div>
			)}
		</>
	);
}

/**
 * `permissions.request` has to be the first thing a click does — Chrome refuses
 * it once the handler has awaited anything, because the user gesture is
 * considered spent. So every path that reaches a server asks for the grant
 * first; when it was already given, the browser answers instantly and silently.
 *
 * `alsoAllow` is a host a previous attempt was redirected to. Asking for it
 * alongside the entered one means the retry cannot fail the same way twice.
 */
async function grant(url: string, alsoAllow?: string): Promise<CalDavCheck | undefined> {
	const entered = originPattern(url);
	if (!entered) {
		return {at: Date.now(), ok: false, message: 'That does not look like a server address.'};
	}

	const granted = await browserAPI.permissions.request({origins: alsoAllow ? [entered, alsoAllow] : [entered]});
	if (granted) {
		return undefined;
	}

	return {
		at: Date.now(),
		ok: false,
		message: `The extension was not allowed to contact ${hostOf(entered)}.`,
		hint: 'Chrome and Firefox will not let an extension reach a server it has no permission for. Try again and accept the prompt.',
	};
}

function AccountForm({draft, onCancel, onSaved}: {
	draft: Draft;
	onCancel: () => void;
	onSaved: () => void;
}) {
	const [values, setValues] = React.useState(draft);
	const [busy, setBusy] = React.useState<'test' | 'save' | undefined>(undefined);
	const [check, setCheck] = React.useState<CalDavCheck | undefined>(draft.lastCheck);

	const editing = Boolean(draft.id);

	// Any edit invalidates the verdict: it was reached with the values as they
	// were, not as they now are.
	const change = (key: keyof Draft, value: string) => {
		setValues(current => ({...current, [key]: value}));
		setCheck(undefined);
	};

	const set = (key: keyof Draft) => (event: React.ChangeEvent<HTMLInputElement>) => {
		change(key, event.target.value);
	};

	const run = async (kind: 'test' | 'save', alsoAllow?: string) => {
		const refused = await grant(values.url, alsoAllow);
		if (refused) {
			setCheck(refused);
			return;
		}

		setBusy(kind);
		try {
			const account = {...values, url: normalizeUrl(values.url)};
			const response = await ask<{check?: CalDavCheck}>({
				type: kind === 'save' ? 'saveCalDavAccount' : 'testCalDavAccount',
				account,
				// Carried so a verdict reached here survives the save and shows up in
				// the account list, without testing the same server twice.
				lastCheck: kind === 'save' ? check : undefined,
			});

			if (response.error) {
				setCheck({
					at: Date.now(), ok: false, message: response.error, hint: response.hint, missingOrigin: response.missingOrigin,
				});
				return;
			}

			if (kind === 'save') {
				onSaved();
				return;
			}

			setValues(account);
			setCheck(response.check);
		} finally {
			setBusy(undefined);
		}
	};

	const complete = values.url.trim() !== '' && values.username.trim() !== ''
		&& (values.password !== '' || editing);

	return (
		<div className='border border-gray-300 rounded p-4 bg-gray-50'>
			<h3 className='font-semibold mb-3'>{editing ? 'Edit account' : 'Add a CalDAV account'}</h3>

			<Field label='Name' note='Only used to label this account in the calendar picker.'>
				<input className={inputClass} value={values.label} placeholder='Work' onChange={set('label')}/>
			</Field>

			<Field label='Server address' note='The address your calendar app uses — for example https://cloud.example.org/remote.php/dav, or just the host name.'>
				<input className={inputClass} value={values.url} placeholder='https://dav.example.org' onChange={set('url')}/>
			</Field>

			<Field label='User name'>
				<input className={inputClass} value={values.username} autoComplete='username' onChange={set('username')}/>
			</Field>

			<Field
				label={editing ? 'Password (leave empty to keep the current one)' : 'Password'}
				note={'Use an app-specific password where your provider issues them — see below. It is stored on this '
					+ 'computer only, never in browser sync, and one scoped to calendars can be revoked without touching '
					+ 'the rest of your account.'}
			>
				<input className={inputClass} type='password' value={values.password} autoComplete='new-password' onChange={set('password')}/>
			</Field>

			<ProviderHelp
				onUseAddress={address => {
					change('url', address);
				}}
			/>

			{check && (
				<CheckReport
					check={check}
					busy={busy !== undefined}
					onRetry={alsoAllow => {
						void run('test', alsoAllow);
					}}
				/>
			)}

			<div className='flex gap-2 mt-4'>
				<button
					type='button'
					className={`${buttonClass} bg-white border-gray-400 hover:bg-gray-100`}
					disabled={!complete || busy !== undefined}
					onClick={() => {
						void run('test');
					}}
				>
					{busy === 'test' ? 'Connecting…' : 'Test connection'}
				</button>
				<button
					type='button'
					className={`${buttonClass} bg-blue-600 border-blue-600 text-white hover:bg-blue-700`}
					disabled={!complete || busy !== undefined}
					onClick={() => {
						void run('save');
					}}
				>
					{busy === 'save' ? 'Saving…' : 'Save'}
				</button>
				<button type='button' className={`${buttonClass} bg-white border-gray-300 hover:bg-gray-100 ml-auto`} onClick={onCancel}>
					Cancel
				</button>
			</div>

			<p className='mt-2 text-xs text-gray-500'>
				Saving does not require a successful test — a server that is down, or behind a VPN that
				is not up yet, should not cost you what you just typed. The account list keeps the result
				of the last attempt, and can retry it at any time.
			</p>
		</div>
	);
}

function Accounts({accounts, onRefresh, onChanged}: {
	accounts: AccountSummary[];
	/** Re-reads the accounts alone; used after a test, which changes nothing else. */
	onRefresh: () => void;
	/** Re-reads everything, including the calendar picker. */
	onChanged: () => void;
}) {
	const [draft, setDraft] = React.useState<Draft | undefined>(undefined);
	const [confirming, setConfirming] = React.useState<string | undefined>(undefined);
	const [testing, setTesting] = React.useState<string | undefined>(undefined);
	const [refused, setRefused] = React.useState<Record<string, CalDavCheck>>({});

	const remove = async (id: string) => {
		await ask({type: 'removeCalDavAccount', id});
		setConfirming(undefined);
		onChanged();
	};

	const test = async (account: AccountSummary, alsoAllow?: string) => {
		const denied = await grant(account.url, alsoAllow);
		if (denied) {
			setRefused(current => ({...current, [account.id]: denied}));
			return;
		}

		setRefused(current => {
			const {[account.id]: _cleared, ...rest} = current;
			return rest;
		});
		setTesting(account.id);
		try {
			// The background records the verdict against the stored account, so the
			// list only has to read it back.
			await ask({type: 'testCalDavAccount', account: {...account, password: ''}});
			onRefresh();
		} finally {
			setTesting(undefined);
		}
	};

	return (
		<section className='mb-8'>
			<h2 className='text-lg font-semibold mb-1'>CalDAV accounts</h2>
			<p className='text-sm text-gray-600 mb-3'>
				Calendars published over CalDAV — Nextcloud, Baïkal, Radicale, iCloud, Fastmail and
				anything else that speaks it. macOS calendars need no account here; they come from the
				native bridge.
			</p>

			{accounts.length === 0 && !draft && (
				<p className='text-sm text-gray-500 mb-3'>No accounts yet.</p>
			)}

			<div className='space-y-2 mb-3'>
				{accounts.map(account => {
					const check = refused[account.id] ?? account.lastCheck;
					return (
						<div key={account.id} className='flex items-center gap-3 p-3 border border-gray-200 rounded'>
							<div className='min-w-0'>
								<div className='font-medium'>{account.label || hostOf(account.url)}</div>
								<div className='text-xs text-gray-500 truncate'>{account.username} · {account.url}</div>
								<div className='text-xs mt-0.5'>
									{testing === account.id
										? <span className='text-gray-500'>Connecting…</span>
										: check
											? <CheckSummary check={check}/>
											: <span className='text-gray-500'>Never tested</span>}
								</div>
							</div>
							<div className='ml-auto flex gap-2 shrink-0'>
								{confirming === account.id
? (
									<>
										<span className='text-sm text-gray-600 self-center'>Remove it?</span>
										<button
											type='button'
											className={`${buttonClass} bg-red-600 border-red-600 text-white hover:bg-red-700`}
											onClick={() => {
												void remove(account.id);
											}}
										>
											Remove
										</button>
										<button
											type='button'
											className={`${buttonClass} bg-white border-gray-300 hover:bg-gray-100`}
											onClick={() => {
												setConfirming(undefined);
											}}
										>
											Keep
										</button>
									</>
								)
: (
									<>
										<button
											type='button'
											className={`${buttonClass} bg-white border-gray-400 hover:bg-gray-100`}
											disabled={testing !== undefined}
											title={check?.hint}
											onClick={() => {
												void test(account, check?.missingOrigin);
											}}
										>
											{check?.missingOrigin ? `Allow ${hostOf(check.missingOrigin)} & test` : 'Test'}
										</button>
										<button
											type='button'
											className={`${buttonClass} bg-white border-gray-300 hover:bg-gray-100`}
											onClick={() => {
												setDraft({...account, password: ''});
											}}
										>
											Edit
										</button>
										<button
											type='button'
											className={`${buttonClass} bg-white border-gray-300 hover:bg-gray-100`}
											onClick={() => {
												setConfirming(account.id);
											}}
										>
											Remove
										</button>
									</>
								)}
							</div>
						</div>
					);
				})}
			</div>

			{draft
? (
				<AccountForm
					key={draft.id || 'new'}
					draft={draft}
					onCancel={() => {
						setDraft(undefined);
					}}
					onSaved={() => {
						setDraft(undefined);
						onChanged();
					}}
				/>
			)
: (
				<button
					type='button'
					className={`${buttonClass} bg-white border-gray-400 hover:bg-gray-100`}
					onClick={() => {
						setDraft(emptyDraft);
					}}
				>
					Add a CalDAV account
				</button>
			)}
		</section>
	);
}

const repository = 'https://github.com/bpiwowar/nomoredoodle';

/**
 * The macOS calendars need a helper binary that the extension cannot install
 * for you, so this is the one source whose setup lives outside the browser.
 * The instructions are here rather than only in the readme because the one piece
 * that cannot be copied from a README is the extension id: it is baked into the
 * host manifest, and an unpacked build gets a fresh one whenever its key changes.
 */
/**
 * Every state the bridge can be in, named. "Not reachable" was previously the
 * fallback for anything that was not a confirmed success, so a listing that had
 * simply not arrived yet — or a source switched off on purpose — was reported as
 * a broken install.
 */
type BridgeState = 'checking' | 'off' | 'error' | 'empty' | 'ok';

function bridgeState(listing: SourceListing | undefined, loading: boolean): BridgeState {
	if (loading || !listing) {
		return 'checking';
	}

	if (!listing.enabled) {
		return 'off';
	}

	if (listing.error) {
		return 'error';
	}

	return listing.groups.some(group => group.calendars.length > 0) ? 'ok' : 'empty';
}

function NativeBridge({listing, loading}: {listing?: SourceListing; loading: boolean}) {
	const [open, setOpen] = React.useState(false);
	const state = bridgeState(listing, loading);
	const calendars = listing?.groups.reduce((total, group) => total + group.calendars.length, 0) ?? 0;
	const id = browserAPI.runtime.id;

	const status = {
		checking: <span className='text-gray-500'>Checking…</span>,
		off: <span className='text-gray-500'>Switched off in the calendar list below — the bridge is not being contacted.</span>,
		error: <span className='text-red-700'>✗ {listing?.error?.message ?? 'Bridge not reachable'}</span>,
		empty: <span className='text-amber-700'>Bridge responding, but it reports no calendars.</span>,
		ok: <span className='text-green-700'>✓ Bridge responding — {calendars} calendar{calendars === 1 ? '' : 's'}</span>,
	}[state];

	return (
		<section className='mb-8'>
			<h2 className='text-lg font-semibold mb-1'>macOS calendars</h2>
			<p className='text-sm text-gray-600 mb-3'>
				Calendars from the macOS Calendar app — iCloud, Exchange, Google and anything else it
				already syncs — read through a small helper program that talks to EventKit. There is no
				account to enter: whatever Calendar.app can see, this can see.
			</p>

			<div className='flex items-center gap-3 p-3 border border-gray-200 rounded'>
				<span className='text-sm'>{status}</span>
				<button
					type='button'
					className={`${buttonClass} bg-white border-gray-400 hover:bg-gray-100 ml-auto`}
					aria-expanded={open}
					onClick={() => {
						setOpen(current => !current);
					}}
				>
					{open ? 'Hide setup' : state === 'error' ? 'How to install it' : 'Setup instructions'}
				</button>
			</div>

			{open && (
				<div className='mt-3 p-3 border border-gray-200 rounded text-sm text-gray-700'>
					<ol className='list-decimal pl-5 space-y-2'>
						<li>
							Clone the repository, or download it from{' '}
							<a className='text-blue-600 hover:underline' href={repository} target='_blank' rel='noreferrer'>
								{repository.replace('https://', '')} ↗
							</a>.
						</li>
						<li>
							Build the bridge and register it for this browser. The id below is this
							install’s own, and the host manifest only answers the extension it names:
							<pre className='mt-2 p-2 bg-gray-100 rounded text-xs overflow-x-auto'>
								{[
									'cd <your nomoredoodle checkout>/bridge',
									'swiftc -framework EventKit calendar-bridge.swift -o calendar-bridge',
									`./calendar-bridge --register --chrome-id ${id}`,
								].join('\n')}
							</pre>
						</li>
						<li>
							Reload the extension, then grant Calendar access when macOS asks. The bridge
							reads calendars and nothing else.
						</li>
					</ol>

					<p className='mt-3 text-xs text-gray-500'>
						An unpacked build gets a new extension id whenever its manifest key changes, so
						re-run the register step if the bridge suddenly stops being recognised. Registering
						for other browsers uses <code className='bg-gray-100 px-1 rounded'>--register-firefox</code>
						{' '}or <code className='bg-gray-100 px-1 rounded'>--register-chromium</code> instead.
					</p>

					{listing?.error?.hint && (
						<pre className='mt-3 p-2 bg-gray-100 rounded text-xs whitespace-pre-wrap'>{listing.error.hint}</pre>
					)}
				</div>
			)}
		</section>
	);
}

function Options() {
	const [accounts, setAccounts] = React.useState<AccountSummary[]>([]);
	const [listings, setListings] = React.useState<SourceListing[]>([]);
	const [statuses, setStatuses] = React.useState<SelectedCalendars>({});
	const [loading, setLoading] = React.useState(true);
	const [failure, setFailure] = React.useState<string | undefined>(undefined);

	const refreshAccounts = React.useCallback(async () => {
		const response = await ask<{accounts?: AccountSummary[]}>({type: 'listCalDavAccounts'});
		setAccounts(response.accounts ?? []);
	}, []);

	const reload = React.useCallback(async () => {
		setLoading(true);
		try {
			const [accountList, sourceList, stored] = await Promise.all([
				ask<{accounts?: AccountSummary[]}>({type: 'listCalDavAccounts'}),
				ask<{listings?: SourceListing[]}>({type: 'listCalendarSources'}),
				loadCalendarStatuses(),
			]);
			setAccounts(accountList.accounts ?? []);
			setListings(sourceList.listings ?? []);
			setStatuses(stored);
			setFailure(accountList.error ?? sourceList.error);
		} finally {
			setLoading(false);
		}
	}, []);

	React.useEffect(() => {
		void reload();
	}, [reload]);

	const cycle = (calendarId: string) => {
		const updated: SelectedCalendars = {
			...statuses,
			[calendarId]: nextStatus(statuses[calendarId] ?? 'off'),
		};
		setStatuses(updated);
		void saveCalendarStatuses(updated);
	};

	const toggleSource = async (sourceId: string, enabled: boolean) => {
		const response = await ask<{listings?: SourceListing[]}>({type: 'setSourceEnabled', sourceId, enabled});
		setListings(response.listings ?? []);
	};

	return (
		<div className='max-w-3xl mx-auto p-6 text-gray-900'>
			<h1 className='text-xl font-bold mb-6'>No More Doodle — calendars</h1>

			{failure && <div className='mb-6'><CalendarsError message={failure} onRetry={reload}/></div>}

			<NativeBridge listing={listings.find(listing => listing.type === 'native')} loading={loading}/>

			<Accounts
				accounts={accounts}
				onRefresh={() => {
					void refreshAccounts();
				}}
				onChanged={() => {
					void reload();
				}}
			/>

			<section>
				<h2 className='text-lg font-semibold mb-1'>Calendars</h2>
				<p className='text-sm text-gray-600 mb-3'>
					Click a calendar to choose what its events mean for a poll slot: off, if need be,
					could be, no, or yes. Switching a whole source off stops it being contacted at all.
				</p>
				<CalendarSelection
					listings={listings}
					statuses={statuses}
					loading={loading}
					onToggleSource={toggleSource}
					onCycleCalendar={cycle}
					onRetry={reload}
				/>
			</section>
		</div>
	);
}

// The same generated stylesheet the in-page overlay injects into its shadow root.
// Reusing it keeps one source of truth for the classes both screens share.
const style = document.createElement('style');
style.textContent = tailwindCSS;
document.head.append(style);

createRoot(document.querySelector('#root')!).render(<Options/>);
