// ESM wrapper: react-hammerjs is CJS with __esModule; re-export its real
// default explicitly (Node's interop does not honor __esModule).
import rh from 'react-hammerjs'

export default rh.default || rh
