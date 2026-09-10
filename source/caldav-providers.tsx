import React from 'react';

/**
 * Where each provider hides its app-password screen, and what address to point
 * at afterwards. The two belong together: a password from the right page is
 * useless against the wrong host, and every provider names both differently.
 *
 * Menu paths drift, which is why every entry carries the provider's own
 * documentation rather than only a transcription of it: when the wording here
 * goes stale, the link is what still answers the question.
 */
export type CalDavProvider = {
	id: string;
	name: string;
	/** Fixed address, offered as a one-click fill. Self-hosted software has none. */
	address?: string;
	/** Shown when the address depends on the installation. */
	addressTemplate?: string;
	usernameHint: string;
	steps: string[];
	note?: string;
	/** The provider's own page on this, checked before being listed. */
	reference: {label: string; href: string};
	/** `none`: the account password is the only one. `unsupported`: no password will work. */
	appPasswords: 'yes' | 'none' | 'unsupported';
};

export const calDavProviders: CalDavProvider[] = [
	{
		id: 'icloud',
		name: 'iCloud',
		address: 'https://caldav.icloud.com',
		usernameHint: 'Your Apple Account email address.',
		appPasswords: 'yes',
		reference: {
			label: 'Apple — Sign in to apps using app-specific passwords',
			href: 'https://support.apple.com/en-us/102654',
		},
		steps: [
			'Sign in to your Apple Account at account.apple.com.',
			'In the “Sign-In and Security” section, select “App-Specific Passwords”.',
			'Select “Generate an app-specific password” and follow the steps, naming it something you will recognise later.',
			'Copy the password Apple shows you. It is displayed once and never again.',
		],
		note: 'Apple only offers app-specific passwords on accounts with two-factor authentication switched on. '
			+ 'Expect the connection test to ask for access twice: iCloud answers for your account from a second, '
			+ 'per-account host such as p137-caldav.icloud.com, and the browser grants one host at a time.',
	},
	{
		id: 'fastmail',
		name: 'Fastmail',
		address: 'https://caldav.fastmail.com',
		usernameHint: 'Your full Fastmail address, including the domain.',
		appPasswords: 'yes',
		reference: {
			label: 'Fastmail — App passwords',
			href: 'https://www.fastmail.help/hc/en-us/articles/360058752854-App-passwords',
		},
		steps: [
			'Sign in and open Settings → Privacy & Security.',
			'Find “Connected apps & API tokens” and choose “Manage app passwords and access”.',
			'Add a new app password and name it.',
			'Narrow what it can reach: the default covers mail, contacts and calendars, and only calendars (CalDAV) is needed here.',
			'Copy the generated password.',
		],
		note: 'Narrowing the access is the point of using an app password — one restricted to calendars cannot read your mail.',
	},
	{
		id: 'nextcloud',
		name: 'Nextcloud / ownCloud',
		addressTemplate: 'https://your-server.example/remote.php/dav',
		usernameHint: 'Your Nextcloud user name — not your email address, unless they happen to match.',
		appPasswords: 'yes',
		reference: {
			label: 'Nextcloud — Managing connected browsers and devices',
			href: 'https://docs.nextcloud.com/server/latest/user_manual/en/session_management.html',
		},
		steps: [
			'Open your personal settings and go to the “Security” tab, which lists the browsers and devices already connected.',
			'At the bottom of that list, create a new device-specific password and give it a name.',
			'Copy the password shown before leaving the page.',
		],
		note: 'Your server prints its own address under Settings → Calendar, as the CalDAV link at the bottom of the sidebar. Copying it from there beats guessing the path.',
	},
	{
		id: 'baikal',
		name: 'Baïkal / SabreDAV',
		addressTemplate: 'https://your-server.example/dav.php',
		usernameHint: 'The user name set in the Baïkal admin panel.',
		appPasswords: 'none',
		reference: {
			label: 'Baïkal — Installation',
			href: 'https://sabre.io/baikal/install/',
		},
		steps: [
			'Use the account password from the Baïkal admin panel — there is no separate app password.',
			'If you want a credential you can revoke on its own, create a second Baïkal user and share the calendars with it.',
		],
		note: '“dav.php” is the single endpoint for both calendars and contacts. A correctly installed Baïkal also '
			+ 'redirects /.well-known/caldav to it, in which case the bare host name is enough here.',
	},
	{
		id: 'radicale',
		name: 'Radicale',
		addressTemplate: 'https://your-server.example:5232/',
		usernameHint: 'The user name in the server’s htpasswd file.',
		appPasswords: 'none',
		reference: {
			label: 'Radicale — Documentation (see “Authentication”)',
			href: 'https://radicale.org/v3.html',
		},
		steps: [
			'Radicale authenticates against whatever its admin configured — usually an htpasswd file. There are no app passwords.',
			'If the server is not yours, ask its admin for an account of your own rather than sharing one.',
		],
		note: 'Port 5232 is the default. Since Radicale 3.5.0 a server with no auth configured refuses every login, so a '
			+ 'rejection may mean the server was never set up rather than that your password is wrong.',
	},
	{
		id: 'google',
		name: 'Google Calendar',
		usernameHint: '—',
		appPasswords: 'unsupported',
		reference: {
			label: 'Google — CalDAV API developer’s guide',
			href: 'https://developers.google.com/calendar/caldav/v2/guide',
		},
		steps: [
			'Google requires OAuth 2.0 for CalDAV: in its own words, “attempting to connect over HTTP or using Basic Authentication results in an HTTP 401 Unauthorized status code”.',
			'No app password will get past that, whichever page you generate it on. This extension does not implement OAuth.',
			'If the calendar is already in the macOS Calendar app, switch on the matching calendar under “macOS calendars” instead — that path works and needs no account here.',
		],
	},
	{
		id: 'other',
		name: 'Something else',
		usernameHint: 'Usually the full email address, sometimes a short user name. Try both.',
		appPasswords: 'yes',
		reference: {
			label: 'RFC 6764 — Locating CalDAV services',
			href: 'https://www.rfc-editor.org/rfc/rfc6764.html',
		},
		steps: [
			'Use the same address your desktop or phone calendar app uses for this account — the whole thing, including any path after the host name.',
			'A server that follows RFC 6764 needs nothing but the domain: the bare host name is tried against /.well-known/caldav here before anything else.',
			'Look in the account’s security settings for “app passwords”, “application passwords”, “device passwords” or “API tokens”. Any of those is the right kind of credential.',
			'If there is no such feature, the account password is the only option.',
		],
	},
];

