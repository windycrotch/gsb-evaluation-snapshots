/** React's automatic JSX runtime with one addition: string children and text props are translated (see `index.ts`). */
import { Fragment, jsx as reactJsx, jsxs as reactJsxs } from 'react/jsx-runtime';
import { localizeProps } from './index';

export { Fragment };
export type { JSX } from 'react/jsx-runtime';

export const jsx: typeof reactJsx = (type, props, key) => reactJsx(type, localizeProps(props), key);
export const jsxs: typeof reactJsxs = (type, props, key) => reactJsxs(type, localizeProps(props), key);
