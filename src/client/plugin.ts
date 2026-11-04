/**
 * Identifiers and the injection list shared by the browser half and its tests.
 *
 * These live in a plain `.ts` module on purpose: the host `tsconfig` excludes
 * `src/client`, so a test that imports a `.tsx` cannot be typechecked without a
 * JSX setting it does not have. Anything a test needs from the browser half
 * belongs here rather than in the component entry.
 *
 * @module dsh-remote-access/client/plugin
 */

/** Dictionary namespace owned by this plugin. */
export const NS = 'dshRemoteAccess'

/** The settings-section id; it is also the slot entry key. */
export const PANEL_ID = 'dshRemoteAccess'

/** Services required by the two registrations. */
export const inject = ['slots', 'locale']