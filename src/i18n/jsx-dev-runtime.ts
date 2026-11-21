/** Development flavour of `jsx-runtime.ts` (Vite uses it in dev builds). */
import { Fragment, jsxDEV as reactJsxDEV } from 'react/jsx-dev-runtime';
import { localizeProps } from './index';

export { Fragment };
export type { JSX } from 'react/jsx-dev-runtime';

export const jsxDEV: typeof reactJsxDEV = (type, props, ...rest) =>
  (reactJsxDEV as (...args: unknown[]) => ReturnType<typeof reactJsxDEV>)(type, localizeProps(props), ...rest);
