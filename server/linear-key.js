/**
 * The one place the server resolves the task-tracker (Linear) API key.
 *
 * Both Linear readers — the command-center big-event source and the Linear →
 * ntfy notifier — call this, so "the cockpit sees Linear but the notifier says
 * no key" can no longer happen. The key goes through the plugin permission
 * gate (the command-center manifest declares personal.linear) and stays
 * server-side; it is never serialized to the browser.
 */
import { loadPersonalConfig, resolvePluginSecrets } from '../terminal/personal-config.js'
import { builtinPlugin } from '../public/js/plugins-registry.js'

export function resolveLinearApiKey() {
  return resolvePluginSecrets(loadPersonalConfig(), builtinPlugin('command-center')).linear?.apiKey || null
}
