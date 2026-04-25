export const isMac = process.platform === 'darwin'
export const isWin = process.platform === 'win32'
export const isSupportedPlatform = isMac || isWin
