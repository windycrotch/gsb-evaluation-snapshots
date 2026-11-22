// ESM wrapper: styled-components v2 is CJS with __esModule; Node's interop
// does not honor __esModule, so re-export its real default explicitly.
import sc from 'styled-components'

export default sc.default || sc
export const css = sc.css
export const keyframes = sc.keyframes
export const injectGlobal = sc.injectGlobal
export const ThemeProvider = sc.ThemeProvider
export const withTheme = sc.withTheme
export const ServerStyleSheet = sc.ServerStyleSheet
export const StyleSheetManager = sc.StyleSheetManager
