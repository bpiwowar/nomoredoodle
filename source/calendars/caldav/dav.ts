import {XMLParser} from 'fast-xml-parser';
import {browserAPI} from '../../browser-compat.js';

export class CalDavError extends Error {
	/** What to do about it, when there is something to do. */
	readonly hint?: string;
	/** The HTTP status behind it, when there was one. 401 is the only one callers branch on. */
	readonly status?: number;
	/** Set when the only thing missing is a host permission — see {@link davRequest}. */
	readonly missingOrigin?: string;

	// Written out rather than as constructor parameter properties: those are one
	// of the few TypeScript constructs Node's type stripping cannot erase, and
	// the unit tests import this file directly rather than a compiled copy.
	constructor(message: string, hint?: string, status?: number, missingOrigin?: string) {
		super(message);
		this.name = 'CalDavError';
		this.hint = hint;
		this.status = status;
		this.missingOrigin = missingOrigin;
	}
}

/**
 * The match pattern covering one host. Patterns carry no port, so `:5232` and
 * `:443` on the same name are one grant, and a host is never widened to its
 * parent domain: `*.example.com` would hand over every subdomain at once.
 */
export function originPatternFor(url: string): string {
	const {protocol, hostname} = new URL(url);
	return `${protocol}//${hostname}/*`;
}

export type CalDavCredentials = {
	url: string;
	username: string;
	password: string;
};

/**
 * Namespace prefixes are chosen by the server, not by us: the same property is
 * `<d:href>` from SabreDAV, `<D:href>` from Cyrus and `<href>` from Radicale.
 * Stripping the prefix is what lets one set of property names read them all —
 * safe here because CalDAV never puts two different namespaces on the same
 * local name in the responses we ask for.
 */
const parser = new XMLParser({
	removeNSPrefix: true,
	ignoreAttributes: false,
	attributeNamePrefix: '@',
	parseTagValue: false,
	parseAttributeValue: false,
	trimValues: true,
	// Servers wrap iCalendar data with CRLF encoded as `&#13;`, and the parser
	// leaves numeric character references alone unless this is on — which would
	// hand the ICS reader a document whose line breaks are the literal text
	// "&#13;" and make every event vanish.
	htmlEntities: true,
});

/** Exposed so that response handling can be exercised without a server. */
export function parseDavXml(text: string): any {
	return parser.parse(text);
}

export function asArray<T>(value: T | T[] | undefined): T[] {
	if (value === undefined) {
		return [];
	}

	return Array.isArray(value) ? value : [value];
}

/** Credentials are sent up front: waiting for a 401 makes the browser show its own login dialog. */
function authorization({username, password}: CalDavCredentials): string {
	const bytes = new TextEncoder().encode(`${username}:${password}`);
	let binary = '';
	for (const byte of bytes) {
		binary += String.fromCodePoint(byte);
	}

	// The platform's own base64, and the only one available in a service worker
	// without pulling in a Node polyfill. The lint rule that flags `btoa` is aimed
	// at Node code, where Buffer exists instead.
	// eslint-disable-next-line no-restricted-globals
	return `Basic ${btoa(binary)}`;
}

export type DavResult = {
	body: any;
	/** Where the answer actually came from, which is what relative hrefs resolve against. */
	url: string;
};

export async function davRequest(
	account: CalDavCredentials,
	method: 'PROPFIND' | 'REPORT' | 'OPTIONS',
	url: string,
	{depth = '0', body}: {depth?: '0' | '1'; body?: string} = {},
): Promise<DavResult> {
	// Discovery legitimately moves between hosts — iCloud answers for the
	// principal on caldav.icloud.com and then names a per-account host such as
	// p137-caldav.icloud.com for the calendars themselves — and a permission is
	// granted one host at a time. Without this check the second host fails as an
	// opaque CORS rejection, which reaches the user as "could not reach", blaming
	// the network for what is a missing grant.
	const origins = [originPatternFor(url)];
	if (!await browserAPI.permissions.contains({origins})) {
		throw new CalDavError(
			`The extension has not been allowed to contact ${new URL(url).host}.`,
			[
				`This account is served from ${new URL(url).host}, which is not the address you`,
				'entered — CalDAV servers routinely hand off to another host, and the browser',
				'grants access to one host at a time.',
				'',
				'Nothing is stored until the connection works, so allowing it and trying again',
				'is safe.',
			].join('\n'),
			undefined,
			origins[0],
		);
	}

	let response: Response;
	try {
		response = await fetch(url, {
			method,
			headers: {
				Authorization: authorization(account),
				Depth: depth,
				'Content-Type': 'application/xml; charset=utf-8',
			},
			body,
			// Otherwise the browser attaches whatever session cookie the user has
			// for that host, and a server may answer as the wrong account.
			credentials: 'omit',
			redirect: 'follow',
		});
	} catch (error) {
		throw new CalDavError(
			`Could not reach ${new URL(url).host}.`,
			[
				(error as Error)?.message ?? 'The request failed.',
				'',
				'Check that the address is right, that the server is reachable from this machine,',
				'and that you granted the extension access to it when asked.',
			].join('\n'),
		);
	}

	if (response.status === 401 || response.status === 403) {
		throw new CalDavError(
			response.status === 401
				? 'The server rejected these credentials (HTTP 401).'
				: `The server refused access to ${url} (HTTP 403).`,
			[
				'Check the user name, and use an app-specific password if your provider issues one.',
				'The options page lists where to find them, per provider, with a link to each',
				'provider\'s own documentation.',
				'',
				'An account password is often refused outright where two-factor authentication is on.',
			].join('\n'),
			response.status,
		);
	}

	if (response.status === 404) {
		throw new CalDavError(`Nothing is published at ${url} (HTTP 404).`, undefined, 404);
	}

	if (!response.ok) {
		throw new CalDavError(
			`${method} ${url} failed: HTTP ${response.status} ${response.statusText}`,
			undefined,
			response.status,
		);
	}

	const text = await response.text();
	try {
		return {body: parseDavXml(text), url: response.url || url};
	} catch (error) {
		throw new CalDavError(
			`${new URL(url).host} answered with something that is not XML.`,
			(error as Error)?.message,
		);
	}
}

export type DavResource = {
	href: string;
	props: Record<string, any>;
};

/**
 * Flattens a `<multistatus>` into one entry per resource.
 *
 * A response is split into several `<propstat>` blocks by status, and asking for
 * a property the server does not have produces a 404 block next to the 200 one.
 * Only the successful blocks are merged, so a missing property reads as absent
 * rather than as an empty value.
 */
export function davResources({body, url}: DavResult): DavResource[] {
	return asArray(body?.multistatus?.response).flatMap((response: any) => {
		const href = response?.href;
		if (typeof href !== 'string' && typeof href !== 'number') {
			return [];
		}

		const props: Record<string, any> = {};
		for (const propstat of asArray(response.propstat)) {
			if (/\s2\d\d\s/.test(` ${String(propstat?.status ?? '')} `)) {
				Object.assign(props, propstat.prop);
			}
		}

		return [{href: new URL(String(href), url).href, props}];
	});
}

/** DAV hrefs may be paths, so every one of them is resolved before it is compared or used. */
export function davHref(property: any, base: string): string | undefined {
	const href = property?.href;
	return href === undefined || href === null || href === '' ? undefined : new URL(String(href), base).href;
}
