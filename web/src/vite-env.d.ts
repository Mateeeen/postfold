/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * Absolute base URL of the PostFold API. Empty when the API serves this
   * bundle itself; set on Vercel, where the UI and the API are separate hosts.
   */
  readonly VITE_API_BASE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
