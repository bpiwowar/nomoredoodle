import {browserAPI} from '../../browser-compat.js';

/**
 * The password is kept in `storage.local` and deliberately never in
 * `storage.sync`, which would push it through the browser vendor's sync service.
 * Local storage is still readable by anyone who can read the browser profile, so
 * the options page asks for an app-specific password rather than the account
 * one wherever the provider issues them: that way the credential stored here
 * grants calendar access and nothing else, and can be revoked on its own.
 */
/**
 * The outcome of the last connection attempt, kept so the account list can say
 * what state each account is in without contacting anything. An account is
 * saved whether or not it works, so "never tested" and "tested and failed" are
 * different things and both have to be visible.
 */
export type CalDavCheck = {
	at: number;
	ok: boolean;
	/** How many calendars were found, when it worked. */
	calendars?: number;
	/** Those whose repeating events the server will not expand — see the CalDAV source. */
	unexpanded?: string[];
	message?: string;
	hint?: string;
	/** A host permission that would fix it, if that is all that is missing. */
	missingOrigin?: string;
};

export type CalDavAccount = {
	/** Doubles as the calendar source id, so it must not contain ":". */
	id: string;
	label: string;
	url: string;
	username: string;
	password: string;
	/** Cached result of discovery; re-derived whenever it stops working. */
	homeSet?: string;
	lastCheck?: CalDavCheck;
};

/** What the options page is allowed to see: everything except the secret. */
export type CalDavAccountSummary = Omit<CalDavAccount, 'password' | 'homeSet'>;

const storageKey = 'caldavAccounts';

export function newAccountId(): string {
	return `caldav-${crypto.randomUUID().slice(0, 8)}`;
}

export async function loadAccounts(): Promise<CalDavAccount[]> {
	const stored = await browserAPI.storage.local.get(storageKey) as {caldavAccounts?: CalDavAccount[]};
	return stored.caldavAccounts ?? [];
}

export function summarize(account: CalDavAccount): CalDavAccountSummary {
	return {
		id: account.id,
		label: account.label,
		url: account.url,
		username: account.username,
		lastCheck: account.lastCheck,
	};
}

export async function saveAccount(account: CalDavAccount): Promise<void> {
	const accounts = await loadAccounts();
	const index = accounts.findIndex(candidate => candidate.id === account.id);
	if (index === -1) {
		accounts.push(account);
	} else {
		accounts[index] = account;
	}

	await browserAPI.storage.local.set({[storageKey]: accounts});
}

/** Records what happened last time we tried, leaving the rest of the account alone. */
export async function recordCheck(id: string, check: CalDavCheck): Promise<void> {
	const accounts = await loadAccounts();
	const account = accounts.find(candidate => candidate.id === id);
	if (!account) {
		return;
	}

	account.lastCheck = check;
	await browserAPI.storage.local.set({[storageKey]: accounts});
}

/** Only the cached home set; called on the read path, so it must not disturb anything else. */
export async function rememberHomeSet(id: string, homeSet: string): Promise<void> {
	const accounts = await loadAccounts();
	const account = accounts.find(candidate => candidate.id === id);
	if (!account || account.homeSet === homeSet) {
		return;
	}

	account.homeSet = homeSet;
	await browserAPI.storage.local.set({[storageKey]: accounts});
}

export async function removeAccount(id: string): Promise<void> {
	const accounts = await loadAccounts();
	await browserAPI.storage.local.set({[storageKey]: accounts.filter(account => account.id !== id)});
}
