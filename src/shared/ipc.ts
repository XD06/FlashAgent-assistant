export const IPC = {
  SettingsGet: 'settings:get',
  SettingsUpdate: 'settings:update',
  SettingsChanged: 'settings:changed',

  SelectionStart: 'selection:start',
  SelectionStop: 'selection:stop',
  SelectionSelected: 'selection:selected',
  SelectionVisibility: 'selection:visibility',
  SelectionHideToolbar: 'selection:hide-toolbar',
  SelectionDetermineToolbarSize: 'selection:determine-toolbar-size',
  SelectionProcessAction: 'selection:process-action',
  SelectionWriteClipboard: 'selection:write-clipboard',
  SelectionGetAccessibility: 'selection:get-accessibility',
  SelectionRequestAccessibility: 'selection:request-accessibility',

  AiStream: 'ai:stream',
  AiChunk: 'ai:chunk',
  AiAbort: 'ai:abort',
  AiListModels: 'ai:list-models',
  AiTestModel: 'ai:test-model',

  WindowClose: 'window:close',
  WindowMinimize: 'window:minimize',
  WindowPin: 'window:pin',
  OpenExternal: 'app:open-external'
} as const

export type IpcName = (typeof IPC)[keyof typeof IPC]
