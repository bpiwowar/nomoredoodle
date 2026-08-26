# No More Doodle Firefox extension

Based on the [browser extension template](https://github.com/fregante/browser-extension-template).

## Usage

### macOS

A native macOS bridge (so that your calendar can be read) must be built (there is no binary for that). Go into the `bridge` directory, and type

```sh
swiftc -framework EventKit calendar-bridge.swift -o calendar-bridge
```

Move the binary wherever you want, and then register it for your browser(s):

**For Firefox:**
```sh
./calendar-bridge --register-firefox
```

**For Chrome:**
```sh
./calendar-bridge --register-chrome
```

**For Chromium:**
```sh
./calendar-bridge --register-chromium
```

**For all browsers at once:**
```sh
./calendar-bridge --register
```

You should see output like:
```txt
Native host registered for firefox at /Users/.../Library/Application Support/Mozilla/NativeMessagingHosts/fr.piwowarski.calendar.bridge.json
Native host registered for chrome at /Users/.../Library/Application Support/Google/Chrome/NativeMessagingHosts/fr.piwowarski.calendar.bridge.json
Native host registered for chromium at /Users/.../Library/Application Support/Chromium/NativeMessagingHosts/fr.piwowarski.calendar.bridge.json
```

**Note for Chrome users:** After installing the extension in Chrome, you may need to update the bridge's manifest file to include your extension's ID. The extension ID can be found on `chrome://extensions/` when you load the extension.

## Screenshots

The overlay opens on the poll page, lining your calendar up against the poll's options.

![The calendar view: each day shows calendar events on the left and poll slots as dashed colour bars on the right, on a shared time axis](media/calendar.png)

The same slots as a list, with the events that clash with each one spelled out.

![The list view, showing each slot with its computed status and its intersecting events](media/list.png)

Each calendar gets a status, which decides what its events do to a slot.

![The calendar selection tab, with calendars grouped by provider and a status legend](media/calendars-tab.png)

## Roadmap

- [Reading Thunderbird calendars](thunderbird.md) — design for using the calendars you keep in
  Thunderbird from the browser, instead of shipping a Thunderbird build. Not implemented yet.

## Development

### 🛠 Build locally

1. Checkout the copied repository to your local machine eg. with `git clone https://github.com/bpiwowar/nomoredoodle`
2. Run `npm install` to install all required dependencies
3. Run `npm run build`

The build step empties `distribution/` and writes one self-contained package per browser:

    distribution/chrome/     load this one in Chrome/Chromium
    distribution/firefox/    load this one in Firefox

Each gets its own `manifest.json`, generated from the shared `source/manifest.json` by
`helpers/generate-manifests.mjs`. One manifest cannot serve both stores: Chrome rejects
`background.scripts` ("requires manifest version of 2 or lower") while Firefox has no service
worker background and needs exactly that key. The generator starts from the shared manifest and
drops what each browser does not understand.

**To add a browser**, add an entry to the `targets` table in that script and a matching Parcel
target in `package.json`. Note that the two targets are built by *separate* Parcel invocations
(`build:chrome`, `build:firefox`): in a single run Parcel deduplicates the assets both share into
one `distDir` and cross-references them, which leaves the other package pointing at
`../<browser>/` and unloadable.

### ✅ Check store compliance

`npm test` lints the sources, builds, and then runs [`web-ext lint`](https://extensionworkshop.com/documentation/develop/web-ext-command-reference/#web-ext-lint)
(the same [addons-linter](https://github.com/mozilla/addons-linter) that addons.mozilla.org runs on
submission) over `distribution/firefox`. Run it on its own with `npm run lint:ext` after a build.

It should report **0 errors**. The remaining warnings are expected:

- `KEY_FIREFOX_*_UNSUPPORTED_BY_MIN_VERSION` ×2 — `data_collection_permissions` is required for new
  submissions but only understood from Firefox 140; older versions, which `strict_min_version` still
  supports, ignore it.
- `UNSAFE_VAR_ASSIGNMENT` ×2 — `innerHTML` inside the bundled `react-dom`, not in this extension's code.

Chrome has no equivalent command-line checker, but loading `distribution/chrome` unpacked at
`chrome://extensions/` surfaces any manifest complaint at the top of the extension's card.

### 🏃 Run the extension

**For Firefox:**
Using [web-ext](https://extensionworkshop.com/documentation/develop/getting-started-with-web-ext/) is recommended for automatic reloading.

1. Run `npm run watch` to watch for file changes and build continuously
1. In another terminal, run: `npx web-ext run -t firefox-desktop`

**For Chrome/Chromium:**
Due to native messaging limitations with temporary profiles, you need to load the extension manually:

1. Run `npm run watch` to watch for file changes and build continuously
1. Open Chrome/Chromium
1. Go to `chrome://extensions/`
1. Enable "Developer mode" (toggle in top-right)
1. Click "Load unpacked"
1. Select the `distribution/chrome` folder
1. The extension will auto-reload when you make changes (just refresh if needed)

**Note:** Make sure you've registered the native bridge for your target browser (see Usage section above).


### 📕 Read the documentation

Here are some websites you should refer to:

- [Parcel’s Web Extension transformer documentation](https://parceljs.org/recipes/web-extension/)
- [Chrome extensions’ API list](https://developer.chrome.com/docs/extensions/reference/)
- A lot more links in my [Awesome WebExtensions](https://github.com/fregante/Awesome-WebExtensions) list

### Auto-syncing options

Options are managed by [fregante/webext-options-sync][link-options-sync], which auto-saves and auto-restores the options form, applies defaults and runs migrations.

### Publishing

It's possible to automatically publish to both the Chrome Web Store and Mozilla Addons at once by adding these secrets on GitHub Actions:

1. `CLIENT_ID`, `CLIENT_SECRET`, and `REFRESH_TOKEN` from [Google APIs][link-cws-keys].
2. `WEB_EXT_API_KEY`, and `WEB_EXT_API_SECRET` from [AMO][link-amo-keys].

Also include `EXTENSION_ID` in the secrets ([how to find it](https://stackoverflow.com/a/8946415/288906)) and add Mozilla’s [`gecko.id`](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/browser_specific_settings) to `manifest.json`.

The GitHub Actions workflow will:

1. Build the extension
2. Create a version number based on the current UTC date time, like [`19.6.16`](https://github.com/fregante/daily-version-action) and sets it in the manifest.json
3. Deploy it to both stores

#### Auto-publishing

Thanks to the included [GitHub Action Workflows](.github/workflows), if you set up those secrets in the repo's Settings, the deployment will automatically happen:

- on a schedule, by default [every week](.github/workflows/release.yml) (but only if there are any new commits in the last tag)
- manually, by clicking ["Run workflow"](https://github.blog/changelog/2020-07-06-github-actions-manual-triggers-with-workflow_dispatch/) in the Actions tab.


## License

This plugin is licensed under the MIT License.