import {test} from 'node:test';
import assert from 'node:assert';
import {
asArray, davHref, davResources, parseDavXml,
} from '../source/calendars/caldav/dav.js';
import {parseCalendar} from '../source/calendars/caldav/ics.js';

const base = 'https://dav.example.org/dav/user/';

function resources(xml: string, url = base) {
	return davResources({body: parseDavXml(xml), url});
}

/**
 * Namespace prefixes are the server's choice, so the same document arrives as
 * `D:`, `d:` or no prefix at all depending on who answered. Everything below is
 * written against the stripped names, which is the only way one reader copes
 * with all three.
 */
const multistatus = `<?xml version="1.0"?>
<D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
	<D:response>
		<D:href>/dav/user/</D:href>
		<D:propstat><D:status>HTTP/1.1 200 OK</D:status>
			<D:prop><D:resourcetype><D:collection/></D:resourcetype></D:prop>
		</D:propstat>
		<D:propstat><D:status>HTTP/1.1 404 Not Found</D:status>
			<D:prop><D:displayname/></D:prop>
		</D:propstat>
	</D:response>
	<D:response>
		<D:href>/dav/user/work/</D:href>
		<D:propstat><D:status>HTTP/1.1 200 OK</D:status>
			<D:prop>
				<D:displayname>Work</D:displayname>
				<D:resourcetype><D:collection/><C:calendar/></D:resourcetype>
				<C:supported-calendar-component-set><C:comp name="VEVENT"/></C:supported-calendar-component-set>
			</D:prop>
		</D:propstat>
	</D:response>
</D:multistatus>`;

test('relative hrefs are resolved against where the answer came from', () => {
	assert.deepStrictEqual(resources(multistatus).map(resource => resource.href), [
		'https://dav.example.org/dav/user/',
		'https://dav.example.org/dav/user/work/',
	]);
});

test('a 404 propstat block is not merged into the successful one', () => {
	// Asking for a property the server does not have produces a 404 block beside
	// the 200 one. Merging both would turn "absent" into "present but empty".
	const [home, work] = resources(multistatus);
	assert.ok(!('displayname' in home.props));
	assert.strictEqual(work.props.displayname, 'Work');
});

test('resourcetype and the component set survive prefix stripping', () => {
	const [home, work] = resources(multistatus);
	assert.ok('calendar' in work.props.resourcetype);
	assert.ok(!('calendar' in home.props.resourcetype));
	assert.strictEqual(asArray(work.props['supported-calendar-component-set'].comp)[0]['@name'], 'VEVENT');
});

test('an unprefixed document reads identically', () => {
	const bare = `<multistatus xmlns="DAV:"><response><href>/dav/user/home/</href>
		<propstat><status>HTTP/1.1 200 OK</status><prop><displayname>Home</displayname></prop></propstat>
		</response></multistatus>`;
	assert.strictEqual(resources(bare)[0].props.displayname, 'Home');
});

test('an absolute href on another host is kept, which is how iCloud hands off', () => {
	const elsewhere = `<multistatus xmlns="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
		<response><href>/1234567/principal/</href><propstat><status>HTTP/1.1 200 OK</status>
		<prop><C:calendar-home-set><href>https://p137-caldav.icloud.com/1234567/calendars/</href></C:calendar-home-set></prop>
		</propstat></response></multistatus>`;
	const [resource] = resources(elsewhere, 'https://caldav.icloud.com/1234567/principal/');
	assert.strictEqual(
		davHref(resource.props['calendar-home-set'], resource.href),
		'https://p137-caldav.icloud.com/1234567/calendars/',
	);
});

test('calendar-data arrives as text with its entities decoded', () => {
	// Servers encode the iCalendar CRLFs as &#13;. Left undecoded, the line
	// breaks become the literal text "&#13;" and every event disappears.
	const report = `<multistatus xmlns="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
		<response><href>/dav/user/work/a.ics</href>
			<propstat><status>HTTP/1.1 200 OK</status>
				<prop><C:calendar-data>BEGIN:VCALENDAR&#13;
BEGIN:VEVENT&#13;
UID:e&#13;
SUMMARY:Tom &amp; Jerry&#13;
DTSTART:20260921T080000Z&#13;
DTEND:20260921T090000Z&#13;
END:VEVENT&#13;
END:VCALENDAR</C:calendar-data></prop>
			</propstat></response></multistatus>`;
	const events = parseCalendar(resources(report)[0].props['calendar-data'], 'c').events;
	assert.strictEqual(events.length, 1);
	assert.strictEqual(events[0].title, 'Tom & Jerry');
});

test('a response with no successful propstat yields no properties', () => {
	const forbidden = `<multistatus xmlns="DAV:"><response><href>/dav/other/</href>
		<propstat><status>HTTP/1.1 403 Forbidden</status><prop><displayname>Secret</displayname></prop></propstat>
		</response></multistatus>`;
	assert.deepStrictEqual(resources(forbidden)[0].props, {});
});
