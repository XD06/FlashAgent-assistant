declare module 'selection-hook' {
  export interface Point {
    x: number
    y: number
  }

  export interface TextSelectionData {
    text: string
    programName: string
    isFullscreen?: boolean
    posLevel: number
    mousePosStart: Point
    mousePosEnd: Point
    startTop: Point
    startBottom: Point
    endTop: Point
    endBottom: Point
  }

  export interface KeyboardEventData {
    vkCode: number
  }

  export interface MouseEventData {
    x: number
    y: number
  }

  export interface SelectionHookInstance {
    start(options?: { debug?: boolean }): boolean
    stop(): void
    cleanup(): void
    on(event: string, callback: (...args: any[]) => void): void
    off(event: string, callback: (...args: any[]) => void): void
    getCurrentSelection(): TextSelectionData | null
    setSelectionPassiveMode(passive: boolean): void
    setGlobalFilterMode(mode: number, list: string[]): boolean
    writeToClipboard(text: string): boolean
  }

  export interface SelectionHookConstructor {
    new (): SelectionHookInstance
    PositionLevel: {
      NONE: number
      MOUSE_SINGLE: number
      MOUSE_DUAL: number
      SEL_FULL: number
      SEL_DETAILED: number
    }
    FilterMode: {
      DEFAULT: number
      INCLUDE_LIST: number
      EXCLUDE_LIST: number
    }
  }

  const SelectionHook: SelectionHookConstructor
  export default SelectionHook
}
