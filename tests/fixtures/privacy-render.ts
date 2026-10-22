// The 개인정보 처리방침 page (src/pages/Privacy.tsx) as static HTML, for tests/verify-naver.mjs, which bundles this
// file with vite on the fly (no browser, no server).
import { createElement } from 'react';
// The edge build: the browser one opens a MessageChannel that would keep the test process running.
import { renderToStaticMarkup } from 'react-dom/server.edge';
import Privacy from '../../src/pages/Privacy';

export const html = renderToStaticMarkup(createElement(Privacy));
