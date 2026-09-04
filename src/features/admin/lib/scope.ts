/**
 * scope.ts — where a product, a person, a training or a shift pattern BELONGS,
 * and therefore where it is offered. Migration 0025 / D103.
 *
 * ---------------------------------------------------------------------------
 * THE MAINTAINER, Aug 27:
 *   "The products/operators/shifts could belong to a particular hierarchy
 *    within the plant and not necessarily to the whole plant... how do we
 *    assign them to a specific hierarchy level so the lower levels inherit
 *    them?"
 *
 * He was shown the two things that sentence could mean — "it decides who may
 * EDIT it" and "it decides WHERE it is offered" — and chose the second.
 *
 * ---------------------------------------------------------------------------
 * ⭐⭐ THE RULE, AND IT IS ONE LINE: available at X when X is AT OR BELOW the
 * scope node. There is no second clause.
 *
 *   scope = Line 1      -> Line 1 itself, and every cell under it
 *   scope = Assembly    -> Assembly, both its lines, and all their cells
 *
 * ⭐ MIGRATION 0028 / D108 REMOVED THE FALLBACK. `scope NULL -> everywhere` was
 * the company-wide default and it is gone from the database: `site_node_id` is
 * NOT NULL on all four tables. The maintainer, Aug 28: *"remove company-wide as an
 * option for products and operators... a person under no circumstances should
 * be able to see data for other plants unless they are system admin, period."*
 * The `null` branches below went with it rather than being left unreachable —
 * a picker that can still emit `null` is a form that fails on submit.
 *
 * ⚠️ "AT OR BELOW" INCLUDES THE NODE ITSELF, and that is load-bearing rather
 * than pedantic. Postgres' `<@` is reflexive and `52_scope_and_colour_test.sql`
 * case S9 pins it on the server; an implementation here that tested strict
 * descent would agree with the server on every cell and disagree on the one
 * node the user actually picked.
 *
 * ⚠️ AND THIS IS A UNION, NOT NEAREST-ANCESTOR-WINS. It looks exactly like
 * `resolve_shift_template` from a distance and it is the opposite shape. A node
 * runs exactly ONE shift pattern, so that resolution sorts by depth and takes
 * one. A node OFFERS MANY products, so every scope that covers it applies: the
 * line's product, the department's, and the company-wide one, all three. Case
 * S10 exists because reusing the `ORDER BY nlevel(...) DESC LIMIT 1` shape here
 * would silently offer one product out of two and look completely reasonable.
 * (Three before 0028, when the company-wide row was the third.)
 *
 * ---------------------------------------------------------------------------
 * ⭐ WHY THE PATH AND NOT THE PARENT CHAIN. `BoardNode.path` is the node's
 * ltree path, maintained by a trigger, and it is the SAME value the server
 * compares. Walking `parentId` instead would be a second implementation of
 * ancestry that can disagree with the first — and `operators.ts` already
 * carries a cycle guard precisely because a hand-walked chain can be malformed.
 * A prefix test cannot loop.
 *
 * ⚠️ THE PREFIX TEST IS ON LABELS, NOT CHARACTERS. `plant1.line1` is NOT an
 * ancestor of `plant1.line10`, and a naive `startsWith` says it is. Every
 * comparison here goes through `isAtOrBelow`, which requires the next character
 * to be a separator or the end of the string.
 *
 * ---------------------------------------------------------------------------
 * ⭐ THE SINGLE-OWNER PREDICATES FAIL OPEN. If a scope names a node this client
 * cannot read — outside the reader's grant, or dropped by a truncated response —
 * the honest answer is "I cannot tell", and the choice is to OFFER it rather than
 * hide it. Hiding is invisible and permanent: a product that silently stops
 * being offered looks exactly like a product nobody created. Offering something
 * the server then refuses is loud, recoverable, and lands on the write-error
 * contract (§19.63), which was built for exactly this.
 *
 * ⚠⚠ THIS IS NOT "everything here", AND THE EXCEPTION COST A DEFECT (DEF-0002).
 * The argument above is about a map narrowed by PERMISSION. `ownedInScope` is
 * handed the board's `index.nodeById`, which is narrowed by a VIEW CHOICE — the
 * plant the reader picked — and there "I cannot resolve it" means "it is in
 * another plant", which is knowledge, not ignorance. It fails CLOSED, says so at
 * its own definition, and the rule for telling the two apart is the one §19.79
 * states below: ask what narrowed the map.
 *
 * ⚠⚠⚠ AND THAT RULE HAS A LIMIT, WHICH COST A SECOND DEFECT (DEF-0005). It can
 * only be applied by someone who knows what narrowed the map — and for a
 * supervisor the board's map is narrowed by a view choice while the product's
 * PLACE LIST was already narrowed by permission, one layer up, before it
 * arrived. By the time a predicate here sees an empty array the two are
 * indistinguishable, and no amount of care inside this file recovers it. That
 * is why the product half of this module no longer decides anything: the server
 * answers it (`board_window`'s `offered_node_ids`, migration 0042) and
 * `productsOfferedAtNode` below only reads the answer. When a question turns
 * out to need information the client was never given, the fix is to move the
 * question, not to sharpen the guess.
 *
 * ⚠️ Note this is the OPPOSITE default from `ProductsPanel`'s edit rights, and
 * deliberately so ([[verification-standard]] rule 8b): that decides whether to
 * offer a WRITE, where the worst case is a button that always fails. This
 * decides what a list SHOWS, where the worst case is work nobody can schedule.
 */

