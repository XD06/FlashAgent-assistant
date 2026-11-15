import '../styles.css'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { useSettings } from '../useSettings'
import { useThemeMode } from '../useThemeMode'
import { useAppearance } from '../useAppearance'
import { getTranslator } from '../i18n'
import { Icon } from '../icons'
import { MarkdownView } from '../Markdown'
import {
  TRANSLATE_LANGUAGES,
  detectLanguageHeuristic,
  getAutoTargetLanguage,
  isSingleWord,
  translateLanguageLabel
} from '@shared/translate'
import type { AiChunkPayload, DictEntry, DictMeaning, DictSentence, TranslateChunkPayload, TranslateServiceId } from '@shared/types'

const PREFS_KEY = 'fa-translate-prefs'

const isMac = navigator.userAgent.includes('Mac OS X')

interface CardState {
  status: 'loading' | 'done' | 'error'
  text?: string
  dict?: DictEntry
  /** Vocabulary book state for dict results (word already saved?). */
  vocabSaved?: boolean
  error?: string
  elapsedMs?: number
}

function loadPrefs(): { from: string; to: string } {
  try {
    const raw = localStorage.getItem(PREFS_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as { from?: string; to?: string }
      const from = TRANSLATE_LANGUAGES.some((lang) => lang.code === parsed.from) ? parsed.from! : 'auto'
      const to = TRANSLATE_LANGUAGES.some((lang) => lang.code === parsed.to) ? parsed.to! : 'zh'
      return { from, to }
    }
  } catch {
    // Corrupt prefs fall through to defaults.
  }
  return { from: 'auto', to: 'zh' }
}

/** Provider-detected codes like zh-Hans / pt-PT are normalized to the app's
 * canonical language table codes for display and swap. */
function normalizeDetected(code: string): string {
  const lower = code.toLowerCase()
  if (lower === 'zh-hans' || lower === 'zh-cn') return 'zh'
  if (lower === 'zh-hant' || lower === 'zh-tw') return 'zh-tw'
  return lower.split('-')[0]
}

/** Fixed label keys for the dictionary "word forms" line, in display order. */
const EXCHANGE_LABEL_KEYS: Array<[keyof DictEntry['exchange'], string]> = [
  ['plurals', 'dictPlurals'],
  ['pastTense', 'dictPastTense'],
  ['pastParticiple', 'dictPastParticiple'],
  ['presentParticiple', 'dictPresentParticiple'],
  ['thirdPersonSingular', 'dictThirdPerson'],
  ['comparative', 'dictComparative'],
  ['superlative', 'dictSuperlative']
]

/** Services that render the dictionary card (single-word lookups). */
const DICT_SERVICES: ReadonlySet<TranslateServiceId> = new Set<TranslateServiceId>(['icibaDict', 'youdaoDict'])

function serviceDisplayName(serviceId: TranslateServiceId, t: (key: string) => string): string {
  switch (serviceId) {
    case 'microsoft':
      return t('serviceMicrosoft')
    case 'iciba':
      return t('serviceIciba')
    case 'icibaDict':
      return t('serviceIcibaDict')
    case 'youdaoDict':
      return t('serviceYoudaoDict')
    case 'tencent':
      return t('serviceTencent')
    case 'yandex':
      return t('serviceYandex')
    case 'deeplx':
      return t('serviceDeeplx')
  }
}

