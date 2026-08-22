type Env = { supabaseUrl: string; supabaseAnonKey: string };

function read(name: string): string {
  const value = import.meta.env[name as keyof ImportMetaEnv] as string | undefined;
  if (!value) {
    throw new Error(
      `Missing ${name}. Copy .env.example to .env.local and fill in your Supabase project values.`,
    );
  }
  return value;
}

export const env: Env = {
  supabaseUrl: read("VITE_SUPABASE_URL"),
  supabaseAnonKey: read("VITE_SUPABASE_ANON_KEY"),
};
