# Reading Thunderbird calendars

**Status: design. Nothing here is implemented yet.**

The goal is to let the extension use the calendars you keep in Thunderbird, from the browser
you already fill polls in. It is *not* to run the extension inside Thunderbird — see
[Why not a Thunderbird extension](#why-not-a-thunderbird-extension) for why that turns out to be
the worse trade.

Every fact below was checked against a real Thunderbird 128+ profile on macOS. Counts come from
that one profile and are there to give a sense of scale, not as guarantees.

## Why not a Thunderbird extension

The obvious reading of "support Thunderbird" is to ship a third build of this extension as a
MailExtension. That was investigated first and rejected.

- **There is no built-in calendar API.** `browser.calendar` is a *Draft* Experiment API that lives
  outside Thunderbird, in [thunderbird/webext-experiments](https://github.com/thunderbird/webext-experiments/tree/main/calendar),
  tracking [bug 1627205](https://bugzilla.mozilla.org/show_bug.cgi?id=1627205). There is no ETA for
  it landing in core.
- **It would force a Manifest V2 fork.** The experiment's own manifest is `manifest_version: 2`
  (`strict_min_version: 128.0`). Thunderbird also lists declarative `content_scripts` as
  [MV2-only](https://developer.thunderbird.net/add-ons/mailextensions/supported-manifest-keys);
  MV3 wants `scripting.registerContentScripts` at runtime. So the Thunderbird target stops being a
  thin manifest delta and becomes a different extension.
- **Experiment APIs are vendored into the add-on**, have full access to Thunderbird's internals and
  [bypass the permission system](https://developer.thunderbird.net/add-ons/mailextensions/experiments)
  entirely. They break whenever the internals they reach into move.
- **It would barely help.** Thunderbird opens `http` links in the system browser by default. The
  actual flow — poll invitation arrives by email, you click it — lands the poll in Chrome or
  Firefox, where this extension already works. A Thunderbird build only pays off if you
  deliberately open the poll in a Thunderbird content tab.

Reading Thunderbird's calendar store from the browser extension avoids the fork entirely, helps in
the browser where the poll actually opens, and is portable to Linux and Windows — which EventKit
never will be.

## Where Thunderbird keeps calendar data

### Which calendars exist: `prefs.js`

Calendar definitions are not in the database. They are preferences in the profile's `prefs.js`,
one group per calendar UUID:

```js
user_pref("calendar.registry.<uuid>.name", "Work");
user_pref("calendar.registry.<uuid>.type", "caldav");
user_pref("calendar.registry.<uuid>.uri", "https://dav.example.org/calendars/user/work/");
user_pref("calendar.registry.<uuid>.cache.enabled", true);
user_pref("calendar.registry.<uuid>.calendar-main-in-composite", true);
```

`name` and `type` are what the calendar picker needs; the UUID is the `cal_id` used in the
database. Parsing this is a regex over a line-oriented file.

The profile itself is found through `profiles.ini`:

| OS | profile root |
| --- | --- |
| macOS | `~/Library/Thunderbird/` |
| Linux | `~/.thunderbird/` |
| Windows | `%APPDATA%\Thunderbird\` |

### The events: `calendar-data/*.sqlite`

| file | holds |
| --- | --- |
| `cache.sqlite` | the synced copy of every *cached* remote calendar (CalDAV, ICS subscriptions) |
| `local.sqlite` | calendars stored only in Thunderbird |
| `deleted.sqlite` | tombstones, not needed |

On an all-CalDAV profile `local.sqlite` is empty and everything lives in `cache.sqlite`. Both share
one schema, so the reader should query whichever files exist and merge.

Tables that matter:

```
cal_events       cal_recurrence   cal_properties   cal_attendees
cal_todos        cal_alarms       cal_metadata     ...
```

`cal_events` columns:

```
cal_id  id  time_created  last_modified  title  priority  privacy  ical_status  flags
event_start  event_end  event_stamp  event_start_tz  event_end_tz
recurrence_id  recurrence_id_tz  alarm_last_ack  offline_journal
```

Two details to get right:

- **Times are microseconds since the epoch**, not seconds or milliseconds:
  `datetime(event_start / 1000000, 'unixepoch')`.
- **The timezone is a separate column.** `event_start_tz` holds an IANA name such as
  `Europe/Paris`, or `UTC` / a floating marker. The integer is not enough on its own.

### Free/busy

`cal_properties` is a key/value side table, and it carries `TRANSP` (`OPAQUE` / `TRANSPARENT`) for
most events. That is the same signal the EventKit bridge already maps to `bridgeStatus`, so the
extension needs no new concept:

```sql
SELECT value FROM cal_properties WHERE item_id = ? AND key = 'TRANSP';
```

Some events instead carry `X-MICROSOFT-CDO-BUSYSTATUS`, worth reading as a fallback.

## The lock problem

Thunderbird holds the calendar database open with an exclusive lock. This is the single thing that
most needs to be got right, so all four approaches were measured against a live, running
Thunderbird:

| approach | result |
| --- | --- |
| `file:cache.sqlite?mode=ro` | ❌ `database is locked (5)` |
| `file:cache.sqlite?mode=ro&nolock=1` | ❌ `unable to open database file (14)` |
| `file:cache.sqlite?immutable=1` | ⚠️ opens, but **ignores the `-wal` file** and so silently misses recent changes |
| **copy `cache.sqlite` *and* `cache.sqlite-wal`, then open the copy** | ✅ complete and current |

`immutable=1` is a trap: it works, returns almost everything, and quietly omits whatever is still
in the write-ahead log — exactly the meeting you just accepted.

**So: snapshot-copy both files to a temporary directory, read the copy, delete it.** On APFS the
copy is a copy-on-write clone and takes no measurable time even for a database in the tens of
megabytes. Copy the `-shm` file too if present.

## Recurrence: the real cost

This is the one genuinely hard part, and the reason to plan before coding.

EventKit hands us expanded occurrences. Thunderbird does not — `cal_recurrence` stores raw iCalendar
lines, one row per line, keyed by `item_id`:

```
item_id  cal_id  icalString
```

where `icalString` is a single line such as `RRULE:FREQ=WEEKLY;UNTIL=20251111T225959Z`,
`EXDATE;TZID=Europe/Paris:20250903T143000`, or an `RDATE`. On the profile checked, 579 such rows
covered 487 distinct rule shapes, of which 453 were `EXDATE`s and 18 `RDATE`s — real calendars are
mostly exceptions.

Separately, **modified occurrences are stored as their own rows in `cal_events`** with
`recurrence_id` set to the occurrence they replace (110 of 2667 rows). A correct expansion must:

1. take the master's `RRULE`, applied in `event_start_tz`,
2. add `RDATE`s, subtract `EXDATE`s,
3. clip to the window the poll asks about,
4. and then replace any occurrence that has an override row, or drop it if the override cancels it.

### Where the expansion belongs

**Not in the native host.** The host should stay dumb: locate the profile, snapshot, query, and emit
raw rows plus their `icalString`s. The extension expands them, because that is where mature
libraries exist:

- [`rrule`](https://www.npmjs.com/package/rrule) handles `RRULE`/`EXDATE`/`RDATE`.
- `luxon` handles the timezone arithmetic — and is **already a declared dependency of this project**
  that nothing currently imports.

Hand-rolling RRULE expansion, in any language, is how this feature would get quietly wrong.

## Language and process layout

Swift is not a choice for the EventKit half — there is no stable C API for EventKit, so it is Swift
or Objective-C. That stays as it is.

Nothing about the Thunderbird half wants Swift. It needs `profiles.ini`, a regex over `prefs.js`, a
file copy, SQLite, and length-prefixed JSON on stdio. Writing that in Swift means the C SQLite API
with `UnsafePointer` casts, for no benefit, and it would compile the one inherently cross-platform
piece of this project into a macOS binary.

**Two native messaging hosts, one per calendar source:**

| host | language | source | needs |
| --- | --- | --- | --- |
| `fr.piwowarski.calendar.bridge` | Swift + EventKit | macOS system calendars | Xcode CLT to build |
| `fr.piwowarski.thunderbird.bridge` | **Python 3, stdlib only** | Thunderbird profile | `python3`, no compile step |

Python over Node here because `sqlite3`, `json` and `configparser` are all standard library, so
there is no `npm install` and no version floor: Node's built-in `node:sqlite` was only added in
v22.5.0 and is still a release candidate, while `.nvmrc` pins 18. Node's one advantage — same language as the extension — is moot, since the
recurrence expansion lives in the extension either way.

The side effect is the valuable one: **the Thunderbird source needs no compiler at all.** Today the
readme asks users to install Xcode command line tools and run `swiftc`. Someone who only wants
their Thunderbird calendars skips the toolchain entirely, and a Linux user gets the feature from a
script and one registration command.

This also keeps the Swift binary a thin EventKit wrapper rather than growing a second, unrelated
job.

## Plan

1. **`CalendarSource` abstraction** in `source/native-calendar.ts`. `getCalendars()` and
   `getEvents()` move behind it, picking a host by a stored setting. EventKit stays the default.
2. **`bridge/thunderbird-bridge.py`** — same native messaging framing as the Swift host, with
   `--register` / `--register-firefox` / `--register-chrome` mirroring it. Actions:
   `listCalendars` (profile + `prefs.js`) and `getEvents` (snapshot, query, return raw rows plus
   `icalString`s and `TRANSP`).
3. **Expansion in the extension** — `rrule` + `luxon`, mapping `TRANSP`/`X-MICROSOFT-CDO-BUSYSTATUS`
   to `bridgeStatus`, and applying `recurrence_id` overrides.
4. **A source selector** in the overlay's Calendars tab, so both sources can be listed and switched.

Steps 1 and 3 are independent of the host and can be built and tested first, against fixtures.

## Open questions

- **Which profile?** `profiles.ini` can list several, and `Default=` is not always what the user
  runs. Probably: use the default, but let the setting override it with an explicit path.
- **Uncached calendars.** A CalDAV calendar with `cache.enabled = false` has nothing in
  `cache.sqlite`. Those should be listed as unavailable rather than silently returning no events.
- **Thunderbird not installed / no profile.** Must produce the same kind of actionable
  `NativeBridgeError` hint the missing-host case already does, rather than an empty calendar list.
- **`python3` on a bare macOS** is a Xcode CLT stub that prompts to install. That is still a
  strictly smaller ask than `swiftc`, but the registration script should fail with a clear message.
- **Windows** needs a `.bat` shim for the native messaging host, and the registry rather than a
  manifest directory. Out of scope for the first pass, but the Python host makes it reachable.
