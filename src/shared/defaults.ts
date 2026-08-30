import type { ActionItem, AppSettings, ProviderTemplate, TranslateServiceId } from './types'

/** Default quick-translate service order: free built-ins first, DeepLX opt-in. */
export const defaultTranslateServices: Array<{ id: TranslateServiceId; enabled: boolean }> = [
  { id: 'microsoft', enabled: true },
  { id: 'iciba', enabled: true },
  { id: 'icibaDict', enabled: true },
  { id: 'deeplx', enabled: false }
]

export const defaultActions: ActionItem[] = [
  {
    id: 'translate',
    name: 'Translate',
    enabled: true,
    icon: 'languages',
    type: 'prompt',
    promptTemplate:
      'Translate the following text into {{language}}. Preserve the original meaning and tone as much as possible. Return only the translation.\n\n{{text}}'
  },
  {
    id: 'explain',
    name: 'Explain',
    enabled: true,
    icon: 'circle-help',
    type: 'prompt',
    promptTemplate:
      'Explain the following text directly in plain, easy-to-understand language. Be concise, stay focused on the meaning, and avoid unnecessary filler. Add a brief summary only when it is genuinely helpful.\n\n{{text}}'
  },
  {
    id: 'summarize',
    name: 'Summarize',
    enabled: true,
    icon: 'scan-text',
    type: 'prompt',
    promptTemplate:
      'Summarize the following text into 3-5 concise bullet points. Focus on the main ideas, key facts, and takeaways. Keep the wording simple and direct.\n\n{{text}}'
  },
  {
    id: 'search',
    name: 'Search',
    enabled: true,
    icon: 'search',
    type: 'search',
    searchUrlTemplate: 'https://www.google.com/search?q={{query}}'
  },
  {
    id: 'copy',
    name: 'Copy',
    enabled: true,
    icon: 'copy',
    type: 'copy'
  },
  {
    id: 'speak',
    name: 'Speak',
    enabled: true,
    icon: 'volume-2',
    type: 'speak'
  },
  {
    id: 'polish',
    name: 'Polish',
    enabled: true,
    icon: 'sparkles',
    type: 'prompt',
    promptTemplate:
      'Rewrite the following text to be clearer, smoother, and more natural while preserving its original meaning. Keep the tone appropriate to the source and do not add new information.\n\n{{text}}'
  }
]

export const defaultProviderTemplate: ProviderTemplate = {
  id: 'default-provider',
  name: 'Default',
  provider: {
    apiType: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: '',
    model: 'gpt-4o-mini',
    temperature: 1,
    reasoning: 'on'
  }
}

export const defaultSettings: AppSettings = {
  language: 'zh-CN',
  theme: 'system',
  enabled: false,
  triggerMode: 'selected',
  compactToolbar: false,
  showToolbarAppIcon: true,
  followToolbar: true,
  rememberWindowSize: false,
  autoClose: false,
  autoPin: false,
  actionWindowWidth: 560,
  actionWindowHeight: 420,
  fontFamily: '',
  fontSize: 14,
  autoLaunch: false,
  filterMode: 'default',
  filterList: [],
  provider: defaultProviderTemplate.provider,
  providerTemplates: [defaultProviderTemplate],
  activeProviderTemplateId: defaultProviderTemplate.id,
  webSearchEnabled: true,
  proxyUrl: '',
  compressModel: '',
  contextWindowTokens: 128_000,
  visionModel: '',
  agentFullAccess: false,
  commandShell: 'auto',
  shortcuts: {
    toggleAssistant: 'CommandOrControl+Shift+Space',
    processSelection: 'CommandOrControl+Shift+S',
    captureScreen: 'CommandOrControl+Shift+A',
    chat: 'CommandOrControl+Shift+C',
    translate: 'CommandOrControl+Shift+T'
  },
  translate: {
    services: defaultTranslateServices,
    deeplxEndpoint: 'https://ts.203065.xyz'
  },
  tts: {
    endpoint: 'https://tts.wangwangit.com/v1/audio/speech',
    voice: 'zh-CN-XiaoxiaoNeural',
    speed: 1,
    pitch: 0
  },
  vocabulary: {
    autoRecord: false
  },
  actions: defaultActions,
  mcpServers: [],
  disabledSkills: [],
  linkedSkillDirs: []
}
