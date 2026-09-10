/** Message names shared between the Timeful content script and its page-world bridge. */

export const TIMEFUL_REFRESH_REQUEST = 'no-more-doodle:timeful-refresh';
export const TIMEFUL_REFRESH_RESPONSE = 'no-more-doodle:timeful-refreshed';

export type TimefulRefreshRequest = {
	type: typeof TIMEFUL_REFRESH_REQUEST;
	id: string;
};

export type TimefulRefreshResponse = {
	type: typeof TIMEFUL_REFRESH_RESPONSE;
	id: string;
	refreshed: boolean;
};