/** The shape this module needs from a node. `BoardNode` satisfies it. */
export interface ScopeNode {
  id: string;
  name: string;
  parentId: string | null;
  /** The ltree path, dot-separated. The same value the server compares. */
  path: string;
}

/**
 * Is `target` at or below `ancestor`, comparing ltree paths label by label?
 *
 * ⚠️ NOT `startsWith`. Labels are separated by `.`, so `plant1.line1` is a
 * prefix of the STRING `plant1.line10` and is not an ancestor of that NODE.
 * Six products on ten lines is enough for that to bite, and the failure is
 * silent — a product offered one line over, with nothing on screen wrong.
 */
export function isAtOrBelow(targetPath: string, ancestorPath: string): boolean {
  if (targetPath === ancestorPath) return true;
  return targetPath.startsWith(ancestorPath + ".");
}

/**
 * Is a thing scoped to `scopeNodeId` offered at the node `targetPath`?
 *
 * @param scopeNodeId the node the thing belongs to. NOT nullable since 0028.
 * @param nodesById   every node this client can read, keyed by id.
 *
 * FAILS OPEN on an unreadable scope node — see the file header.
 */
export function offeredAt(
  scopeNodeId: string,
  targetPath: string,
  nodesById: ReadonlyMap<string, ScopeNode>,
): boolean {
  const scope = nodesById.get(scopeNodeId);
  if (scope === undefined) return true; // cannot tell -> offer it, let the server decide
  return isAtOrBelow(targetPath, scope.path);
}

/** Everything in `items` that is offered at `targetPath`. Order is preserved. */
export function offeredHere<T extends { siteNodeId: string }>(
  items: readonly T[],
  targetPath: string,
  nodesById: ReadonlyMap<string, ScopeNode>,
): T[] {
  return items.filter((i) => offeredAt(i.siteNodeId, targetPath, nodesById));
}

/**
 * Everything in `items` OWNED by one of `scopedNodeIds` — the board's per-plant
 * assignable pool.
 *
 * ⭐ MEMBERSHIP, NOT A PATH COMPARE, AND THAT IS THE WHOLE FIX. `board_window`'s
 * `nodes` are already scoped to the selected root's subtree, so the set of node
 * ids the board knows about IS this plant. An operator belongs here exactly when
 * its owner is one of them. An earlier version resolved owner PATHS and "failed
 * open" on an owner it could not find — but a different plant's owner is never in
 * the scoped set, so every out-of-plant operator was kept: the exact bug this
 * exists to fix. There is no fail-open here on purpose: an owner outside the
 * scoped set is a real "not this plant", not an "I cannot tell".
 *
 * ⚠️ A POOL FILTER, NOT A DRAW FILTER. `board_window` still returns every
 * operator (S18) and `index.operatorById` keeps them all, so a chip for a
 * cross-plant assignment still renders its name; only the OFFERED pool is cut.
 */
export function ownedInScope<T extends { siteNodeId: string }>(
  items: readonly T[],
  scopedNodeIds: ReadonlySet<string>,
): T[] {
  return items.filter((i) => scopedNodeIds.has(i.siteNodeId));
}

/* ---------------------------------------------------------------------------
 * ⭐ D115 / migration 0034: A PRODUCT IS OFFERED FROM A LIST OF PLACES.
 *
 * Operators, trainings and shift patterns keep a single owner and use
 * `offeredAt` above. A product is made in one, several or all plants, so it is
 * offered where ANY of its places covers the cell — the union, not one owner.
 * This is a SECOND function rather than a widening of `offeredAt`, because
 * folding a list into the single-owner path would make every caller carry an
 * array it does not have (operators do not) and would blur the one place the
 * cardinalities differ. `app_product_offered_at` (0034 §3) is the server twin.
 * ------------------------------------------------------------------------- */

