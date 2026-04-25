export const APP_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <rect width="64" height="64" rx="16" fill="#101010"/>
  <path d="M21 18h-5a4 4 0 0 0-4 4v20a4 4 0 0 0 4 4h5" fill="none" stroke="#F7F7F5" stroke-width="4" stroke-linecap="round"/>
  <path d="M43 18h5a4 4 0 0 1 4 4v20a4 4 0 0 1-4 4h-5" fill="none" stroke="#F7F7F5" stroke-width="4" stroke-linecap="round"/>
  <path d="M24 25h16M24 32h16M24 39h10" fill="none" stroke="#F7F7F5" stroke-width="3.5" stroke-linecap="round"/>
</svg>`

export const APP_TRAY_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 22 22">
  <path d="M7.2 4.5H5.9A1.9 1.9 0 0 0 4 6.4v9.2a1.9 1.9 0 0 0 1.9 1.9h1.3" fill="none" stroke="#21B393" stroke-width="2.25" stroke-linecap="round"/>
  <path d="M14.8 4.5h1.3A1.9 1.9 0 0 1 18 6.4v9.2a1.9 1.9 0 0 1-1.9 1.9h-1.3" fill="none" stroke="#21B393" stroke-width="2.25" stroke-linecap="round"/>
  <path d="M8.7 8.1h4.6M8.7 11.2h4.6M8.7 14.3h2.9" fill="none" stroke="#F5F7F6" stroke-width="2" stroke-linecap="round"/>
</svg>`

export const APP_ICON_DATA_URL = `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(APP_ICON_SVG)}`
export const APP_TRAY_DATA_URL = `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(APP_TRAY_SVG)}`