function formatElapsed(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${ms}ms`
}

function DictCard({
  dict,
  saved,
  onToggleSave,
  onSpeakUrl,
  onSpeakSentence,
  onSpeakMeaning,
  t
}: {
  dict: DictEntry
  saved: boolean
  onToggleSave: () => void
  onSpeakUrl: (url: string) => void
  /** Speak a sentence: original voice when present, TTS fallback otherwise. */
  onSpeakSentence: (sentence: DictSentence) => void
  /** Speak a sense row: original voice when present, TTS fallback otherwise. */
  onSpeakMeaning: (meaning: DictMeaning) => void
  t: (key: string) => string
}) {
  return (
    <div className="tr-dict">
      <div className="tr-dict__word-row">
        <div className="tr-dict__word">{dict.word}</div>
        <button
          type="button"
          className={saved ? 'tr-tool-button vocab-saved' : 'tr-tool-button'}
          title={saved ? t('vocabAdded') : t('vocabAdd')}
          aria-label={saved ? t('vocabAdded') : t('vocabAdd')}
          onClick={onToggleSave}>
          <Icon name={saved ? 'check' : 'plus'} size={14} />
        </button>
      </div>
      {dict.phonetics.length > 0 && (
        <div className="tr-dict__phonetics">
          {dict.phonetics.map((phonetic) => (
            <span className="tr-dict__phonetic" key={phonetic.label}>
              <span className={`tr-dict__phonetic-tag tr-dict__phonetic-tag--${phonetic.label}`}>{phonetic.label}</span>
              <span className="tr-dict__phonetic-text">/{phonetic.phonetic}/</span>
              {phonetic.audioUrl && (
                <button
                  type="button"
                  className="tr-tool-button"
                  aria-label={t('speak')}
                  title={t('speak')}
                  onClick={() => onSpeakUrl(phonetic.audioUrl)}>
                  <Icon name="volume-2" size={13} />
                </button>
              )}
            </span>
          ))}
        </div>
      )}
      {/* Compact by design: the full list is a wall of text on common words
          (Youdao "flash" has 9 senses under v. alone) — show the frequent
          first three senses of each pos, max three pos rows; hover reveals
          the complete list, and the saved vocabulary entry keeps everything. */}
      <div className="tr-dict__meanings">
        {dict.meanings.slice(0, 3).map((meaning, index) => (
          <div className="tr-dict__meaning" key={index}>
            {meaning.audioUrl && (
              <button
                type="button"
                className="tr-tool-button tr-dict__sentence-play"
                aria-label={t('speak')}
                title={t('speak')}
                onClick={() => onSpeakMeaning(meaning)}>
                <Icon name="volume-2" size={12} />
              </button>
            )}
            {meaning.partOfSpeech && <span className="tr-dict__pos">{meaning.partOfSpeech}</span>}
            <span className="tr-dict__means" title={meaning.means.join('；')}>
              {meaning.means.slice(0, 3).join('；')}
            </span>
          </div>
        ))}
      </div>
      {EXCHANGE_LABEL_KEYS.some(([key]) => dict.exchange[key]?.length) && (
        <div className="tr-dict__exchange">
          {EXCHANGE_LABEL_KEYS.filter(([key]) => dict.exchange[key]?.length).map(([key, labelKey]) => (
            <span className="tr-dict__exchange-item" key={key}>
              {t(labelKey)}：{dict.exchange[key]!.join('、')}
            </span>
          ))}
        </div>
      )}
      {/* exchange/phrases render as an inline flow: chips wrap as whole units
          (white-space: nowrap on the item) so a form like "复数：flashes"
          never splits across lines. */}
      {dict.phrases && dict.phrases.length > 0 && (
        <div className="tr-dict__phrases">
          <div className="tr-dict__section-label">{t('dictPhrasesLabel')}</div>
          <div className="tr-dict__phrase-flow">
            {dict.phrases.map((phrase) => (
              <span className="tr-dict__phrase" key={phrase.en} title={`${phrase.en} ${phrase.zh}`}>
                <span className="tr-dict__phrase-en">{phrase.en}</span>
                <span className="tr-dict__phrase-zh">{phrase.zh}</span>
              </span>
            ))}
          </div>
        </div>
      )}
      {dict.sentences && dict.sentences.length > 0 && (
        <div className="tr-dict__sentences">
          <div className="tr-dict__section-label">{t('dictSentenceLabel')}</div>
          {dict.sentences.map((sentence, index) => (
            <div className="tr-dict__sentence" key={index}>
              <button
                type="button"
                className="tr-tool-button tr-dict__sentence-play"
                aria-label={t('speak')}
                title={t('speak')}
                onClick={() => onSpeakSentence(sentence)}>
                <Icon name="volume-2" size={12} />
              </button>
              <div className="tr-dict__sentence-body">
                <div className="tr-dict__sentence-en">{sentence.en}</div>
                <div className="tr-dict__sentence-zh">
                  {sentence.zh}
                  {sentence.source && <span className="tr-dict__sentence-source">{sentence.source}</span>}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function ServiceCard({
  serviceId,
  card,
  playing,
  copied,
  onSpeak,
  onCopy,
  onToggleSave,
  onSpeakUrl,
  onSpeakSentence,
  onSpeakMeaning,
  t
}: {
  serviceId: TranslateServiceId
  card: CardState
  playing: boolean
  copied: boolean
  onSpeak: () => void
  onCopy: () => void
  onToggleSave: () => void
  onSpeakUrl: (url: string) => void
  onSpeakSentence: (sentence: DictSentence) => void
  onSpeakMeaning: (meaning: DictMeaning) => void
  t: (key: string) => string
}) {
  const isDict = DICT_SERVICES.has(serviceId) && !!card.dict
  return (
    <div className="tr-card">
      <div className="tr-card__head">
        <span className="tr-card__name">{serviceDisplayName(serviceId, t)}</span>
        <div className="tr-card__meta">
          {card.elapsedMs != null && card.status === 'done' && (
            <span className={`tr-card__latency${card.elapsedMs >= 1200 ? ' tr-card__latency--slow' : ''}`}>
              {formatElapsed(card.elapsedMs)}
            </span>
          )}
          {card.status === 'error' && <span className="tr-card__status tr-card__status--err">{t('trFailed')}</span>}
          {card.status === 'loading' && <span className="tr-card__dot-pulse" aria-label={t('loading')} />}
          {!isDict && card.text && (
            <div className="tr-card__head-tools">
              <button
                type="button"
                className={playing ? 'tr-tool-button active' : 'tr-tool-button'}
                title={t('speak')}
                aria-label={t('speak')}
                onClick={onSpeak}>
                <Icon name={playing ? 'square' : 'volume-2'} size={13} />
              </button>
              <button
                type="button"
                className={copied ? 'tr-tool-button vocab-saved' : 'tr-tool-button'}
                title={copied ? t('copied') : t('copy')}
                aria-label={copied ? t('copied') : t('copy')}
                onClick={onCopy}>
                <Icon name={copied ? 'check' : 'copy'} size={13} />
              </button>
            </div>
          )}
        </div>
      </div>
      <div className="tr-card__body">
        {isDict ? (
          <DictCard
            dict={card.dict!}
            saved={!!card.vocabSaved}
            onToggleSave={onToggleSave}
            onSpeakUrl={onSpeakUrl}
            onSpeakSentence={onSpeakSentence}
            onSpeakMeaning={onSpeakMeaning}
            t={t}
          />
        ) : card.status === 'error' ? (
          <div className="tr-card__error">{card.error}</div>
        ) : card.status === 'loading' ? (
          <div className="thinking-indicator">{t('loading')}</div>
        ) : (
          <div className="tr-card__text">{card.text}</div>
        )}
      </div>
    </div>
  )
}

function TranslateWindow() {
  const { settings, loaded } = useSettings()
  const t = getTranslator(settings.language)
  useThemeMode(settings)
  useAppearance(settings)

  const prefs = React.useMemo(loadPrefs, [])
  const [input, setInput] = React.useState('')
  const [from, setFrom] = React.useState(prefs.from)
  const [to, setTo] = React.useState(prefs.to)
  const [detected, setDetected] = React.useState<string | null>(null)
  const [cards, setCards] = React.useState<Partial<Record<TranslateServiceId, CardState>>>({})
  const [playingKey, setPlayingKey] = React.useState<string | null>(null)
  const [pinned, setPinned] = React.useState(settings.autoPin)
  const [copiedKey, setCopiedKey] = React.useState<string | null>(null)
  const [notice, setNotice] = React.useState<string | null>(null)
  const [toast, setToast] = React.useState<{ text: string; saved: boolean; key: number } | null>(null)
  const [nuanceInput, setNuanceInput] = React.useState('')
  const [nuanceNote, setNuanceNote] = React.useState<{
    text: string
    pending: boolean
    error?: string
  } | null>(null)

  const requestIdRef = React.useRef<string | null>(null)
  const nuanceRequestIdRef = React.useRef<string | null>(null)
  const nuanceDeltaRef = React.useRef('')
  const nuanceFlushTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  const copiedTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  const playingKeyRef = React.useRef<string | null>(null)
  const audioRef = React.useRef<HTMLAudioElement | null>(null)
  const noticeTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  const inputRef = React.useRef<HTMLTextAreaElement>(null)
  const isComposingRef = React.useRef(false)
  const prevAutoPinRef = React.useRef<boolean | null>(null)

  React.useEffect(() => {
    if (!loaded) return
    if (prevAutoPinRef.current === null || prevAutoPinRef.current !== settings.autoPin) {
      prevAutoPinRef.current = settings.autoPin
      setPinned(settings.autoPin)
      void window.assistantLite.windowControls.pin(settings.autoPin)
    }
  }, [loaded, settings.autoPin])

  React.useEffect(() => {
    playingKeyRef.current = playingKey
  }, [playingKey])

  React.useEffect(() => {
    document.documentElement.classList.add('translate-page-root')
    document.body.classList.add('translate-page')
    document.documentElement.lang = settings.language
    return () => {
      document.documentElement.classList.remove('translate-page-root')
      document.body.classList.remove('translate-page')
    }
  }, [settings.language])

  // Height-to-content: report the natural document height to main whenever the
  // content changes (stub list, results, dict card…). The window has no fixed
  // height; main clamps to the work area.
  const lastReportedHeightRef = React.useRef(0)
  React.useEffect(() => {
    const report = (): void => {
      const height = Math.round(document.documentElement.scrollHeight)
      if (height > 0 && Math.abs(height - lastReportedHeightRef.current) > 1) {
        lastReportedHeightRef.current = height
        void window.assistantLite.windowControls.adjustHeight(height)
      }
    }
    report()
    const observer = new ResizeObserver(report)
    observer.observe(document.getElementById('root')!)
    return () => observer.disconnect()
  }, [])

  // Persist language picks across sessions (this window only).
  React.useEffect(() => {
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify({ from, to }))
    } catch {
      // Storage full/unavailable — language memory is best-effort.
    }
  }, [from, to])

  const stopAudio = React.useCallback(() => {
    audioRef.current?.pause()
    audioRef.current = null
    setPlayingKey(null)
  }, [])

  const showNotice = React.useCallback((text: string) => {
    setNotice(text)
    if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current)
    noticeTimerRef.current = setTimeout(() => setNotice(null), 3000)
  }, [])

  const toastTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  const showToast = React.useCallback((text: string, saved: boolean) => {
    setToast({ text, saved, key: Date.now() })
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current)
    toastTimerRef.current = setTimeout(() => setToast(null), 2000)
  }, [])

  // Abort any in-flight translate or nuance AI runs when the window closes/reloads.
  React.useEffect(() => {
    const abortAll = () => {
      if (requestIdRef.current) {
        void window.assistantLite.translate.abort(requestIdRef.current)
        requestIdRef.current = null
      }
      if (nuanceRequestIdRef.current) {
        void window.assistantLite.ai.abort(nuanceRequestIdRef.current)
        nuanceRequestIdRef.current = null
      }
      if (nuanceFlushTimerRef.current) {
        clearTimeout(nuanceFlushTimerRef.current)
        nuanceFlushTimerRef.current = null
      }
      if (copiedTimerRef.current) {
        clearTimeout(copiedTimerRef.current)
        copiedTimerRef.current = null
      }
    }
    window.addEventListener('beforeunload', abortAll)
    return () => {
      window.removeEventListener('beforeunload', abortAll)
      abortAll()
    }
  }, [])

  // Streaming listener for the optional AI nuance/rewrite card (separate requestId).
  React.useEffect(() => {
    const flushNuance = () => {
      if (nuanceFlushTimerRef.current) {
        clearTimeout(nuanceFlushTimerRef.current)
        nuanceFlushTimerRef.current = null
      }
      const delta = nuanceDeltaRef.current
      nuanceDeltaRef.current = ''
      if (!delta) return
      setNuanceNote((prev) => (prev ? { ...prev, text: prev.text + delta, pending: true } : prev))
    }
    const unsub = window.assistantLite.ai.onChunk((chunk: AiChunkPayload) => {
      if (chunk.requestId !== nuanceRequestIdRef.current) return
      if (chunk.type === 'delta') {
        nuanceDeltaRef.current += chunk.text ?? ''
        if (!nuanceFlushTimerRef.current) nuanceFlushTimerRef.current = setTimeout(flushNuance, 50)
        return
      }
      if (chunk.type === 'done' || chunk.type === 'error') {
        flushNuance()
        nuanceRequestIdRef.current = null
        setNuanceNote((prev) =>
          prev
            ? {
                ...prev,
                pending: false,
                error: chunk.type === 'error' ? (chunk.error ?? t('unknownProviderError')) : undefined
              }
            : prev
        )
      }
    })
    return () => {
      unsub()
      if (nuanceFlushTimerRef.current) {
        clearTimeout(nuanceFlushTimerRef.current)
        nuanceFlushTimerRef.current = null
      }
    }
  }, [t])

  // Chunk subscription lives for the whole window; runs are matched by requestId.
  // Re-subscribes on language change so auto-save toasts use current wording.
  React.useEffect(() => {
    return window.assistantLite.translate.onChunk((chunk: TranslateChunkPayload) => {
      if (chunk.requestId !== requestIdRef.current) return
      if (chunk.detected) setDetected(normalizeDetected(chunk.detected))
      setCards((current) => {
        const card = current[chunk.serviceId]
        if (!card) return current
        const next: CardState =
          chunk.state === 'error'
            ? { status: 'error', error: chunk.error ?? 'error' }
            : { status: 'done', text: chunk.text, dict: chunk.dict, vocabSaved: chunk.vocabSaved }
        if (chunk.elapsedMs != null) next.elapsedMs = chunk.elapsedMs
        return { ...current, [chunk.serviceId]: next }
      })
      // Auto-record inserted the word on this lookup — same toast as the
      // manual path so both save routes feel identical.
      if (chunk.vocabJustSaved && chunk.dict) {
        showToast(t('vocabToastAdded').replace('{{word}}', chunk.dict.word), true)
      }
    })
  }, [t, showToast])

  const enabledServices = React.useMemo(
    () => settings.translate.services.filter((service) => service.enabled).map((service) => service.id),
    [settings.translate.services]
  )

  const runTranslate = React.useCallback(
    (text: string, runFrom: string, runTo: string) => {
      const trimmed = text.trim()
      if (requestIdRef.current) void window.assistantLite.translate.abort(requestIdRef.current)
      if (nuanceRequestIdRef.current) {
        void window.assistantLite.ai.abort(nuanceRequestIdRef.current)
        nuanceRequestIdRef.current = null
      }
      nuanceDeltaRef.current = ''
      setNuanceNote(null)
      if (!trimmed) {
        requestIdRef.current = null
        setCards({})
        setDetected(null)
        return
      }
      const resolvedTo = getAutoTargetLanguage(trimmed, runFrom, runTo)
      if (resolvedTo !== runTo) {
        setTo(resolvedTo)
      }
      const requestId = crypto.randomUUID()
      requestIdRef.current = requestId
      const loading: Partial<Record<TranslateServiceId, CardState>> = {}
      for (const serviceId of enabledServices) {
        // Dictionary cards only participate for single-word input.
        if (DICT_SERVICES.has(serviceId) && !isSingleWord(trimmed)) continue
        loading[serviceId] = { status: 'loading' }
      }
      setCards(loading)
      setDetected(null)
      void window.assistantLite.translate.run({ requestId, text: trimmed, from: runFrom, to: resolvedTo })
    },
    [enabledServices]
  )

  const handleInputChange = (value: string) => {
    setInput(value)
    if (!isComposingRef.current) {
      const nextTo = getAutoTargetLanguage(value, from, to)
      if (nextTo !== to) {
        setTo(nextTo)
      }
    }
  }

  const handleCompositionEnd = (event: React.CompositionEvent<HTMLTextAreaElement>) => {
    isComposingRef.current = false
    const value = event.currentTarget.value
    const nextTo = getAutoTargetLanguage(value, from, to)
    if (nextTo !== to) {
      setTo(nextTo)
    }
  }

  const onInputKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault()
      const nextTo = getAutoTargetLanguage(input, from, to)
      if (nextTo !== to) {
        setTo(nextTo)
      }
      runTranslate(input, from, nextTo)
    }
  }

  const swapLanguages = () => {
    const nextFrom = to
    const nextTo = from === 'auto' ? (detected ?? detectLanguageHeuristic(input)) : from
    const resolvedTo = nextTo === nextFrom ? 'en' : nextTo
    setFrom(nextFrom)
    setTo(resolvedTo)
    if (input.trim()) runTranslate(input, nextFrom, resolvedTo)
  }

  const speak = async (text: string, key: string) => {
    if (!text.trim()) return
    if (playingKeyRef.current === key) {
      stopAudio()
      return
    }
    stopAudio()
    setPlayingKey(key)
    try {
      const dataUrl = await window.assistantLite.tts.synthesize(text)
      if (playingKeyRef.current !== key) return // stopped/replaced while synthesizing
      const audio = new Audio(dataUrl)
      audioRef.current = audio
      audio.onended = () => {
        if (audioRef.current === audio) setPlayingKey(null)
      }
      await audio.play()
    } catch (error) {
      if (playingKeyRef.current === key) setPlayingKey(null)
      const raw = error instanceof Error ? error.message : String(error)
      const message = raw.replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/, '')
      showNotice(`⚠️ ${message}`)
    }
  }

  const speakUrl = React.useCallback(
    (url: string) => {
      stopAudio()
      // Youdao dictvoice rejects direct hotlinking — main fetches it into a
      // data URL; other services' URLs play directly.
      const play = (src: string) => {
        const audio = new Audio(src)
        audioRef.current = audio
        audio.onended = () => {
          if (audioRef.current === audio) setPlayingKey(null)
        }
        void audio.play().catch(() => {})
      }
      if (/^https:\/\/dict\.youdao\.com\/dictvoice\?/.test(url)) {
        void window.assistantLite.translate
          .youdaoAudio(url)
          .then(play)
          .catch(() => {})
      } else {
        play(url)
      }
    },
    [stopAudio]
  )

  const copy = (text?: string, key?: string) => {
    if (!text) return
    void navigator.clipboard.writeText(text)
    if (!key) return
    setCopiedKey(key)
    if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current)
    copiedTimerRef.current = setTimeout(() => setCopiedKey(null), 1400)
  }

  const stopNuance = React.useCallback(() => {
    if (nuanceRequestIdRef.current) {
      void window.assistantLite.ai.abort(nuanceRequestIdRef.current)
      nuanceRequestIdRef.current = null
    }
    nuanceDeltaRef.current = ''
    setNuanceNote((prev) => (prev ? { ...prev, pending: false } : prev))
  }, [])

  const runNuance = React.useCallback(
    (kind: 'polish' | 'ask') => {
      const source = input.trim()
      if (!source) return
      const customQuestion = nuanceInput.trim()
      if (kind === 'ask' && !customQuestion) return
      if (nuanceRequestIdRef.current) void window.assistantLite.ai.abort(nuanceRequestIdRef.current)
      nuanceDeltaRef.current = ''

      const firstTranslation = enabledServices
        .map((id) => cards[id]?.text?.trim())
        .find((text): text is string => !!text)
      const targetLang = translateLanguageLabel(getAutoTargetLanguage(source, from, to))
      const isZh = settings.language === 'zh-CN'

      const prompt =
        kind === 'polish'
          ? isZh
            ? `请基于以下原文与译文，给出 2 个更自然地道的「${targetLang}」表达（口语自然版 / 书面精炼版），并一句话说明语气或用词差异，简洁不要废话。\n\n原文：${source}${firstTranslation ? `\n参考译文：${firstTranslation}` : ''}`
            : `Based on this text, provide 2 more natural/idiomatic expressions in ${targetLang} (casual vs. refined) and briefly note the nuance in one line.\n\nSource: ${source}${firstTranslation ? `\nDraft translation: ${firstTranslation}` : ''}`
          : isZh
            ? `原文：${source}${firstTranslation ? `\n参考译文（${targetLang}）：${firstTranslation}` : ''}\n\n问题：${customQuestion}\n请直接、简洁回答。`
            : `Source: ${source}${firstTranslation ? `\nTranslation (${targetLang}): ${firstTranslation}` : ''}\n\nQuestion: ${customQuestion}\nAnswer concisely.`

      if (kind === 'ask') setNuanceInput('')
      const requestId = crypto.randomUUID()
      nuanceRequestIdRef.current = requestId
      setNuanceNote({ text: '', pending: true })
      void window.assistantLite.ai.stream({
        requestId,
        messages: [{ role: 'user', text: prompt }],
        reasoning: 'off'
      })
    },
    [input, nuanceInput, enabledServices, cards, from, to, settings.language]
  )

  // Save/remove the dict word in the vocabulary book; optimistic UI, the
  // main-process call is fire-and-forget. A short toast confirms the action
  // without stealing focus from the results.
  const toggleVocab = (serviceId: TranslateServiceId) => {
    const card = cards[serviceId]
    const dict = card?.dict
    if (!dict) return
    const nextSaved = !card.vocabSaved
    setCards((current) => {
      const target = current[serviceId]
      if (!target) return current
      return { ...current, [serviceId]: { ...target, vocabSaved: nextSaved } }
    })
    showToast(t(nextSaved ? 'vocabToastAdded' : 'vocabToastRemoved').replace('{{word}}', dict.word), nextSaved)
    void (nextSaved ? window.assistantLite.vocabulary.add(dict) : window.assistantLite.vocabulary.remove(dict.word))
  }

  // Esc closes the window (unless consumed by a field draft clear).
  React.useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented) {
        void window.assistantLite.windowControls.close()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const togglePin = () => {
    const next = !pinned
    setPinned(next)
    void window.assistantLite.windowControls.pin(next)
  }

  if (!loaded) {
    return (
      <div className="action-window action-window--flex">
        <div className="tr-loading">{t('loading')}</div>
      </div>
    )
  }

  const shownDetected = detected ?? (input.trim() && from === 'auto' ? detectLanguageHeuristic(input) : null)
  const languageOptions = (includeAuto: boolean) =>
    TRANSLATE_LANGUAGES.filter((lang) => includeAuto || !lang.auto).map((lang) => (
      <option key={lang.code} value={lang.code}>
        {lang.auto ? t('trAuto') : lang.label}
      </option>
    ))

  return (
    <div className="action-window action-window--flex translate-window">
      <div className="titlebar titlebar--left fa-tr-titlebar">
        <Icon name="languages" />
        <strong>{t('trTitle')}</strong>
        {notice && <span className="tr-notice">{notice}</span>}
        <div className="titlebar__spacer" />
        <button
          className="icon"
          title={t('openNewWindow')}
          onClick={() => void window.assistantLite.windowControls.openNew({ mode: 'translate' })}>
          <Icon name="plus" size={14} />
        </button>
        <button className={pinned ? 'icon icon--active' : 'icon'} title={pinned ? t('unpin') : t('pin')} onClick={togglePin}>
          <Icon name={pinned ? 'pin-off' : 'pin'} />
        </button>
        {!isMac && (
          <>
            <button className="icon" title={t('minimize')} onClick={() => window.assistantLite.windowControls.minimize()}>
              <Icon name="minus" size={15} />
            </button>
            <button className="icon icon--close" title={t('close')} onClick={() => window.assistantLite.windowControls.close()}>
              <Icon name="x" size={15} />
            </button>
          </>
        )}
      </div>

      <div className="content tr-body">
        <div className="tr-input-card">
          <textarea
            ref={inputRef}
            className="tr-input"
            autoFocus
            value={input}
            placeholder={t('trInputPlaceholder')}
            onChange={(event) => handleInputChange(event.target.value)}
            onCompositionStart={() => {
              isComposingRef.current = true
            }}
            onCompositionEnd={handleCompositionEnd}
            onKeyDown={onInputKeyDown}
          />
          <div className="tr-input-tools">
            <button
              type="button"
              className={playingKey === 'input' ? 'tr-tool-button active' : 'tr-tool-button'}
              title={t('speak')}
              aria-label={t('speak')}
              disabled={!input.trim()}
              onClick={() => void speak(input, 'input')}>
              <Icon name={playingKey === 'input' ? 'square' : 'volume-2'} size={14} />
            </button>
            <button
              type="button"
              className="tr-tool-button"
              title={t('copy')}
              aria-label={t('copy')}
              disabled={!input.trim()}
              onClick={() => copy(input)}>
              <Icon name="copy" size={14} />
            </button>
            <button
              type="button"
              className="tr-tool-button"
              title={t('trClear')}
              aria-label={t('trClear')}
              disabled={!input}
              onClick={() => {
                setInput('')
                runTranslate('', from, to)
                inputRef.current?.focus()
              }}>
              <Icon name="x" size={14} />
            </button>
            {from === 'auto' && shownDetected && (
              <span className="tr-detected">
                {t('trDetectedAs')} {translateLanguageLabel(shownDetected)}
              </span>
            )}
          </div>
        </div>

        <div className="tr-langs">
          <label className="tr-lang">
            <select value={from} onChange={(event) => setFrom(event.target.value)} aria-label={t('trSourceLang')}>
              {languageOptions(true)}
            </select>
          </label>
          <button type="button" className="tr-swap" title={t('trSwap')} aria-label={t('trSwap')} onClick={swapLanguages}>
            <Icon name="arrow-right-left" size={15} />
          </button>
          <label className="tr-lang">
            <select value={to} onChange={(event) => setTo(event.target.value)} aria-label={t('trTargetLang')}>
              {languageOptions(false)}
            </select>
          </label>
        </div>

        <div className="tr-results">
          {nuanceNote && (
            <div className="tr-card tr-card--nuance">
              <div className="tr-card__head">
                <span className="tr-card__name tr-card__name--nuance">{t('trAiNoteTitle')}</span>
                <div className="tr-card__meta">
                  {nuanceNote.pending && <span className="tr-card__dot-pulse" aria-label={t('loading')} />}
                  {nuanceNote.text && (
                    <button
                      type="button"
                      className={copiedKey === 'nuance' ? 'tr-tool-button vocab-saved' : 'tr-tool-button'}
                      title={copiedKey === 'nuance' ? t('copied') : t('copy')}
                      aria-label={copiedKey === 'nuance' ? t('copied') : t('copy')}
                      onClick={() => copy(nuanceNote.text, 'nuance')}>
                      <Icon name={copiedKey === 'nuance' ? 'check' : 'copy'} size={13} />
                    </button>
                  )}
                  <button
                    type="button"
                    className="tr-tool-button"
                    title={t('close')}
                    aria-label={t('close')}
                    onClick={() => {
                      stopNuance()
                      setNuanceNote(null)
                    }}>
                    <Icon name="x" size={13} />
                  </button>
                </div>
              </div>
              <div className="tr-card__body">
                {nuanceNote.error ? (
                  <div className="tr-card__error">{nuanceNote.error}</div>
                ) : nuanceNote.text ? (
                  <div className="tr-card__nuance-md markdown-body">
                    <MarkdownView pending={nuanceNote.pending}>{nuanceNote.text}</MarkdownView>
                  </div>
                ) : (
                  <div className="thinking-indicator">{t('preparing')}</div>
                )}
              </div>
            </div>
          )}
          {enabledServices.map((serviceId) => {
            const card = cards[serviceId]
            // The dictionary card only materializes for single-word input;
            // its bar stays visible while idle so the service list matches
            // the settings (STranslate-style stubs).
            if (DICT_SERVICES.has(serviceId) && card && !isSingleWord(input)) return null
            if (DICT_SERVICES.has(serviceId) && !card && input.trim() && !isSingleWord(input)) return null
            if (!card) {
              return (
                <div className="tr-card tr-card--stub" key={serviceId}>
                  <span className="tr-card__name">{serviceDisplayName(serviceId, t)}</span>
                  <Icon name="chevron-down" size={14} />
                </div>
              )
            }
            return (
              <ServiceCard
                key={serviceId}
                serviceId={serviceId}
                card={card}
                playing={playingKey === `card:${serviceId}`}
                copied={copiedKey === serviceId}
                onSpeak={() => void speak(card.text ?? '', `card:${serviceId}`)}
                onCopy={() => copy(card.text, serviceId)}
                onToggleSave={() => toggleVocab(serviceId)}
                onSpeakUrl={speakUrl}
                onSpeakSentence={(sentence) => {
                  if (sentence.audioUrl) speakUrl(sentence.audioUrl)
                  else void speak(sentence.en, `dict-sentence:${serviceId}:${sentence.en}`)
                }}
                onSpeakMeaning={(meaning) => {
                  if (meaning.audioUrl) speakUrl(meaning.audioUrl)
                  else void speak(meaning.means[0] ?? '', `dict-meaning:${serviceId}:${meaning.means[0] ?? ''}`)
                }}
                t={t}
              />
            )
          })}
        </div>
      </div>

      <div className="tr-nuance-bar">
        <input
          type="text"
          className="tr-nuance-bar__input"
          value={nuanceInput}
          placeholder={t('trNuancePlaceholder')}
          onChange={(e) => setNuanceInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
              e.preventDefault()
              if (nuanceNote?.pending) stopNuance()
              else runNuance('ask')
            } else if (e.key === 'Escape' && nuanceInput) {
              e.preventDefault()
              e.stopPropagation()
              setNuanceInput('')
            }
          }}
        />
        <button
          type="button"
          className="tr-nuance-bar__polish"
          disabled={!input.trim() || !!nuanceNote?.pending}
          onClick={() => runNuance('polish')}
          title={t('trIdiomaticBtn')}>
          {t('trIdiomaticBtn')}
        </button>
        <button
          type="button"
          className={`tr-nuance-bar__send${nuanceNote?.pending ? ' tr-nuance-bar__send--stop' : ''}`}
          disabled={!nuanceNote?.pending && (!input.trim() || !nuanceInput.trim())}
          onClick={() => (nuanceNote?.pending ? stopNuance() : runNuance('ask'))}
          title={nuanceNote?.pending ? t('stop') : t('trAiNoteTitle')}>
          <Icon name={nuanceNote?.pending ? 'square' : 'arrow-up'} size={13} />
        </button>
      </div>

      {toast && (
        <div className={toast.saved ? 'tr-toast' : 'tr-toast tr-toast--muted'} key={toast.key} role="status">
          <Icon name={toast.saved ? 'check' : 'trash-2'} size={12} />
          <span>{toast.text}</span>
        </div>
      )}
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<TranslateWindow />)
