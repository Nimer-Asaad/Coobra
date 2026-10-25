/** Cookie holding the admin's API session token. httpOnly: never readable by browser JS. */
export const ADMIN_SESSION_COOKIE = 'coobra_admin_session';
/** Cookie holding the chosen UI language (not sensitive). */
export const LANGUAGE_COOKIE = 'coobra_lang';
export const LANGUAGE_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;
