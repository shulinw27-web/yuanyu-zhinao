import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

// Electron uses a direct API URL rather than the same-origin Vite proxy.
// Permit exactly the configured development origin; preserve all other CSP.
export function developmentApiCsp(target = process.env.VITE_DEV_API_TARGET) {
  return {
    name: 'development-api-csp',
    apply: 'serve',
    transformIndexHtml(html) {
      if (!target) return html;
      const url = new URL(target);
      const localHttp = url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname);
      if (typeof target !== 'string' || target.trim() !== target || /[\u0000-\u001f]/u.test(target)
        || url.username || url.password || (!localHttp && url.protocol !== 'https:')) throw new Error('DEV_API_CSP_TARGET_INVALID');
      return html.replace("connect-src 'self'", `connect-src 'self' ${url.origin}`);
    }
  };
}

export default defineConfig({
  base: './',
  plugins: [vue(), developmentApiCsp()],
  clearScreen: false,
  build: {
    manifest: true,
    rollupOptions: {
      output: {
        manualChunks(id) {
          // Cache library code independently from frequently changing UI code.
          if (id.replace(/\\/g, '/').includes('/node_modules/')) return 'vendor';
        }
      }
    }
  },
  server: { port: 5174, strictPort: true, proxy: { '/api': process.env.VITE_DEV_API_TARGET || 'http://127.0.0.1:3001' } },
  preview: { port: 4174, strictPort: true }
});
