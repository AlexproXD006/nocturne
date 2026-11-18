// Builds the same React renderer as a static web bundle.
//  - default mode:  dist-web/    (base './')  for Capacitor (Android)
//  - --mode hosted: dist-hosted/ (base '/app/') served by the Nocturne server itself under /app (the landing lives at /),
//                   with VITE_HOSTED=true (cookie session, no server field)
import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig(({ mode }) => {
  const hosted = mode === 'hosted'
  return {
    root: resolve(__dirname, 'src/renderer'),
    base: hosted ? '/app/' : './',
    envDir: __dirname,
    resolve: {
      alias: { '@': resolve(__dirname, 'src/renderer/src') }
    },
    define: {
      __APP_VERSION__: JSON.stringify(process.env.npm_package_version ?? '1.0.0'),
      ...(hosted ? { 'import.meta.env.VITE_HOSTED': JSON.stringify('true') } : {})
    },
    plugins: [react(), tailwindcss()],
    build: {
      outDir: resolve(__dirname, hosted ? 'dist-hosted' : 'dist-web'),
      emptyOutDir: true,
      target: 'es2022'
    }
  }
})
