export const APP_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">
  <rect x="0.65" y="0.65" width="22.7" height="22.7" rx="6.1" fill="#FFFFFF" stroke="rgba(17,19,24,0.065)" stroke-width="0.25"/>
  <defs>
    <mask id="app-brand-orbit-mask">
      <rect width="24" height="24" fill="#fff"/>
      <g transform="translate(12 11.95) scale(1.14) translate(-11.86 -11.58)">
        <path d="M 3.75 15.94 C 6.75 18.94 17.72 12.56 19.50 6.94" fill="none" stroke="#000" stroke-width="3.38" stroke-linecap="round"/>
      </g>
    </mask>
  </defs>
  <g transform="translate(12 11.95) scale(1.14) translate(-11.86 -11.58)">
    <g mask="url(#app-brand-orbit-mask)">
      <path d="M 11.81 3.84 Q 13.03 10.31 19.50 11.53 Q 13.03 12.75 11.81 19.22 Q 10.59 12.75 4.12 11.53 Q 10.59 10.31 11.81 3.84 Z" fill="#14161C"/>
    </g>
    <path d="M 3.84 15.75 C 5.53 18.47 9.75 17.53 14.44 14.16 C 18.28 11.44 20.34 8.25 19.50 6.19 C 18.66 5.16 16.59 5.81 14.62 6.94 C 16.22 6.47 17.44 6.75 17.62 7.50 C 18.09 8.91 15.84 11.44 12.84 13.50 C 8.91 16.12 5.62 16.97 3.84 15.75 Z" fill="#14161C"/>
  </g>
</svg>`

export const APP_TRAY_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">
  <rect x="0.2" y="0.2" width="23.6" height="23.6" rx="6.4" fill="#FFFFFF"/>
  <defs>
    <mask id="app-tray-orbit-mask">
      <rect width="24" height="24" fill="#fff"/>
      <g transform="translate(12 11.95) scale(1.25) translate(-11.86 -11.58)">
        <path d="M 3.75 15.94 C 6.75 18.94 17.72 12.56 19.50 6.94" fill="none" stroke="#000" stroke-width="3.0" stroke-linecap="round"/>
      </g>
    </mask>
  </defs>
  <g transform="translate(12 11.95) scale(1.25) translate(-11.86 -11.58)">
    <g mask="url(#app-tray-orbit-mask)">
      <path d="M 11.81 3.84 Q 13.03 10.31 19.50 11.53 Q 13.03 12.75 11.81 20.16 Q 10.59 12.75 4.12 11.53 Q 10.59 10.31 11.81 3.84 Z" fill="#111318"/>
    </g>
    <path d="M 3.84 15.75 C 5.53 18.47 9.75 17.53 14.44 14.16 C 18.28 11.44 20.34 8.25 19.50 6.19 C 18.66 5.16 16.59 5.81 14.62 6.94 C 16.22 6.47 17.44 6.75 17.62 7.50 C 18.09 8.91 15.84 11.44 12.84 13.50 C 8.91 16.12 5.62 16.97 3.84 15.75 Z" fill="#111318"/>
  </g>
</svg>`

export const APP_ICON_DATA_URL = `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(APP_ICON_SVG)}`
export const APP_TRAY_DATA_URL = `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(APP_TRAY_SVG)}`
