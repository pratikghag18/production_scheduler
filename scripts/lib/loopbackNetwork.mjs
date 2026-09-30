// scripts/lib/loopbackNetwork.mjs — does a local Supabase stack answer on this
// machine only? (R-460, DEF-0059)
//
// `supabase start` publishes every container's port on EVERY interface
// (`0.0.0.0:54322->5432/tcp`): Postgres with its default password, the API,
// Studio with no sign-in and the mail catcher that holds every invite and
// reset link all answer on the machine's network address. `config.toml` has no
// bind-address setting.
//
// WHAT WAS TRIED AND WHY IT IS NOT HERE (30 Sept). The CLI takes
// `--network-id`, and a Docker bridge network created with
// `-o com.docker.network.bridge.host_binding_ipv4=127.0.0.1` is documented to
// publish every port of every container on it to the loopback address. On
// this machine's Docker Desktop 29.8 the option is ignored: a throwaway
// container published through such a network came up on 0.0.0.0 while an
// explicit `-p 127.0.0.1:...` on the same image came up on loopback. Carrying
// the flag would also have put `--network-id` on every `db reset` and `gen
// types` a person runs, for nothing. So the start scripts do two honest
// things instead: read `docker ps` back and say, loudly, which ports answer
// beyond this machine, and point at the firewall rule (scripts/db-firewall.ps1)
// that closes them on this engine.
//
// Pure functions of text, kept HERE so `src/test/localToolsListenLocally.test.ts`
// can pin them without a container (the same split `testerStack.mjs` makes for
// the config text).

/**
 * Every published port of the stack's containers that is NOT on the loopback
 * address, as `"<container> <mapping>"` lines. `dockerPsText` is the output of
 * `docker ps --format "{{.Names}}\t{{.Ports}}"`. A container belongs to the
 * stack when its name ends `_<projectId>` (the CLI's own naming); an
 * unpublished port (`5432/tcp`, no arrow) is not an address anyone can reach.
 */
export function publishesBeyondLoopback(dockerPsText, projectId) {
  const out = [];
  for (const line of String(dockerPsText).split(/\r?\n/)) {
    const [name, ports = ""] = line.split("\t");
    if (!name || !name.endsWith(`_${projectId}`)) continue;
    for (const mapping of ports.split(",").map((p) => p.trim())) {
      if (!mapping.includes("->")) continue;
      if (!mapping.startsWith("127.0.0.1:")) out.push(`${name} ${mapping}`);
    }
  }
  return out;
}

/**
 * The warning a start script prints when the read-back finds ports published
 * beyond the loopback address. Loud, named, and pointing at the one fix that
 * works on this engine: the firewall rule.
 */
export function beyondLoopbackWarning(script, beyond) {
  return (
    `${script}: WARNING (R-460) -- the stack is up but these ports answer beyond this machine:\n  ` +
    beyond.join("\n  ") +
    "\nClose them with the firewall rule: run scripts/db-firewall.ps1 once as an administrator," +
    " then test from another device on the same network."
  );
}