/**
 * Which products are offered at `nodeId`, ACCORDING TO THE SERVER.
 *
 * ⭐⭐ THIS FUNCTION USED TO DERIVE THE ANSWER AND NOW ONLY READS IT, AND THAT
 * IS THE WHOLE OF DEF-0005. It was `productOfferedAt(siteNodeIds, targetPath,
 * nodesById)`: take the product's places, resolve each one in the board's node
 * map, and ask `isAtOrBelow`. That is the right RULE — it is the rule the
 * server's `app_product_offered_at` runs — asked of the wrong MATERIAL.
 * `product_sites` is RLS-filtered on read and reading is downward from a grant,
 * so a supervisor granted a LINE cannot read the PLANT, and a plant-wide part
 * reached this client with `siteNodeIds: []`. Every version of this function
 * answered "offered nowhere", correctly, for a list that had been emptied on
 * the way. One supervisor was offered ONE part out of the four on her own
 * legend while the server accepted all four.
 *
 * ⚠️ AND THE PREVIOUS FIX'S OWN PROOF SAID THIS COULD NOT HAPPEN. DEF-0002
 * turned a fail-open into a fail-closed here and argued, in this comment, that
 * "nothing legitimately offerable disappears" — reasoning that was sound about
 * the CHANGE (an empty list short-circuits before either branch, so the change
 * moved nothing) and then generalised to the picker as a whole, which it never
 * examined. `scope.test.ts` case XP9 was green while asserting the opposite of
 * what the server answers. A green case can be pinning the bug; a proof that
 * quietly widens its own scope is how one gets written.
 *
 * ⭐ SO THE CLIENT STOPPED DERIVING AND STARTED ASKING. `board_window` now
 * carries `offered_node_ids` per product (migration 0042) — the nodes in this
 * window where the server would ACCEPT a run — computed by
 * `app_offered_product_nodes` under SECURITY DEFINER, the set form of the same
 * predicate the write guard runs. Membership is the entire test, and there is
 * no path logic left here to disagree with the server about. CLAUDE.md §4:
 * whatever a client hides or offers must be decided by the same test the server
 * runs.
 *
 * ⚠️ AN EMPTY LIST IS STILL A REAL "NOWHERE", but for a better reason than
 * before: it is now an ANSWER rather than a filtered list implying one.
 * `history.ts`'s synthesised deleted product carries an empty one deliberately.
 *
 * ⚠️ NO NODE MAP, NO PATHS, NO `isAtOrBelow` — deliberately. Handing this
 * function the board's node map again would reintroduce the question "what
 * narrowed this map", which is exactly the question that cannot be answered
 * from inside this module: for a supervisor the map is narrowed by a view
 * choice AND the place list was already narrowed by permission one layer up.
 */
export function productsOfferedAtNode<T extends { offeredNodeIds: readonly string[] }>(
  items: readonly T[],
  nodeId: string,
): T[] {
  return items.filter((i) => i.offeredNodeIds.includes(nodeId));
}

/* ===========================================================================
 * The picker.
 * ======================================================================== */

export interface ScopeOption {
  /** A node id. Never `null` since 0028 — there is no company-wide entry. */
  value: string;
  /** The node's own name — the label is built from this plus `depth`. */
  name: string;
  /** 0 for a root; used to indent. */
  depth: number;
}

