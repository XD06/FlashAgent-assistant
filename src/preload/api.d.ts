import type { AssistantLiteApi } from './index'

declare global {
  interface Window {
    assistantLite: AssistantLiteApi
  }
}

export {}
