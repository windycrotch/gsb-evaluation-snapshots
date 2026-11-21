import { extend } from '@react-three/fiber'
import * as THREE from 'three/webgpu'

import type { ThreeToJSXElements } from '@react-three/fiber'

// batchedMesh and pMREMGenerator are typed differently in three and three/webgpu, which TS 7 (bun check) rejects
// in one interface. Neither is used as a JSX element here, so they keep R3F's default types.
declare module '@react-three/fiber' {
  // eslint-disable-next-line
  interface ThreeElements extends Omit<ThreeToJSXElements<typeof THREE>, 'batchedMesh' | 'pMREMGenerator'> {}
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
extend(THREE as any)