/**
 * The "Belongs to" list, in tree order, depth-indented.
 *
 * ⭐ IT IS BUILT FROM THE PATH, NOT BY RECURSION. Sorting by path puts every
 * node immediately after its parent and before its parent's next sibling —
 * which is what tree order IS — and counting the labels gives the depth. A
 * recursive walk over `parentId` would need a cycle guard and would drop any
 * node whose parent this reader cannot see; sorting cannot do either.
 *
 * ⚠️ A NODE WHOSE PARENT IS UNREADABLE IS STILL LISTED, at the depth its own
 * path implies. It will look over-indented rather than disappear, and that is
 * the right trade: an admin of a department who cannot read the plant above it
 * must still be able to scope things to their own department.
 *
 * ⚠⚠ THIS TOOK A `canEdit` SET AND IT HAS BEEN REMOVED. IT WAS DEAD, AND ITS
 * DOC COMMENT ARGUED AGAINST A DECISION THAT HAD ALREADY BEEN MEASURED.
 *
 * The comment read: *"ids the caller may scope TO — a picker that offers a node
 * the server will refuse is a control whose only outcome is an error message"*.
 * Persuasive, D106-shaped, and **wrong for every caller this project has.**
 *
 *  1. **Nothing ever passed it.** All three callers — `OperatorsPanel`,
 *     `ProductsPanel`, `ShiftsPanel` — called this with one argument.
 *  2. **The one attempt was reverted after being measured.** `ProductsPanel`
 *     narrowed its owner list to `adminSiteIds` and the comment it left behind
 *     is the record: that set is derived from STRUCTURE ownership and *is not
 *     the question the insert policy asks*, so **a site admin whose root has no
 *     claimed structure was offered nothing at all.** Its verdict stands —
 *     *"offering a node the server then refuses costs one clear sentence now
 *     that §19.63's contract exists; offering nothing costs the whole
 *     feature."*
 *  3. **No correct set is derivable on the client today.** The server exposes
 *     `editable_shape_ids()` (STRUCTURES, not nodes) and
 *     `app_is_admin_anywhere()` (a BOOLEAN). There is no read that returns the
 *     nodes a caller may administer, so there is nothing honest to pass.
 *
 * ⭐⭐ AND IT COST SOMETHING BEFORE IT WAS REMOVED: the parameter's own doc was
 * read, believed, and filed as a live defect against all three panels — without
 * the call site where the opposite had been measured. **A dead parameter with a
 * persuasive comment is not neutral; it is a trap that argues for itself.** It
 * is deleted rather than left unused, the same way §19.74 deleted
 * `deletePrecheck` instead of relaxing it.
 *
 * ⚠️ WHAT WOULD BRING IT BACK: a server read returning the node ids the caller
 * may administer (`app_is_admin_for` per node, or a set-returning twin of it).
 * Until that exists, this function offers every node it is given and the write
 * error is the honest answer — §19.63's contract was built for exactly that.
 *
 * ⚠️ NOT TO BE CONFUSED WITH THE PLANT FILTER (§19.79), which DOES narrow the
 * `nodes` handed in. That is a VIEW CHOICE the reader made and can undo; this
 * was a PERMISSION. Passing one as the other is the confusion §19.77 is about.
 */
export function scopeOptions(nodes: readonly ScopeNode[]): ScopeOption[] {
  const sorted = [...nodes].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  // ⭐ 0028: the list used to open with an "Everywhere (company-wide)" entry.
  // It is not filtered out here, it is not built — a picker that can emit a
  // value the database refuses is D106's defect with a different label on it.
  return sorted.map((n) => ({ value: n.id, name: n.name, depth: n.path.split(".").length - 1 }));
}

/** `"— — Line 1"` — the indent an option element cannot express with CSS. */
export function indentedLabel(option: ScopeOption): string {
  // A non-breaking figure space, doubled per level. Leading ordinary spaces are
  // collapsed by every browser's <option> rendering; this survives.
  return `${"  ".repeat(option.depth)}${option.name}`;
}

/**
 * The sentence a row shows for where it belongs.
 *
 * ⚠️ AN UNREADABLE SCOPE READS AS "Somewhere else". Before 0028 the warning
 * here was that it must never read as "Company-wide" — two answers a reader
 * must not confuse, one meaning everyone can use it and the other meaning this
 * person cannot see where it lives. Only the second survives, and under 0028
 * it should now be unreachable in practice: a row you can read is owned by a
 * node on one of your own branches. It is kept, because "unreachable" is a
 * claim about the server and this function is what the user sees if it stops
 * being true.
 */
export function scopeLabel(scopeNodeId: string, nodesById: ReadonlyMap<string, ScopeNode>): string {
  const node = nodesById.get(scopeNodeId);
  return node === undefined ? "Somewhere else" : node.name;
}

/**
 * The full path of a scope, for a tooltip: `"Plant 1 › Assembly › Line 1"`.
 *
 * Walks the parent chain rather than the path, because the path holds SLUGS and
 * this has to show NAMES. It therefore needs the cycle guard `operators.ts`
 * needed, and truncates rather than looping.
 */
export function scopePathLabel(
  scopeNodeId: string,
  nodesById: ReadonlyMap<string, ScopeNode>,
): string {
  const names: string[] = [];
  const seen = new Set<string>();
  let cur = nodesById.get(scopeNodeId);
  let truncated = false;
  while (cur !== undefined) {
    if (seen.has(cur.id)) {
      truncated = true;
      break;
    }
    seen.add(cur.id);
    names.push(cur.name);
    if (cur.parentId === null) break;
    const parent = nodesById.get(cur.parentId);
    if (parent === undefined) {
      truncated = true;
      break;
    }
    cur = parent;
  }
  if (names.length === 0) return "Somewhere else";
  names.reverse();
  return truncated ? `… › ${names.join(" › ")}` : names.join(" › ");
}

/** `ScopeNode`s keyed by id — every function above takes this. */
export function scopeIndex(nodes: readonly ScopeNode[]): Map<string, ScopeNode> {
  return new Map(nodes.map((n) => [n.id, n]));
}
