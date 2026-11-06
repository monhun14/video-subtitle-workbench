import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
export default defineConfig({
  base: './',
  plugins: [vue(), { name: 'production-csp', apply: 'build', transformIndexHtml: html => html.replace(' ws://127.0.0.1:5173', '') }],
  server: { host: '127.0.0.1', port: 5173, strictPort: true }
})
