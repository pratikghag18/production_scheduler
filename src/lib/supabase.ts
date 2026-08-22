import { createClient } from "@supabase/supabase-js";
import { env } from "@/env";
import type { Database } from "@/lib/database.types";

export const supabase = createClient<Database>(env.supabaseUrl, env.supabaseAnonKey, {
  auth: { persistSession: true, autoRefreshToken: true },
  realtime: { params: { eventsPerSecond: 20 } },
});
