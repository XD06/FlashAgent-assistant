import '../styles.css'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { useSettings } from '../useSettings'
import { useThemeMode } from '../useThemeMode'
import { useAppearance } from '../useAppearance'
import { getTranslator } from '../i18n'
import { Icon } from '../icons'
import {
  TRANSLATE_LANGUAGES,
  detectLanguageHeuristic,
  isSingleWord,
  translateLanguageLabel
} from '@shared/translate'
import type { DictEntry, DictMeaning, DictSentence, TranslateChunkPayload, TranslateServiceId } from '@shared/types'

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
        {card.elapsedMs != null && card.status === 'done' && (
          <span className="tr-card__time">
            <Icon name="clock" size={12} />
            {formatElapsed(card.elapsedMs)}
          </span>
        )}
        {card.status === 'loading' && <span className="tr-card__spinner" aria-label={t('loading')} />}
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
      {!isDict && card.text && (
        <div className="tr-card__tools">
          <button
            type="button"
            className={playing ? 'tr-tool-button active' : 'tr-tool-button'}
            title={t('speak')}
            aria-label={t('speak')}
            onClick={onSpeak}>
            <Icon name={playing ? 'square' : 'volume-2'} size={13} />
          </button>
          <button type="button" className="tr-tool-button" title={t('copy')} aria-label={t('copy')} onClick={onCopy}>
            <Icon name="copy" size={13} />
          </button>
        </div>
      )}
    </div>
  )
}

function TranslateWindow() {
  const { settings, loaded } = useSettings()
  const t = getTranslator(settings.language)
  useThemeMode(settings.theme)
  useAppearance(settings)

  const prefs = React.useMemo(loadPrefs, [])
  const [input, setInput] = React.useState('')
  const [from, setFrom] = React.useState(prefs.from)
  const [to, setTo] = React.useState(prefs.to)
  const [detected, setDetected] = React.useState<string | null>(null)
  const [cards, setCards] = React.useState<Partial<Record<TranslateServiceId, CardState>>>({})
  const [playingKey, setPlayingKey] = React.useState<string | null>(null)
  const [pinned, setPinned] = React.useState(settings.autoPin)
  const [notice, setNotice] = React.useState<string | null>(null)
  const [toast, setToast] = React.useState<{ text: string; saved: boolean; key: number } | null>(null)

  const requestIdRef = React.useRef<string | null>(null)
  const playingKeyRef = React.useRef<string | null>(null)
  const audioRef = React.useRef<HTMLAudioElement | null>(null)
  const noticeTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  const inputRef = React.useRef<HTMLTextAreaElement>(null)

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

  // Abort the in-flight run when the window closes/reloads.
  React.useEffect(() => {
    const onBeforeUnload = () => {
      if (requestIdRef.current) void window.assistantLite.translate.abort(requestIdRef.current)
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload)
      onBeforeUnload()
    }
  }, [])

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
      if (!trimmed) {
        requestIdRef.current = null
        setCards({})
        setDetected(null)
        return
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
      void window.assistantLite.translate.run({ requestId, text: trimmed, from: runFrom, to: runTo })
    },
    [enabledServices]
  )

  const onInputKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault()
      runTranslate(input, from, to)
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
      showNotice(`⚠️ ${error instanceof Error ? error.message : String(error)}`)
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

  const copy = (text?: string) => {
    if (text) void navigator.clipboard.writeText(text)
  }

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

  // Esc closes the window.
  React.useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') void window.assistantLite.windowControls.close()
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
      <div className="titlebar titlebar--left">
        <Icon name="languages" />
        <strong>{t('trTitle')}</strong>
        {notice && <span className="tr-notice">{notice}</span>}
        <div className="titlebar__spacer" />
        <button className="icon" title={pinned ? t('unpin') : t('pin')} onClick={togglePin}>
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
            onChange={(event) => {
              setInput(event.target.value)
            }}
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
                onSpeak={() => void speak(card.text ?? '', `card:${serviceId}`)}
                onCopy={() => copy(card.text)}
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
