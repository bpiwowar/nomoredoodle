import {browserAPI} from './browser-compat.js';

/**
 * Failures shown on the poll page itself.
 *
 * The background worker used to report them only as system notifications,
 * which the OS silences whenever the browser is not allowed to notify (the
 * default on macOS) — clicking the toolbar button then seemed to do nothing at
 * all. The page is where the user is looking, so the worker asks the content
 * script to show the reason there, and falls back to a notification only when
 * no content script answers.
 *
 * Plain DOM rather than React: this has to work before (and without) the
 * overlay, and in a shadow root so that the page's styles cannot reach it.
 */

export type ShowErrorMessage = {type: 'showError'; title: string; message: string};

const hostId = 'no-more-doodle-notice';

const style = `
:host { all: initial; }
.notice {
	position: fixed; top: 16px; right: 16px; z-index: 2147483647;
	max-width: 420px; box-sizing: border-box;
	padding: 12px 40px 12px 14px; border-radius: 8px;
	border: 1px solid #f5a3a3; border-left: 4px solid #d93025;
	background: #fff5f5; color: #3c1414;
	font: 14px/1.4 system-ui, -apple-system, sans-serif;
	box-shadow: 0 4px 16px rgba(0, 0, 0, 0.18);
}
.title { font-weight: 600; margin: 0 0 4px; }
.message { margin: 0; white-space: pre-line; }
.close {
	position: absolute; top: 6px; right: 6px;
	border: none; background: none; color: inherit; cursor: pointer;
	font-size: 18px; line-height: 1; padding: 4px 8px; border-radius: 4px;
}
.close:hover { background: rgba(0, 0, 0, 0.08); }
@media (prefers-color-scheme: dark) {
	.notice { background: #3a1d1d; color: #ffe1e1; border-color: #8a3a3a; border-left-color: #ff6b5e; }
	.close:hover { background: rgba(255, 255, 255, 0.12); }
}
`;

/** Shows one notice, replacing the previous one; it stays until dismissed. */
export function showPageError(title: string, message: string) {
	document.querySelector(`#${hostId}`)?.remove();

	const host = document.createElement('div');
	host.id = hostId;
	const shadow = host.attachShadow({mode: 'open'});

	const styleElement = document.createElement('style');
	styleElement.textContent = style;

	const notice = document.createElement('div');
	notice.className = 'notice';
	notice.setAttribute('role', 'alert');

	const titleElement = document.createElement('p');
	titleElement.className = 'title';
	titleElement.textContent = title;

	const messageElement = document.createElement('p');
	messageElement.className = 'message';
	messageElement.textContent = message;

	const close = document.createElement('button');
	close.className = 'close';
	close.type = 'button';
	close.setAttribute('aria-label', 'Dismiss');
	close.textContent = '×';
	close.addEventListener('click', () => {
		host.remove();
	});

	notice.append(titleElement, messageElement, close);
	shadow.append(styleElement, notice);
	document.body.append(host);
}

browserAPI.runtime.onMessage.addListener((message, _sender, sendResponse) => {
	if ((message as {type?: string})?.type !== 'showError') {
		return false;
	}

	const {title, message: text} = message as ShowErrorMessage;
	showPageError(title, text);
	sendResponse({shown: true});
	return false;
});
