import { session } from 'electron'
import { Agent, ProxyAgent, setGlobalDispatcher, fetch as undiciFetch } from 'undici'

export interface ProxyTestResult {
  ok: boolean
  latencyMs?: number
  /** Which route the test went through: manual proxy, system proxy or direct. */
  via: 'manual' | 'system' | 'direct'
  error?: string
}

/** Resolve the OS-level proxy for HTTPS traffic via Chromium's resolver.
 * Returns e.g. "http://127.0.0.1:7890" or null when the system is direct. */
async function resolveSystemProxy(): Promise<string | null> {
  try {
    const resolved = await session.defaultSession.resolveProxy('https://example.com/')
    const match = /PROXY\s+([^;\s]+)/i.exec(resolved)
    return match ? `http://${match[1]}` : null
  } catch {
    return null
  }
}

/** Apply the proxy chain: manual proxy > system proxy > direct.
 *
 * Chromium traffic (net.fetch: AI requests, web search) follows the manual
 * proxy via setProxy, or falls back to system mode. Node traffic (undici:
 * remote MCP servers) gets a matching global dispatcher, since Node's fetch
 * never reads system proxy settings on its own. */
export async function applyProxy(proxyUrl: string | undefined): Promise<void> {
  const manual = proxyUrl?.trim()
  if (manual) {
    await session.defaultSession.setProxy({ proxyRules: manual })
    setGlobalDispatcher(new ProxyAgent(manual))
    return
  }
  await session.defaultSession.setProxy({ mode: 'system' })
  const system = await resolveSystemProxy()
  setGlobalDispatcher(system ? new ProxyAgent(system) : new Agent())
}

/** Probe connectivity through the given (or effective) proxy using the same
 * generate_204 endpoint proxy tools use. Tests the raw input, so the user can
 * verify before saving takes effect elsewhere. */
export async function testProxy(proxyUrl: string): Promise<ProxyTestResult> {
  const manual = proxyUrl.trim()
  let via: ProxyTestResult['via'] = 'manual'
  let dispatcher: Agent | ProxyAgent
  try {
    if (manual) {
      dispatcher = new ProxyAgent(manual)
    } else {
      const system = await resolveSystemProxy()
      via = system ? 'system' : 'direct'
      dispatcher = system ? new ProxyAgent(system) : new Agent()
    }
  } catch (error) {
    return { ok: false, via, error: error instanceof Error ? error.message : String(error) }
  }
  const started = Date.now()
  try {
    const res = await undiciFetch('https://www.gstatic.com/generate_204', {
      dispatcher,
      signal: AbortSignal.timeout(8000)
    })
    if (res.status >= 400) return { ok: false, via, error: `HTTP ${res.status}` }
    return { ok: true, via, latencyMs: Date.now() - started }
  } catch (error) {
    const message = error instanceof Error ? (error.cause instanceof Error ? error.cause.message : error.message) : String(error)
    return { ok: false, via, error: message }
  } finally {
    void dispatcher.close().catch(() => {})
  }
}
