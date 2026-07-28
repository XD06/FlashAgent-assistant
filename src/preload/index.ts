import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '@shared/ipc'
import type {
  ActionPayload,
  AiChunkPayload,
  AiStreamRequest,
  AppSettings,
  McpServerStatus,
  SelectedTextPayload,
  SettingsPatch,
  SkillInfo
} from '@shared/types'

const api = {
  settings: {
    get: (): Promise<AppSettings> => ipcRenderer.invoke(IPC.SettingsGet),
    update: (patch: SettingsPatch): Promise<AppSettings> => ipcRenderer.invoke(IPC.SettingsUpdate, patch),
    onChanged: (callback: (settings: AppSettings) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, settings: AppSettings) => callback(settings)
      ipcRenderer.on(IPC.SettingsChanged, listener)
      return () => {
        ipcRenderer.off(IPC.SettingsChanged, listener)
      }
    }
  },
  selection: {
    start: (): Promise<boolean> => ipcRenderer.invoke(IPC.SelectionStart),
    stop: (): Promise<void> => ipcRenderer.invoke(IPC.SelectionStop),
    hideToolbar: (): Promise<void> => ipcRenderer.invoke(IPC.SelectionHideToolbar),
    writeClipboard: (text: string): Promise<boolean> => ipcRenderer.invoke(IPC.SelectionWriteClipboard, text),
    determineToolbarSize: (width: number): Promise<void> => ipcRenderer.invoke(IPC.SelectionDetermineToolbarSize, width),
    processAction: (payload: ActionPayload): Promise<void> => ipcRenderer.invoke(IPC.SelectionProcessAction, payload),
    getAccessibility: (): Promise<boolean> => ipcRenderer.invoke(IPC.SelectionGetAccessibility),
    requestAccessibility: (): Promise<boolean> => ipcRenderer.invoke(IPC.SelectionRequestAccessibility),
    onSelected: (callback: (payload: SelectedTextPayload) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: SelectedTextPayload) => callback(payload)
      ipcRenderer.on(IPC.SelectionSelected, listener)
      return () => {
        ipcRenderer.off(IPC.SelectionSelected, listener)
      }
    },
    onVisibility: (callback: (visible: boolean) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, visible: boolean) => callback(visible)
      ipcRenderer.on(IPC.SelectionVisibility, listener)
      return () => {
        ipcRenderer.off(IPC.SelectionVisibility, listener)
      }
    },
    onAction: (callback: (payload: ActionPayload) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: ActionPayload) => callback(payload)
      ipcRenderer.on(IPC.SelectionProcessAction, listener)
      return () => {
        ipcRenderer.off(IPC.SelectionProcessAction, listener)
      }
    },
    // The payload a freshly-created action window is opened with. Read
    // synchronously during the first render so content is on screen before the
    // window is shown — no push/listener race, no empty-frame flash.
    getInitialAction: (): ActionPayload | null => ipcRenderer.sendSync(IPC.SelectionGetInitialAction) ?? null
  },
  ai: {
    stream: (request: AiStreamRequest): Promise<void> => ipcRenderer.invoke(IPC.AiStream, request),
    abort: (requestId: string): Promise<void> => ipcRenderer.invoke(IPC.AiAbort, requestId),
    /** Queue a user note for delivery into a running request's tool loop.
     * Returns false when the request is no longer accepting injections. */
    inject: (requestId: string, text: string): Promise<boolean> => ipcRenderer.invoke(IPC.AiInject, requestId, text),
    listModels: (providerTemplateId?: string): Promise<string[]> => ipcRenderer.invoke(IPC.AiListModels, providerTemplateId),
    testModel: (providerTemplateId?: string): Promise<{ ok: true }> =>
      ipcRenderer.invoke(IPC.AiTestModel, providerTemplateId),
    summarize: (text: string, model?: string): Promise<string> =>
      ipcRenderer.invoke(IPC.AiSummarize, { text, model }),
    onChunk: (callback: (payload: AiChunkPayload) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: AiChunkPayload) => callback(payload)
      ipcRenderer.on(IPC.AiChunk, listener)
      return () => {
        ipcRenderer.off(IPC.AiChunk, listener)
      }
    }
  },
  agent: {
    pickWorkingDir: (): Promise<string | null> => ipcRenderer.invoke(IPC.AgentPickWorkingDir),
    approveTool: (callId: string, approved: boolean, alwaysAllow?: boolean): Promise<boolean> =>
      ipcRenderer.invoke(IPC.AgentApproveTool, callId, approved, alwaysAllow),
    revertTool: (callId: string): Promise<boolean> => ipcRenderer.invoke(IPC.AgentRevertTool, callId)
  },
  chat: {
    /** Returns the saved file path, or null when cancelled/failed. */
    exportMarkdown: (title: string, markdown: string): Promise<string | null> =>
      ipcRenderer.invoke(IPC.ChatExportMarkdown, { title, markdown })
  },
  memory: {
    open: (): Promise<string> => ipcRenderer.invoke(IPC.MemoryOpen),
    openProject: (workingDir: string): Promise<string> => ipcRenderer.invoke(IPC.MemoryOpenProject, workingDir)
  },
  ext: {
    status: (): Promise<{ skills: SkillInfo[]; mcp: McpServerStatus[] }> => ipcRenderer.invoke(IPC.ExtStatus),
    openSkillsDir: (): Promise<string> => ipcRenderer.invoke(IPC.ExtOpenSkillsDir),
    linkSkillDir: (): Promise<{ ok: boolean; name?: string; error?: string } | null> =>
      ipcRenderer.invoke(IPC.ExtLinkSkillDir),
    unlinkSkillDir: (dir: string): Promise<void> => ipcRenderer.invoke(IPC.ExtUnlinkSkillDir, dir),
    reconnectMcp: (id: string): Promise<void> => ipcRenderer.invoke(IPC.ExtMcpReconnect, id)
  },
  network: {
    testProxy: (
      proxyUrl: string
    ): Promise<{ ok: boolean; latencyMs?: number; via: 'manual' | 'system' | 'direct'; error?: string }> =>
      ipcRenderer.invoke(IPC.ProxyTest, proxyUrl)
  },
  speech: {
    speak: (text: string): Promise<boolean> => ipcRenderer.invoke(IPC.SpeechSpeak, text),
    stop: (): Promise<void> => ipcRenderer.invoke(IPC.SpeechStop)
  },
  windowControls: {
    close: (): Promise<void> => ipcRenderer.invoke(IPC.WindowClose),
    minimize: (): Promise<void> => ipcRenderer.invoke(IPC.WindowMinimize),
    pin: (pinned: boolean): Promise<void> => ipcRenderer.invoke(IPC.WindowPin, pinned)
  },
  app: {
    openExternal: (url: string): Promise<void> => ipcRenderer.invoke(IPC.OpenExternal, url)
  },
  screenshot: {
    start: (): Promise<void> => ipcRenderer.invoke(IPC.ScreenshotStart),
    overlayReady: (): Promise<void> => ipcRenderer.invoke(IPC.ScreenshotOverlayReady),
    overlayConfirm: (payload: {
      displayId: number
      x: number
      y: number
      width: number
      height: number
      viewportWidth: number
      viewportHeight: number
      action: 'explain' | 'save' | 'copy' | 'pin'
      imageDataUrl?: string
    }): Promise<void> => ipcRenderer.invoke(IPC.ScreenshotOverlayConfirm, payload),
    overlayCancel: (): Promise<void> => ipcRenderer.invoke(IPC.ScreenshotOverlayCancel),
    save: (dataUrl: string): Promise<boolean> => ipcRenderer.invoke(IPC.ScreenshotSave, dataUrl),
    copy: (dataUrl: string): Promise<boolean> => ipcRenderer.invoke(IPC.ScreenshotCopy, dataUrl),
    pin: (dataUrl: string): Promise<void> => ipcRenderer.invoke(IPC.ScreenshotPin, dataUrl),
    pinZoom: (deltaY: number): Promise<void> => ipcRenderer.invoke(IPC.ScreenshotPinZoom, deltaY),
    pinMove: (dx: number, dy: number): Promise<void> => ipcRenderer.invoke(IPC.ScreenshotPinMove, dx, dy),
    pinMenu: (): Promise<void> => ipcRenderer.invoke(IPC.ScreenshotPinMenu),
    onOverlayInit: (callback: (payload: { imageDataUrl: string; displayId: number; width: number; height: number; imageWidth: number; imageHeight: number }) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: { imageDataUrl: string; displayId: number; width: number; height: number; imageWidth: number; imageHeight: number }) => callback(payload)
      ipcRenderer.on(IPC.ScreenshotOverlayInit, listener)
      return () => {
        ipcRenderer.off(IPC.ScreenshotOverlayInit, listener)
      }
    },
    onPinInit: (callback: (payload: { imageDataUrl: string; width: number; height: number }) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: { imageDataUrl: string; width: number; height: number }) => callback(payload)
      ipcRenderer.on(IPC.ScreenshotPinInit, listener)
      return () => {
        ipcRenderer.off(IPC.ScreenshotPinInit, listener)
      }
    }
  }
}

contextBridge.exposeInMainWorld('assistantLite', api)

export type AssistantLiteApi = typeof api
