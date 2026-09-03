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
  SelectionGetInitialAction: 'selection:get-initial-action',
  SelectionWriteClipboard: 'selection:write-clipboard',
  SelectionGetAccessibility: 'selection:get-accessibility',
  SelectionRequestAccessibility: 'selection:request-accessibility',

  AiStream: 'ai:stream',
  AiChunk: 'ai:chunk',
  AiAbort: 'ai:abort',
  AiInject: 'ai:inject',
  AiListModels: 'ai:list-models',
  AiTestModel: 'ai:test-model',
  AiSummarize: 'ai:summarize',
  AiNameTopic: 'ai:name-topic',

  AgentPickWorkingDir: 'agent:pick-working-dir',
  AgentApproveTool: 'agent:approve-tool',
  AgentRevertTool: 'agent:revert-tool',

  ChatExportMarkdown: 'chat:export-markdown',

  TranslateRun: 'translate:run',
  TranslateAbort: 'translate:abort',
  TranslateChunk: 'translate:chunk',

  TtsSynthesize: 'tts:synthesize',

  VocabList: 'vocab:list',
  VocabAdd: 'vocab:add',
  VocabRemove: 'vocab:remove',
  VocabClear: 'vocab:clear',
  VocabExport: 'vocab:export',

  MemoryOpen: 'memory:open',
  MemoryOpenProject: 'memory:open-project',

  ExtStatus: 'ext:status',
  ExtOpenSkillsDir: 'ext:open-skills-dir',
  ExtLinkSkillDir: 'ext:link-skill-dir',
  ExtUnlinkSkillDir: 'ext:unlink-skill-dir',
  ExtMcpReconnect: 'ext:mcp-reconnect',

  ProxyTest: 'proxy:test',

  TtsPlay: 'tts:play',
  TtsStopPlayback: 'tts:stop-playback',

  WindowClose: 'window:close',
  WindowMinimize: 'window:minimize',
  WindowPin: 'window:pin',
  /** Resize the window to fit its content (quick-translate height-to-content). */
  WindowAdjustHeight: 'window:adjust-height',
  OpenExternal: 'app:open-external',

  ScreenshotStart: 'screenshot:start',
  ScreenshotOverlayReady: 'screenshot:overlay-ready',
  ScreenshotOverlayInit: 'screenshot:overlay-init',
  ScreenshotOverlayConfirm: 'screenshot:overlay-confirm',
  ScreenshotOverlayCancel: 'screenshot:overlay-cancel',
  ScreenshotSave: 'screenshot:save',
  ScreenshotCopy: 'screenshot:copy',
  ScreenshotPin: 'screenshot:pin',
  ScreenshotPinInit: 'screenshot:pin-init',
  ScreenshotPinZoom: 'screenshot:pin-zoom',
  ScreenshotPinMove: 'screenshot:pin-move',
  ScreenshotPinMenu: 'screenshot:pin-menu'
} as const

export type IpcName = (typeof IPC)[keyof typeof IPC]
