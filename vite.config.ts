import { defineConfig, type IndexHtmlTransformHook } from 'vite';
import react from '@vitejs/plugin-react';

const developmentCsp = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "connect-src 'self' ws://127.0.0.1:5173",
  "object-src 'none'",
  "base-uri 'self'",
].join('; ');

const developmentCspPlugin: IndexHtmlTransformHook = (html) => {
  const cspTag = /(<meta\s+http-equiv="Content-Security-Policy"\s+content=")[^"]*("\s*\/?\s*>)/i;
  if (!cspTag.test(html)) throw new Error('ADE renderer CSP meta tag was not found.');
  return html.replace(cspTag, (_match, open: string, close: string) => `${open}${developmentCsp}${close}`);
};

export default defineConfig(({ command }) => ({
  base: './',
  plugins: [
    react(),
    ...(command === 'serve' ? [{ name: 'ade-development-csp', transformIndexHtml: { order: 'post' as const, handler: developmentCspPlugin } }] : []),
  ],
  root: 'src/renderer',
  server: { host: '127.0.0.1', strictPort: true },
  build: { outDir: '../../dist/renderer', emptyOutDir: true },
}));
