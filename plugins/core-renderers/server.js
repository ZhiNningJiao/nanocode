/**
 * Core-Renderers plugin — server side.
 *
 * This plugin is browser-only: it registers the default Claude/Codex/Terminal
 * renderers with the client-side renderer registry (see client.js). There is
 * no server-side work to do, so register() is a no-op. It exists only because
 * the server plugin host loads plugins/<name>/server.js uniformly.
 */

export function register(_host) {
  // no server-side behaviour
}
