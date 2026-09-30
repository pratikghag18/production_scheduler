// DEF-0053, the live proof. Not a vitest file: run it by hand against a stack
// that holds the demo seed (the tester's own, R-366), with the stack's values
// exported as the tester brief says:
//
//   node src/test/defects/DEF-0053.live.mjs
//
// It asks the server's capacity question about Priya Shah -- who is on Cell 4
// (Line 2) from 6 am to 2 pm every day of the seeded week -- as Ana (Line 1
// supervisor) and as Dana (Plant A admin), then makes the overlapping booking
// as Ana on Cell 1, reads Priya's load back as Dana, and deletes the probe row.
// Exit code 1 while the defect stands, 0 once Ana is told what Dana is told.
import { createClient } from "@supabase/supabase-js";

const url = process.env.VITE_SUPABASE_URL;
const key = process.env.VITE_SUPABASE_ANON_KEY;
if (!url || !key) {
  console.error(
    "Export VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY first (tester-stack.mjs env).",
  );
  process.exit(2);
}

async function signedIn(email) {
  const anon = createClient(url, key);
  const { data, error } = await anon.auth.signInWithPassword({ email, password: "devpassword" });
  if (error || !data.session) throw new Error(`sign-in for ${email}: ${error?.message}`);
  return createClient(url, key, {
    global: { headers: { Authorization: `Bearer ${data.session.access_token}` } },
  });
}

const ana = await signedIn("ana@example.test");
const dana = await signedIn("dana@example.test");

const { data: nodes } = await dana.from("nodes").select("id, name, path");
const cell = (path) => nodes.find((n) => n.path === path);
const { data: people } = await dana.from("operators").select("id, display_name");
const priya = people.find((p) => p.display_name === "Priya Shah").id;
const { data: products } = await dana.from("products").select("id, name");
const housing = products.find((p) => p.name === "Housing A").id;

// A block of Priya's on Line 2 that has not started yet, read as the admin.
const { data: hers } = await dana
  .from("assignments")
  .select("id, node_id, timerange")
  .eq("operator_id", priya)
  .eq("node_id", cell("plant_a.area_1.line_2.cell_4").id);
const bounds = (r) =>
  r.timerange
    .slice(1, -1)
    .split(",")
    .map((s) => new Date(s.replaceAll('"', "")));
const next = hers
  .map((r) => ({ ...r, from: bounds(r)[0], to: bounds(r)[1] }))
  .filter((r) => r.to.getTime() - Date.now() > 2 * 3600_000)
  .sort((a, b) => a.from - b.from)[0];
if (!next) throw new Error("no upcoming block for Priya Shah on Cell 4 -- is this the demo seed?");
const from = new Date(Math.max(next.from.getTime(), Date.now() + 3600_000));
const range = `[${from.toISOString()},${new Date(from.getTime() + 1800_000).toISOString()})`;
console.log(`Priya Shah is on Cell 4 ${next.timerange}; asking about ${range}`);

const probe = async (who) => {
  const { data, error } = await who.rpc("capacity_probe", {
    p_operator_id: priya,
    p_timerange: range,
    p_efficiency: 1,
  });
  if (error) throw new Error(`capacity_probe: ${error.message}`);
  return data;
};
const asAna = await probe(ana);
const asDana = await probe(dana);
console.log(`capacity_probe as Ana : fits=${asAna.fits} peak=${asAna.peak} cap=${asAna.cap}`);
console.log(`capacity_probe as Dana: fits=${asDana.fits} peak=${asDana.peak} cap=${asDana.cap}`);

const write = await ana.rpc("create_assignment", {
  p_node_id: cell("plant_a.area_1.line_1.cell_1").id,
  p_operator_id: priya,
  p_run_id: null,
  p_product_id: housing,
  p_timerange: range,
});
let accepted = false;
if (write.error) {
  console.log(
    `create_assignment as Ana on Cell 1: REFUSED ${write.error.code} "${write.error.message}"`,
  );
} else {
  accepted = true;
  const id = write.data?.id ?? write.data?.assignment?.id;
  console.log(`create_assignment as Ana on Cell 1: ACCEPTED (${id})`);
  const after = await probe(dana);
  console.log(
    `Priya Shah's load over that half hour, read as Dana, now: ${Number(after.peak) - 1} (cap ${after.cap})`,
  );
  const { data: mine } = await dana
    .from("assignments")
    .select("id")
    .eq("operator_id", priya)
    .eq("node_id", cell("plant_a.area_1.line_1.cell_1").id)
    .eq("timerange", range);
  for (const row of mine ?? []) await dana.from("assignments").delete().eq("id", row.id);
  console.log(`probe row(s) deleted as Dana: ${(mine ?? []).length}`);
}

const defect = asAna.fits !== asDana.fits || accepted;
console.log(
  defect
    ? "DEFECT STANDS: the supervisor was told, or allowed, what the plant admin is refused."
    : "held: the same answer for both.",
);
process.exit(defect ? 1 : 0);