const badge: Record<CalDavProvider['appPasswords'], {label: string; className: string}> = {
	yes: {label: 'app passwords', className: 'bg-green-100 text-green-800 border-green-300'},
	none: {label: 'account password only', className: 'bg-gray-100 text-gray-600 border-gray-300'},
	unsupported: {label: 'not usable here', className: 'bg-amber-100 text-amber-800 border-amber-300'},
};

/**
 * A picker rather than a wall of text: the seven sets of steps are mutually
 * irrelevant, and the one that matters is the one the reader can name.
 */
export function ProviderHelp({onUseAddress}: {onUseAddress: (address: string) => void}) {
	const [openId, setOpenId] = React.useState<string | undefined>(undefined);
	const open = calDavProviders.find(provider => provider.id === openId);

	return (
		<div className='mb-4 border border-gray-200 rounded'>
			<div className='px-3 py-2 text-sm font-medium text-gray-700 bg-gray-100 border-b border-gray-200'>
				Where do I get an app password?
			</div>
			<div className='p-3'>
				<div className='flex flex-wrap gap-2'>
					{calDavProviders.map(provider => (
						<button
							key={provider.id}
							type='button'
							aria-expanded={provider.id === openId}
							className={`px-2.5 py-1 text-sm border rounded ${provider.id === openId
								? 'bg-blue-600 border-blue-600 text-white'
								: 'bg-white border-gray-300 hover:bg-gray-100'}`}
							onClick={() => {
								setOpenId(current => current === provider.id ? undefined : provider.id);
							}}
						>
							{provider.name}
						</button>
					))}
				</div>

				{open && (
					<div className='mt-3 text-sm text-gray-700'>
						<div className='mb-2'>
							<span className={`px-2 py-0.5 text-xs border rounded ${badge[open.appPasswords].className}`}>
								{badge[open.appPasswords].label}
							</span>
						</div>

						<ol className='list-decimal pl-5 space-y-1'>
							{open.steps.map(step => <li key={step}>{step}</li>)}
						</ol>

						{open.note && <p className='mt-2 text-xs text-gray-500'>{open.note}</p>}

						{open.appPasswords !== 'unsupported' && (
							<dl className='mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs'>
								<dt className='text-gray-500'>Server address</dt>
								<dd>
									{open.address
? (
										<>
											<code className='bg-gray-100 px-1 rounded'>{open.address}</code>
											<button
												type='button'
												className='ml-2 text-blue-600 hover:underline'
												onClick={() => {
													onUseAddress(open.address!);
												}}
											>
												use this
											</button>
										</>
									)
: (
										<code className='bg-gray-100 px-1 rounded'>{open.addressTemplate}</code>
									)}
								</dd>
								<dt className='text-gray-500'>User name</dt>
								<dd>{open.usernameHint}</dd>
							</dl>
						)}

						{/* Last, and always present: the steps above are a transcription with a shelf life. */}
						<p className='mt-3 text-xs'>
							Reference:{' '}
							<a className='text-blue-600 hover:underline' href={open.reference.href} target='_blank' rel='noreferrer'>
								{open.reference.label} ↗
							</a>
						</p>
					</div>
				)}
			</div>
		</div>
	);
}
