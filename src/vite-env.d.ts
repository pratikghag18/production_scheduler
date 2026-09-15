/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL: string;
  readonly VITE_SUPABASE_ANON_KEY: string;
  /** S44-b: the model service's base URL. Unset or empty means no service —
   *  the command bar behaves exactly as before this stage. */
  readonly VITE_VOICE_URL?: string;
  /** S57-a: whisper.cpp's server base URL. Unset or empty means no local
   *  recogniser -- the command bar's microphone stays the browser's own,
   *  exactly as before this stage (design-plan §19.102 / D131). */
  readonly VITE_WHISPER_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
