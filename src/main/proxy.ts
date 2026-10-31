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
    if (!session?.defaultSession?.resolveProxy) return null
    const resolved = await session.defaultSession.resolveProxy('https://example.com/')
    const match = /PROXY\s+([^;\s]+)/i.exec(resolved)
    return match ? `http://${match[1]}` : null
  } catch {
    return null
  }
}

/** Get the effective proxy URL for child processes and external utilities.
 * Priority: manual proxy (from settings) > system proxy > parent process environment. */
export async function getEffectiveProxyUrl(manualProxyUrl?: string): Promise<string | null> {
  const manual = manualProxyUrl?.trim()
  if (manual) return manual
  const system = await resolveSystemProxy()
  if (system) return system
  const env =
    process.env.HTTPS_PROXY ||
    process.env.HTTP_PROXY ||
    process.env.https_proxy ||
    process.env.http_proxy ||
    process.env.ALL_PROXY ||
    process.env.all_proxy
  return env?.trim() || null
}


const AGENT_OPTIONS = {
  connections: 64,
  pipelining: 1,
  keepAliveTimeout: 30_000,
  connectTimeout: 15_000,
  headersTimeout: 30_000
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
    try {
      setGlobalDispatcher(new ProxyAgent({ uri: manual, ...AGENT_OPTIONS }))
    } catch {
      // The proxy input saves per keystroke, so half-typed values ("h") reach
      // here before they are valid URIs. Chromium tolerates bad rules; keep the
      // undici side consistent (direct) instead of leaving a stale dispatcher.
      setGlobalDispatcher(new Agent(AGENT_OPTIONS))
    }
    return
  }
  await session.defaultSession.setProxy({ mode: 'system' })
  const system = await resolveSystemProxy()
  setGlobalDispatcher(system ? new ProxyAgent({ uri: system, ...AGENT_OPTIONS }) : new Agent(AGENT_OPTIONS))
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
