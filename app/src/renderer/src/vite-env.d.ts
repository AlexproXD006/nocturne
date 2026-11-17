/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_DEFAULT_SERVER?: string
  /** Project URL sent to LRCLIB in the Lrclib-Client header (optional). */
  readonly VITE_PROJECT_URL?: string
  /** 'true' in the hosted web build (npm run build:hosted). */
  readonly VITE_HOSTED?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
