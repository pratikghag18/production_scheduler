import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import styles from "./HealthPill.module.css";

type HealthState = "checking" | "connected" | "unreachable";

export function HealthPill() {
  const { status, error } = useQuery({
    queryKey: ["health"],
    staleTime: 30_000,
    queryFn: async () => {
      const { error } = await supabase.auth.getSession();
      if (error) throw error;
      return true;
    },
  });

  const state: HealthState =
    status === "pending" ? "checking" : status === "success" ? "connected" : "unreachable";

  const label =
    state === "checking"
      ? "Checking Supabase…"
      : state === "connected"
        ? "Supabase connected"
        : (error?.message ?? "Supabase unreachable");

  return (
    <span className={styles.pill} title={state === "unreachable" ? label : undefined}>
      <span className={`${styles.dot} ${styles[state]}`} aria-hidden="true" />
      {label}
    </span>
  );
}
