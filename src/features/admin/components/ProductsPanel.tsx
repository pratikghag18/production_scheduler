/* ---------------------------------------------------------------------------
   Products — the catalogue admin section (§19.62, D102).

   ⭐ `PRODUCTS_PANEL_READY` LIVES HERE, NOT IN `AdminPage.tsx`. The nav entry
   reads it, so turning this section on is a one-line edit to THIS file — the
   lane that builds the panel is the lane that flips it, and a section cannot be
   switched on without a panel behind it because the switch is part of the
   panel. Group H in `scaleAudit.test.ts` asserts the other half: every id in
   `SECTIONS` has a branch rendering it.

   TAKES NO PROPS, deliberately. `AdminPage.tsx` renders `<ProductsPanel />`
   and four lanes were queued against that file; a panel that needed props
   would have made its shell a shared surface again. Everything this screen
   needs it asks for itself — and the hierarchy read it asks for uses the SAME
   query key `AdminPage` already uses, so React Query serves it from one
   request rather than two.

   DECIDES NOTHING ITSELF. Every rule on this screen — the palette, the owner
   labels, who may write, what a draft must look like, what to say when a
   delete is refused — is a function in `../lib/products.ts`, which is pure and
   is what `src/test/products.test.ts` tests. This file renders what those
   functions return.
   --------------------------------------------------------------------------- */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { describeSchedulerError, fetchHierarchyTree, type SchedulerError } from "@/lib/api";
import { useSession } from "@/features/auth/useSession";
import { canQueryAsUser } from "@/features/auth/session";
import { hierarchyKeys } from "../hooks/useHierarchyMutations";
import {
  canEditProduct,
  describeDeleteRefusal,
  describeWriteRefusal,
  editRefusalNote,
  matchesProductQuery,
  partitionProducts,
  productRows,
  isPaletteToken,
  isHexColor,
  normaliseHexInput,
  PRODUCT_PALETTE,
  productColorVar,
  validateProductDraft,
  type ProductRow,
  type ProductSite,
} from "../lib/products";
import {
  useAdminProducts,
  useCreateProduct,
  useDeleteProduct,
  useSetProductActive,
  useSetProductColor,
  useUpdateProduct,
} from "../hooks/useProducts";
import {
  indentedLabel,
  scopeIndex,
  scopeOptions,
  scopePathLabel,
} from "../lib/scope";
import styles from "./ProductsPanel.module.css";

/** Flip to `true` in the same commit that gives this panel a real body. */
export const PRODUCTS_PANEL_READY = true;

