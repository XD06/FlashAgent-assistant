/**
 * Schemes that may be handed to the OS shell.
 *
 * `shell.openExternal` on Windows goes through ShellExecute, which *executes*
 * a path (a .lnk/.exe) instead of opening it. Selected text and model output
 * are attacker-controlled, so `file:` URLs and bare drive paths must never
 * reach it.
 */
const ALLOWED_EXTERNAL_URL = /^(?:https?|mailto):/i

export function isExternalUrlAllowed(url: string): boolean {
  return typeof url === 'string' && ALLOWED_EXTERNAL_URL.test(url.trim())
}
