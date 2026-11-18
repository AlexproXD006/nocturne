import { resolve } from 'node:path'
import { configDefaults, defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@': resolve(__dirname, 'src/renderer/src') }
  },
  define: {
    __APP_VERSION__: JSON.stringify('test')
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./tests/setup.ts'],
    include: ['tests/**/*.test.{ts,tsx}'],
    // Editor/agent backup copies (foo.test.ts.cnbak, *.bak-x) must never be collected.
    exclude: [...configDefaults.exclude, '**/*.bak*', '**/*.cnbak*', '**/*bak'],
    restoreMocks: true,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      exclude: [...(configDefaults.coverage.exclude ?? []), '**/*.bak*', '**/*.cnbak*', '**/*bak'],
      include: [
        'src/main/security.ts',
        'src/main/secure-store.ts',
        'src/main/window-state.ts',
        'src/renderer/src/lib/**',
        'src/renderer/src/api/**',
        'src/renderer/src/lyrics/**',
        'src/renderer/src/player/queue.ts',
        'src/renderer/src/player/analysis.ts',
        'src/renderer/src/player/engine.ts',
        'src/renderer/src/store/**'
      ],
      thresholds: { lines: 90, functions: 90, branches: 85, statements: 90 }
    }
  }
})
