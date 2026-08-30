import { ipcMain } from 'electron'
import { IPC } from '@shared/ipc'
import { isSingleWord } from '@shared/translate'
import type { TranslateChunkPayload, TranslateRunRequest, TranslateServiceId } from '@shared/types'
import type { ProviderFetch } from '../ai/OpenAICompatibleClient'
import { getSettings } from '../settingsStore'
import { translateDeeplx } from './deeplx'
import { lookupIcibaWord, translateIciba } from './iciba'
import { translateMicrosoft } from './microsoft'
import { synthesizeSpeech } from './tts'
import { addVocabulary, hasVocabulary, isEnglishWord } from '../vocabulary'

const SERVICE_TIMEOUT_MS = 15_000
const TTS_TIMEOUT_MS = 30_000

type ServiceResult = Omit<TranslateChunkPayload, 'requestId' | 'serviceId'>

/** All built-in services run in parallel and report per-service chunks; one
 * slow or failing service never blocks or cancels the others. */
async function runService(
  serviceId: TranslateServiceId,
  request: TranslateRunRequest,
  fetchImpl: ProviderFetch,
  signal: AbortSignal
): Promise<ServiceResult> {
  const started = Date.now()
  const timedSignal = AbortSignal.any([signal, AbortSignal.timeout(SERVICE_TIMEOUT_MS)])
  const withElapsed = async (work: Promise<ServiceResult>): Promise<ServiceResult> => {
    const result = await work
    return { ...result, elapsedMs: Date.now() - started }
  }
  const { text, from, to } = request
  switch (serviceId) {
    case 'microsoft':
      return withElapsed(
        translateMicrosoft(text, from, to, fetchImpl, timedSignal).then((r) => ({
          state: 'done' as const,
          text: r.text,
          detected: r.detected
        }))
      )
    case 'iciba':
      return withElapsed(
        translateIciba(text, from, to, fetchImpl, timedSignal).then((r) => ({
          state: 'done' as const,
          text: r.text,
          detected: r.detected
        }))
      )
    case 'icibaDict': {
      // The dictionary only makes sense for single words; the renderer hides
      // the card otherwise, so skip the network entirely for phrases.
      if (!isSingleWord(text)) return { state: 'done' }
      return withElapsed(
        lookupIcibaWord(text, fetchImpl, timedSignal).then((dict) => {
          if (!dict) throw new Error('No dictionary result')
          // Auto-record English words into the vocabulary book when enabled;
          // report both the save state and whether THIS lookup inserted the
          // word (only then does the renderer show the save toast — looking
          // up an already-saved word must stay silent).
          const english = isEnglishWord(request.text)
          const justSaved = english && getSettings().vocabulary.autoRecord ? addVocabulary(dict) : false
          return {
            state: 'done' as const,
            dict,
            vocabSaved: english ? hasVocabulary(dict.word) : undefined,
            vocabJustSaved: justSaved
          }
        })
      )
    }
    case 'deeplx': {
      const endpoint = getSettings().translate.deeplxEndpoint
      return withElapsed(
        translateDeeplx(text, from, to, endpoint, fetchImpl, timedSignal).then((translated) => ({
          state: 'done' as const,
          text: translated
        }))
      )
    }
  }
}

/** Register the quick-translate and TTS IPC handlers. */
export function registerTranslateIpc(providerFetch: ProviderFetch): void {
  // One live run per window (keyed by requestId); a re-run aborts the stale set.
  const liveRequests = new Map<string, Set<AbortController>>()

  const stopRequest = (requestId: string): void => {
    const controllers = liveRequests.get(requestId)
    if (!controllers) return
    for (const controller of controllers) controller.abort()
    liveRequests.delete(requestId)
  }

  ipcMain.handle(IPC.TranslateRun, async (event, request: TranslateRunRequest) => {
    if (!request || typeof request.text !== 'string' || !request.text.trim()) return
    if (typeof request.from !== 'string' || typeof request.to !== 'string') return
    const requestId = String(request.requestId)
    stopRequest(requestId)

    const enabled = getSettings()
      .translate.services.filter((service) => service.enabled)
      .map((service) => service.id)
    if (!enabled.length) return

    const controllers = new Set<AbortController>()
    liveRequests.set(requestId, controllers)
    const sendChunk = (payload: TranslateChunkPayload): void => {
      if (event.sender.isDestroyed()) return
      event.sender.send(IPC.TranslateChunk, payload)
    }
    const settle = (serviceId: TranslateServiceId, controller: AbortController, promise: Promise<ServiceResult>): void => {
      void promise
        .then((result) => sendChunk({ ...result, requestId, serviceId }))
        .catch((error) => {
          // Superseded by a newer run — stay silent. A TimeoutError from
          // AbortSignal.timeout is a real failure the card should show.
          if (controller.signal.aborted && (error as { name?: string })?.name !== 'TimeoutError') return
          const message = error instanceof Error ? error.message : String(error)
          sendChunk({ requestId, serviceId, state: 'error', error: message })
        })
    }

    for (const serviceId of enabled) {
      const controller = new AbortController()
      controllers.add(controller)
      settle(serviceId, controller, runService(serviceId, request, providerFetch, controller.signal))
    }
  })

  ipcMain.handle(IPC.TranslateAbort, (_event, requestId: string) => {
    if (typeof requestId === 'string') stopRequest(requestId)
  })

  ipcMain.handle(IPC.TtsSynthesize, (_event, text: string) => {
    if (typeof text !== 'string' || !text.trim()) throw new Error('TTS: empty text')
    return synthesizeSpeech(text, getSettings().tts, providerFetch, AbortSignal.timeout(TTS_TIMEOUT_MS))
  })
}