export function ProductsPanel() {
  const { session, profile, loading: sessionLoading } = useSession();
  const canQuery = canQueryAsUser(session?.user.id ?? null, sessionLoading);

  const productsQuery = useAdminProducts(canQuery);
  // The SAME key `AdminPage` uses for its own copy of this read, so the two
  // share one request and one cache entry. Reached through the shared
  // `hierarchyKeys` prefix, so every hierarchy mutation already invalidates it.
  const treeQuery = useQuery({
    queryKey: [...hierarchyKeys.all, "tree"],
    queryFn: fetchHierarchyTree,
    enabled: canQuery,
  });

  const createMutation = useCreateProduct();
  const updateMutation = useUpdateProduct();
  const activeMutation = useSetProductActive();
  const deleteMutation = useDeleteProduct();
  const colorMutation = useSetProductColor();

  const [query, setQuery] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<{ sku: string; name: string; siteNodeId: string }>(
    { sku: "", name: "", siteNodeId: "" },
  );
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [recolouringId, setRecolouringId] = useState<string | null>(null);
  const [rowError, setRowError] = useState<{ id: string; message: string } | null>(null);
  const [newDraft, setNewDraft] = useState({ sku: "", name: "", siteNodeId: "" });
  const [newErrors, setNewErrors] = useState<{ sku: string | null; name: string | null }>({
    sku: null,
    name: null,
  });
  const [formError, setFormError] = useState<string | null>(null);

  /* -- who this person is, and what that lets them change --------------- */

  const isCompanyAdmin = profile?.role === "admin";
  const adminAnywhere = profile?.adminAnywhere === true;

  // ⭐ EVERY NODE, NOT JUST ROOTS (0025 / D103). Until 0025 the trigger refused
  // anything but a root as an owner, so this filtered to `parentId === null`.
  // Pratik: *"how do we assign them to a specific hierarchy level so the lower
  // levels inherit them?"* — so the picker is the tree now, and `nodes_select`
  // already limits it to what this person may see.
  const allNodes = treeQuery.data?.nodes ?? [];
  const nodesById = scopeIndex(allNodes);
  const sites: readonly ProductSite[] = allNodes.map((n) => ({ id: n.id, name: n.name }));

  // ⚠️ FAILS CLOSED when `editable_shape_ids()` could not be read. That RPC is
  // a PREVIEW and `filterEditableShapes` fails OPEN on it one screen over —
  // right there, because the worst case is offering a structure the server
  // then refuses. Here the worst case is offering a WRITE, so the answer flips:
  // a company admin is unaffected either way (their answer comes from their
  // own profile role), and a site admin whose preview failed sees a read-only
  // catalogue with a reason rather than buttons that all fail.
  const editableShapeIds = treeQuery.data?.editableShapeIds ?? null;
  const siteNodeIds: Record<string, string | null> = treeQuery.data?.siteNodeIds ?? {};
  const adminSiteIds: readonly string[] =
    editableShapeIds === null
      ? []
      : editableShapeIds
          .map((shapeId) => siteNodeIds[shapeId] ?? null)
          .filter((id): id is string => id !== null);
  // ⚠️ NOT gated on `treeQuery.data !== undefined`. That term made this flag
  // unreachable in the failure it was written for: when the WHOLE tree read
  // throws, `data` stays undefined for good (`retry: 1`, no refetch on focus),
  // so `previewUnavailable` was false and the add-form fell through to "You
  // don't administer a site, so there's nowhere to add a product." — a flat lie
  // to a site admin whose writes the server would have accepted, with every row
  // simultaneously labelled "Another site" and every button dead. The honest
  // message is the one for a read we could not make, whichever read failed.
  const previewUnavailable =
    !isCompanyAdmin && (treeQuery.isError || editableShapeIds === null);

  // ⭐ THE PICKER FAILS OPEN AND THE SERVER DECIDES. `ownerOptions` narrowed the
  // list to `adminSiteIds`, which is derived from STRUCTURE ownership and is
  // not the question the insert policy asks (see `canEditProduct`'s header) —
  // so a site admin whose root has no claimed structure was offered nothing at
  // all. Offering a node the server then refuses costs one clear sentence now
  // that §19.63's contract exists; offering nothing costs the whole feature.
  const owners = isCompanyAdmin
    ? scopeOptions(allNodes)
    : scopeOptions(allNodes).filter((o) => o.value !== null);
  const ownerLabels = new Map(owners.map((o) => [o.value, indentedLabel(o)]));

  // The owner picker's value, kept legal by construction. A site admin has no
  // company-wide option at all (the insert policy refuses it), so an empty
  // selection would be a form that cannot pass its own `canOwnProduct` check.
  // Falls back to the first owner this person may actually use.
  const ownerValue = owners.some((o) => (o.value ?? "") === newDraft.siteNodeId)
    ? newDraft.siteNodeId
    : (owners[0]?.value ?? "");

  /* -- the catalogue ----------------------------------------------------- */

  const view = productRows(productsQuery.data ?? [], sites);
  const visible = view.rows.filter((r) => matchesProductQuery(r, query));
  const { active, inactive } = partitionProducts(visible);

  // BOTH reads, not just the products one. The tree is what decides who may
  // edit what; rendering the catalogue before it lands showed a fully
  // disabled, mislabelled screen for the width of that window.
  const loading = !canQuery || productsQuery.isLoading || treeQuery.isLoading;

  function clearRowError(id: string) {
    setRowError((cur) => (cur !== null && cur.id === id ? null : cur));
  }

  function beginEdit(row: ProductRow) {
    clearRowError(row.id);
    setConfirmingId(null);
    setEditingId(row.id);
    setEditDraft({ sku: row.sku, name: row.name, siteNodeId: row.siteNodeId ?? "" });
  }

  function saveEdit(row: ProductRow) {
    // ⭐ THE SCOPE IS PART OF THE EDIT NOW. It was set at creation and frozen,
    // which meant a line could be reorganised and its products could not follow
    // — and the create form had a picker while the edit form did not, which is
    // the same shape of gap as a break that could only be deleted and retyped.
    const nextScope = editDraft.siteNodeId === "" ? null : editDraft.siteNodeId;
    const result = validateProductDraft({
      sku: editDraft.sku,
      name: editDraft.name,
      siteNodeId: nextScope,
    });
    if (!result.ok) {
      setRowError({ id: row.id, message: result.skuError ?? result.nameError ?? "" });
      return;
    }
    clearRowError(row.id);
    updateMutation.mutate(
      { id: row.id, sku: result.value.sku, name: result.value.name, siteNodeId: nextScope },
      {
        onSuccess: () => setEditingId((cur) => (cur === row.id ? null : cur)),
        onError: (err: SchedulerError) =>
          setRowError({ id: row.id, message: describeWriteRefusal(err, describeSchedulerError(err)) }),
      },
    );
  }

  function toggleActive(row: ProductRow) {
    clearRowError(row.id);
    activeMutation.mutate(
      { id: row.id, active: !row.active },
      {
        onError: (err: SchedulerError) =>
          setRowError({ id: row.id, message: describeWriteRefusal(err, describeSchedulerError(err)) }),
      },
    );
  }

  function confirmDelete(row: ProductRow) {
    clearRowError(row.id);
    deleteMutation.mutate(row.id, {
      onSuccess: () => setConfirmingId((cur) => (cur === row.id ? null : cur)),
      onError: (err: SchedulerError) => {
        setConfirmingId((cur) => (cur === row.id ? null : cur));
        // `describeSchedulerError` already names the referencing table for a
        // 23503; `describeDeleteRefusal` adds the way out.
        setRowError({ id: row.id, message: describeDeleteRefusal(err, describeSchedulerError(err)) });
      },
    });
  }

  function submitNew() {
    if (profile === null) return;
    const siteNodeId = ownerValue === "" ? null : ownerValue;
    const result = validateProductDraft({ sku: newDraft.sku, name: newDraft.name, siteNodeId });
    if (!result.ok) {
      setNewErrors({ sku: result.skuError, name: result.nameError });
      setFormError(null);
      return;
    }
    setNewErrors({ sku: null, name: null });
    setFormError(null);
    createMutation.mutate(
      {
        // `products.org_id` has NO DEFAULT (0002) — it comes from the session
        // profile on every insert, never from a database default that is not there.
        orgId: profile.orgId,
        sku: result.value.sku,
        name: result.value.name,
        siteNodeId: result.value.siteNodeId,
      },
      {
        onSuccess: () => setNewDraft({ sku: "", name: "", siteNodeId: ownerValue }),
        onError: (err: SchedulerError) =>
          setFormError(describeWriteRefusal(err, describeSchedulerError(err))),
      },
    );
  }

  /* -- render ------------------------------------------------------------ */

  function renderRow(row: ProductRow) {
    // The fourth argument is the fail-open one — see `canEditProduct`'s header.
    // `adminAnywhere` is `app_is_admin_anywhere()`, fetched with the profile,
    // and it is a `boolean | null`: `=== true` rather than a truthiness test,
    // because "we could not ask" must not read as "yes".
    const editable = canEditProduct(row, isCompanyAdmin, adminSiteIds, adminAnywhere);
    const note = editRefusalNote(row, isCompanyAdmin, adminSiteIds, adminAnywhere);
    const isEditing = editingId === row.id;
    const isConfirming = confirmingId === row.id;
    const error = rowError !== null && rowError.id === row.id ? rowError.message : null;

    return (
      <li key={row.id} className={row.active ? styles.row : `${styles.row} ${styles.retired}`}>
        <span className={styles.skuCell}>
          {/* The product's OWN colour (0023 §3), not its position in a list.
              `colorVar` has already fallen back if the token is one this
              stylesheet does not define. */}
          {/* ⭐ THE SWATCH IS THE CONTROL (Pratik, Aug 27). The colour is still
              CHOSEN for a product when it is created — least-used in its
              owner's palette, D102 — and that stays the default, because the
              thing D102 exists to prevent is a colour moving on its own. What
              was missing is a person deliberately overriding one row, which is
              a different act. Clicking the swatch opens the palette; the
              picker offers only tokens `tokens.css` defines, because
              `product-9` passes the database CHECK and renders as no colour
              at all. */}
          <button
            type="button"
            className={styles.swatchBtn}
            style={{ background: row.colorVar }}
            disabled={!editable}
            aria-label={`Colour of ${row.sku}${editable ? " — change it" : ""}`}
            title={
              row.colorUnknown
                ? `Unknown colour ${row.colorToken} — drawn in the first palette colour`
                : editable
                  ? "Change this product's colour"
                  : row.colorToken
            }
            onClick={() => {
              clearRowError(row.id);
              setRecolouringId(recolouringId === row.id ? null : row.id);
            }}
          />
          {isEditing ? (
            <input
              className={styles.input}
              value={editDraft.sku}
              aria-label="Product code"
              onChange={(e) => setEditDraft((d) => ({ ...d, sku: e.target.value }))}
            />
          ) : (
            <span className={styles.sku}>{row.sku}</span>
          )}
        </span>

        {isEditing ? (
          <input
            className={styles.input}
            value={editDraft.name}
            aria-label="Product name"
            onChange={(e) => setEditDraft((d) => ({ ...d, name: e.target.value }))}
          />
        ) : (
          <span className={styles.name}>{row.name}</span>
        )}

        {/* ⭐ THE "BELONGS TO" COLUMN IS THE CONTROL WHEN THE ROW IS BEING
            EDITED. Pratik asked three times for a way to change where an
            existing product belongs, and each time I had wired only the CREATE
            form — the picker existed one card up and nowhere on the row. **The
            edit path is not a smaller version of the create path; it is the
            other half of it**, and every field the create form offers has to
            be reachable here or the value is frozen at birth.

            ⚠️ THE FULL PATH IS THE TOOLTIP when it is not being edited, because
            a scope can be any node and "Line 1" is ambiguous the moment a
            second plant has one. */}
        {isEditing ? (
          <select
            className={styles.input}
            aria-label="Belongs to"
            value={editDraft.siteNodeId}
            onChange={(e) => setEditDraft((d) => ({ ...d, siteNodeId: e.target.value }))}
          >
            {owners.map((o) => (
              <option key={o.value ?? "company"} value={o.value ?? ""}>
                {ownerLabels.get(o.value)}
              </option>
            ))}
          </select>
        ) : (
          <span className={styles.owner} title={scopePathLabel(row.siteNodeId, nodesById)}>
            {row.owner}
          </span>
        )}

        <span className={styles.actions}>
          {isEditing ? (
            <>
              <button type="button" className={styles.primary} onClick={() => saveEdit(row)}>
                Save
              </button>
              <button
                type="button"
                className={styles.quiet}
                onClick={() => setEditingId(null)}
              >
                Cancel
              </button>
            </>
          ) : (
            <>
              {/* ⭐ DEACTIVATE FIRST AND DELETE SECOND, and the order on screen
                  is the decision: anything that has ever been scheduled can
                  never be deleted at all (no ON DELETE on runs/assignments). */}
              <button
                type="button"
                className={styles.primary}
                disabled={!editable}
                onClick={() => toggleActive(row)}
              >
                {row.active ? "Deactivate" : "Reactivate"}
              </button>
              <button
                type="button"
                className={styles.quiet}
                disabled={!editable}
                onClick={() => beginEdit(row)}
              >
                Rename
              </button>
              {isConfirming ? (
                <button
                  type="button"
                  className={styles.danger}
                  onClick={() => confirmDelete(row)}
                >
                  Delete for good?
                </button>
              ) : (
                <button
                  type="button"
                  className={styles.quiet}
                  disabled={!editable}
                  onClick={() => setConfirmingId(row.id)}
                >
                  Delete
                </button>
              )}
            </>
          )}
        </span>

        {recolouringId === row.id && editable && (
          <span className={styles.palette} role="group" aria-label="Product colour">
            {PRODUCT_PALETTE.map((token) => (
              <button
                key={token}
                type="button"
                className={
                  token === row.colorToken
                    ? `${styles.paletteChip} ${styles.paletteChipOn}`
                    : styles.paletteChip
                }
                style={{ background: productColorVar(token) }}
                aria-label={token}
                aria-pressed={token === row.colorToken}
                disabled={colorMutation.isPending}
                onClick={() => {
                  clearRowError(row.id);
                  // The narrow rule — a token this stylesheet can actually
                  // draw — is checked HERE, beside the palette it is about.
                  // `setProductColor` deliberately does not import it.
                  if (!isPaletteToken(token)) return;
                  colorMutation.mutate(
                    { id: row.id, colorToken: token },
                    {
                      onSuccess: () => setRecolouringId(null),
                      onError: (e) =>
                        setRowError({ id: row.id, message: describeWriteRefusal(e, "product") }),
                    },
                  );
                }}
              />
            ))}
            {/* ⭐ THE PALETTE IS THE SHORTCUT; THE FIELD IS THE ANSWER.
                Pratik asked for both, and they are not the same control: four
                swatches cover the common case in one click, and a company with
                six products on one line needs a colour the palette does not
                have. `normaliseHexInput` is deliberately lenient about what a
                person types (`#1BAF7A`, `1baf7a`, `#1ba`) and strict about
                what it stores, because the CHECK takes exactly one spelling
                and refusing a typed `#1BAF7A` would be indefensible. */}
            <input
              type="color"
              className={styles.colorField}
              aria-label="Pick a colour"
              value={isHexColor(row.colorToken) ? row.colorToken : "#1baf7a"}
              disabled={colorMutation.isPending}
              onChange={(e) => {
                const hex = normaliseHexInput(e.target.value);
                if (hex === null) return;
                clearRowError(row.id);
                colorMutation.mutate(
                  { id: row.id, colorToken: hex },
                  {
                    onError: (err) =>
                      setRowError({ id: row.id, message: describeWriteRefusal(err, "product") }),
                  },
                );
              }}
            />
            <input
              type="text"
              className={styles.hexField}
              aria-label="Colour hex code"
              placeholder="#1baf7a"
              defaultValue={isHexColor(row.colorToken) ? row.colorToken : ""}
              disabled={colorMutation.isPending}
              onBlur={(e) => {
                const typed = e.target.value.trim();
                if (typed === "") return;
                const hex = normaliseHexInput(typed);
                if (hex === null) {
                  setRowError({
                    id: row.id,
                    message: "That isn't a colour — use a hex code like #1baf7a.",
                  });
                  return;
                }
                clearRowError(row.id);
                colorMutation.mutate(
                  { id: row.id, colorToken: hex },
                  {
                    onSuccess: () => setRecolouringId(null),
                    onError: (err) =>
                      setRowError({ id: row.id, message: describeWriteRefusal(err, "product") }),
                  },
                );
              }}
            />
          </span>
        )}
        {!row.active && <span className={styles.tag}>Not in use</span>}
        {note !== null && <span className={styles.note}>{note}</span>}
        {row.colorUnknown && (
          <span className={styles.note}>
            This product&rsquo;s colour ({row.colorToken}) is not one the board defines — it is
            drawn in the first palette colour instead.
          </span>
        )}
        {error !== null && <span className={styles.error}>{error}</span>}
      </li>
    );
  }

  if (loading) {
    return (
      <div className={styles.panel}>
        <p className={styles.status}>Loading products…</p>
      </div>
    );
  }

  if (productsQuery.isError) {
    return (
      <div className={styles.panel}>
        <p className={styles.error} role="alert">
          {productsQuery.error
            ? describeSchedulerError(productsQuery.error)
            : "Something went wrong. Please try again."}
        </p>
      </div>
    );
  }

  return (
    <div className={styles.panel}>
      <section className={styles.card}>
        <h2 className={styles.h2}>Add a product</h2>
        {owners.length === 0 ? (
          <p className={styles.status}>
            {previewUnavailable
              ? "We couldn't check which sites you administer, so this list is read-only for now. Reload to try again."
              : "You don't administer a site, so there's nowhere to add a product."}
          </p>
        ) : (
          <div className={styles.form}>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Product code</span>
              <input
                className={styles.input}
                value={newDraft.sku}
                onChange={(e) => setNewDraft((d) => ({ ...d, sku: e.target.value }))}
              />
              {newErrors.sku !== null && <span className={styles.error}>{newErrors.sku}</span>}
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Name</span>
              <input
                className={styles.input}
                value={newDraft.name}
                onChange={(e) => setNewDraft((d) => ({ ...d, name: e.target.value }))}
              />
              {newErrors.name !== null && <span className={styles.error}>{newErrors.name}</span>}
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Belongs to</span>
              {/* ⭐ THE WHOLE TREE, INDENTED (0025 / D103). Company-wide is
                  offered only to a company admin, because that one refusal IS
                  knowable from the profile role with no grant lookup. Every
                  node below it is offered to anyone who administers anywhere,
                  and the server has the final say. */}
              <select
                className={styles.input}
                value={ownerValue}
                onChange={(e) => setNewDraft((d) => ({ ...d, siteNodeId: e.target.value }))}
              >
                {owners.map((o) => (
                  <option key={o.value ?? "company"} value={o.value ?? ""}>
                    {ownerLabels.get(o.value)}
                  </option>
                ))}
              </select>
            </label>
            <button type="button" className={styles.primary} onClick={submitNew}>
              Add
            </button>
          </div>
        )}
        {formError !== null && <p className={styles.error}>{formError}</p>}
        {/* ⚠️ This sentence used to end "and never changes afterwards", which
            stopped being true the moment the swatch became a picker. A hint that
            describes the old behaviour is worse than none: it tells someone the
            control they are looking at does not exist. */}
        <p className={styles.hint}>
          A product&rsquo;s colour is chosen for it when it&rsquo;s created — the least-used one in
          its owner&rsquo;s palette — and never changes on its own afterwards. Click a swatch
          in the list to set it by hand.
        </p>
      </section>

      <section className={styles.card}>
        <h2 className={styles.h2}>Catalogue</h2>
        <input
          className={styles.search}
          value={query}
          placeholder="Search by code or name"
          aria-label="Search products"
          onChange={(e) => setQuery(e.target.value)}
        />

        {view.skipped > 0 && (
          <p className={styles.skippedLine}>
            {view.skipped === 1
              ? "1 product couldn't be read and isn't shown."
              : `${view.skipped} products couldn't be read and aren't shown.`}
          </p>
        )}

        <h3 className={styles.h3}>In use</h3>
        {active.length === 0 ? (
          <p className={styles.status}>Nothing here yet.</p>
        ) : (
          <ul className={styles.list}>
            <li className={styles.head}>
              <span>Code</span>
              <span>Name</span>
              <span>Belongs to</span>
              <span />
            </li>
            {active.map(renderRow)}
          </ul>
        )}

        {/* Retired products are an ordinary, populated part of this screen —
            deactivate is the main action, so what has been deactivated has to
            be somewhere you can find it and bring back. */}
        <h3 className={styles.h3}>Not in use</h3>
        {inactive.length === 0 ? (
          <p className={styles.status}>Nothing retired.</p>
        ) : (
          <ul className={styles.list}>{inactive.map(renderRow)}</ul>
        )}
      </section>
    </div>
  );
}
