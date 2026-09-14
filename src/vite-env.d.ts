/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL: string;
  readonly VITE_SUPABASE_ANON_KEY: string;
  /** S44-b: the model service's base URL. Unset or empty means no service —
   *  the command bar behaves exactly as before this stage. */
  readonly VITE_VOICE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
