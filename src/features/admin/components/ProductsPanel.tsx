/* ---------------------------------------------------------------------------
   Products — the catalogue admin section (§19.62, D102; §19.81 / D115).

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

   DECIDES NOTHING ITSELF. Every rule on this screen — the palette, who may
   write the shared record, who may manage a plant, what a draft must look
   like, what to say when a write is refused — is a function in
   `../lib/products.ts` (pure, tested by `src/test/products.test.ts`) or in
   `../lib/scope.ts` / `../lib/plantFilter.ts`. This file renders what those
   functions return.

   ⭐⭐ D115 / THE SPLIT (§19.81). A product is no longer owned by ONE node.
   It is the company-wide record — sku, name, colour — plus a SEPARATE LIST of
   the plants that make it (`row.siteNodeIds`). The two are governed apart:

     THE SHARED RECORD  (create, rename, recolour, retire, delete)  — company
                                                                      admin only
     THE LIST OF MAKERS (add / remove a plant)                      — a plant
                                                                      admin may
                                                                      manage a
                                                                      node THEY
                                                                      administer

   So there is NO owner picker any more, on the create form or on the row. The
   create form asks only for sku + name; each row shows a "Made in" area — the
   plants it is made in, by name — with a remove control per plant and an "Add
   plant" tree picker. A product made in ZERO plants is an ordinary catalogue
   entry, not an error; it is shown plainly as "Not assigned to any plant yet".
   --------------------------------------------------------------------------- */
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { describeSchedulerError, fetchHierarchyTree, type SchedulerError } from "@/lib/api";
import { useSession } from "@/features/auth/useSession";
import { canQueryAsUser } from "@/features/auth/session";
import { hierarchyKeys } from "../hooks/useHierarchyMutations";
import {
  canEditProduct,
  canManagePlace,
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
} from "../lib/products";
import {
  useAdminProducts,
  useAssignProductSite,
  useCreateProduct,
  useSetProductActive,
  useSetProductColor,
  useUnassignProductSite,
  useUpdateProduct,
} from "../hooks/useProducts";
import { DeleteDialog } from "./DeleteDialog";
import { usePlantFilter } from "../hooks/usePlantFilter";
import { nodesInPlant, productRowsInPlant } from "../lib/plantFilter";
import {
  indentedLabel,
  scopeIndex,
  scopeLabel,
  scopeOptions,
  scopePathLabel,
  type ScopeNode,
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
  const colorMutation = useSetProductColor();
  const assignMutation = useAssignProductSite();
  const unassignMutation = useUnassignProductSite();

  const [query, setQuery] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  // ⭐ D115: THE EDIT IS THE SHARED RECORD ONLY — sku and name. Where a product
  // is made is the `product_sites` list, managed by its own controls (the chips
  // and the add picker), not by this draft. There is no owner field here.
  const [editDraft, setEditDraft] = useState<{ sku: string; name: string }>({
    sku: "",
    name: "",
  });
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [recolouringId, setRecolouringId] = useState<string | null>(null);
  const [rowError, setRowError] = useState<{ id: string; message: string } | null>(null);
  // ⭐ SEPARATE FROM `rowError`, AND THE SEPARATION IS THE POINT. A delete that
  // succeeds still has something to say — what went and what stayed — and
  // saying it in the row's error slot would style an outcome as a failure.
  const [rowNotice, setRowNotice] = useState<{ id: string; message: string } | null>(null);
  const [newDraft, setNewDraft] = useState({ sku: "", name: "" });
  const [newErrors, setNewErrors] = useState<{ sku: string | null; name: string | null }>({
    sku: null,
    name: null,
  });
  const [formError, setFormError] = useState<string | null>(null);

  /* -- who this person is, and what that lets them change --------------- */

  // ⭐ D115 / the Split: the shared record is company property. This client
  // knows for certain whether it may touch it — `role === 'admin'`, no grant
  // read needed — so `canEditProduct` is now simply this boolean.
  const isCompanyAdmin = profile?.role === "admin";

  const allNodes = treeQuery.data?.nodes ?? [];
  const nodesById = scopeIndex(allNodes);

  /* -- which plant this screen is showing (roadmap 1(c)) ------------------ */

  // ⭐ THE CHOICE IS MADE ONE SCREEN UP AND THIS PANEL ONLY READS IT. The
  // control and the header chip live on `AdminPage`, once, for the whole admin
  // screen. `usePlantFilter` returns `choice: null` ("All plants") for anyone
  // with a single readable root, so this panel never has to ask who is looking.
  //
  // ⚠️ IT FAILS OPEN WHEN THE STRUCTURE READ FAILED. `allNodes` is then `[]`,
  // so there are no readable roots, `resolvePlantChoice` collapses to `null`,
  // and every trim below is the identity — a failed tree read cannot empty this
  // catalogue.
  const plant = usePlantFilter(allNodes);

  // ⚠️ FAILS CLOSED when `editable_shape_ids()` could not be read, for the
  // shared-record controls a company admin does not depend on this for. A site
  // admin whose preview failed sees the plant controls read-only with a reason
  // rather than buttons that all fail. (A company admin's rights come from their
  // profile role, so they are unaffected either way.)
  const editableShapeIds = treeQuery.data?.editableShapeIds ?? null;
  const siteNodeIds: Record<string, string | null> = treeQuery.data?.siteNodeIds ?? {};
  // ⭐ THE COARSE CLIENT SET OF NODES THIS PERSON ADMINISTERS — roots derived
  // from the structures they may edit. `canManagePlace` uses it to decide which
  // plant chips get a remove control and whether to offer the add picker.
  const adminSiteIds: readonly string[] =
    editableShapeIds === null
      ? []
      : editableShapeIds
          .map((shapeId) => siteNodeIds[shapeId] ?? null)
          .filter((id): id is string => id !== null);
  const previewUnavailable = !isCompanyAdmin && (treeQuery.isError || editableShapeIds === null);

  // ⭐ WHO MAY OPEN THE ADD-PLANT PICKER AT ALL. A company admin always; a site
  // admin only if they administer something. Someone who administers nowhere is
  // offered nothing to add rather than a picker whose every choice the server
  // refuses. The picker's contents still fail open per node (see the row).
  const canManageAny = isCompanyAdmin || adminSiteIds.length > 0;

  // ⭐ THE ADD PICKER'S NODE POOL — the whole readable tree on "All plants", the
  // chosen plant's subtree otherwise (the plant filter narrows the FORMS too,
  // 1(c) decision 3). A node already in a product's list is filtered out per row.
  // ⚠️ This is a VIEW-CHOICE narrowing, not a PERMISSION one: the server decides
  // whether an offered node may actually be added, and refuses with a sentence.
  const addableNodes: readonly ScopeNode[] = nodesInPlant(allNodes, plant.choice, plant.plants);

  /* -- the catalogue ----------------------------------------------------- */

  // ⭐ D115: `productRows` no longer takes `sites` and no longer drops an
  // "elsewhere" product. Every product that arrives here legitimately belongs to
  // this reader's world (`products_select` admits only those), so there is
  // nothing to resolve an owner name for and nothing to drop — just the
  // skip-and-count for a row this client could not read.
  const view = productRows(productsQuery.data ?? []);

  // ⭐⭐ THE PLANT FILTER TRIMS THE ROWS. A product is in the chosen plant when
  // ANY of its places is at or below it (`productRowsInPlant`). A part assigned
  // to no plant falls out of a narrowed view and returns on "All plants" — see
  // that function's header.
  const inPlant = productRowsInPlant(view.rows, plant.choice, plant.plants, nodesById);
  const hiddenByPlant = view.rows.length - inPlant.length;

  // ⚠️ THE PLANT CUT COMES BEFORE THE SEARCH, so `hiddenByPlant` is a fact
  // about the control in the header and does not move while somebody types.
  const visible = inPlant.filter((r) => matchesProductQuery(r, query));
  const { active, inactive } = partitionProducts(visible);

  /* -- id-keyed state, when the filter takes its row away ----------------- */

  // ⭐ THE THREE THINGS THAT OPEN A FORM ON A ROW. When the plant filter removes
  // that row, the door has to be closed — a form is not a sentence, and
  // resolve-or-fall-back is not enough for it (widening back would re-open a
  // delete confirmation the reader left behind two plants ago). `rowError` and
  // `rowNotice` are deliberately left alone — a sentence about a vanished row
  // honestly stops being rendered when the row goes.
  const inPlantIds = new Set(inPlant.map((r) => r.id));
  const editingGone = editingId !== null && !inPlantIds.has(editingId);
  const confirmingGone = confirmingId !== null && !inPlantIds.has(confirmingId);
  const recolouringGone = recolouringId !== null && !inPlantIds.has(recolouringId);
  useEffect(() => {
    if (editingGone) setEditingId(null);
    if (confirmingGone) setConfirmingId(null);
    if (recolouringGone) setRecolouringId(null);
  }, [editingGone, confirmingGone, recolouringGone]);

  // BOTH reads, not just the products one. The tree is what decides who may
  // manage what; rendering the catalogue before it lands showed a fully
  // disabled, mislabelled screen for the width of that window.
  const loading = !canQuery || productsQuery.isLoading || treeQuery.isLoading;

  function clearRowError(id: string) {
    setRowError((cur) => (cur !== null && cur.id === id ? null : cur));
  }

  function beginEdit(row: ProductRow) {
    clearRowError(row.id);
    setConfirmingId(null);
    setEditingId(row.id);
    setEditDraft({ sku: row.sku, name: row.name });
  }

  function saveEdit(row: ProductRow) {
    // ⭐ D115: THE RENAME IS THE SHARED RECORD ONLY. Places travel through their
    // own writes, so this carries just sku and name and can only fail on a
    // duplicate sku or a refused write — one write, one thing that can be wrong.
    const result = validateProductDraft({ sku: editDraft.sku, name: editDraft.name });
    if (!result.ok) {
      setRowError({ id: row.id, message: result.skuError ?? result.nameError ?? "" });
      return;
    }
    clearRowError(row.id);
    updateMutation.mutate(
      { id: row.id, sku: result.value.sku, name: result.value.name },
      {
        onSuccess: () => setEditingId((cur) => (cur === row.id ? null : cur)),
        onError: (err: SchedulerError) =>
          setRowError({
            id: row.id,
            message: describeWriteRefusal(err, describeSchedulerError(err)),
          }),
      },
    );
  }

  function toggleActive(row: ProductRow) {
    clearRowError(row.id);
    activeMutation.mutate(
      { id: row.id, active: !row.active },
      {
        onError: (err: SchedulerError) =>
          setRowError({
            id: row.id,
            message: describeWriteRefusal(err, describeSchedulerError(err)),
          }),
      },
    );
  }

  function addPlant(row: ProductRow, nodeId: string) {
    if (profile === null || nodeId === "") return;
    clearRowError(row.id);
    setRowNotice(null);
    assignMutation.mutate(
      { orgId: profile.orgId, productId: row.id, nodeId },
      {
        onError: (err: SchedulerError) => {
          // ⭐ ADDING A PLANT TWICE IS `DuplicateValue` — the plant is already in
          // the list, which is the outcome the reader wanted. Say nothing; the
          // refetch shows it. Every other refusal (a plant that is not theirs ->
          // `WriteRefused`) gets its own sentence.
          if (err.kind === "DuplicateValue") return;
          setRowError({ id: row.id, message: describeSchedulerError(err) });
        },
      },
    );
  }

  function removePlant(row: ProductRow, nodeId: string) {
    if (profile === null) return;
    clearRowError(row.id);
    setRowNotice(null);
    unassignMutation.mutate(
      { orgId: profile.orgId, productId: row.id, nodeId },
      {
        // ⚠️ TWO REFUSALS, EACH ITS OWN SENTENCE. `owner_change_blocked` ->
        // `OwnerChangeBlocked` (the part is still scheduled somewhere only this
        // plant covers); a plant that is not theirs -> `WriteRefused`.
        // `describeSchedulerError` says the right thing for each and
        // `describeWriteRefusal` passes both through unchanged.
        onError: (err: SchedulerError) =>
          setRowError({
            id: row.id,
            message: describeWriteRefusal(err, describeSchedulerError(err)),
          }),
      },
    );
  }

  function submitNew() {
    if (profile === null) return;
    const result = validateProductDraft({ sku: newDraft.sku, name: newDraft.name });
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
        // profile on every insert. ⭐ D115: no place here — a just-created part
        // is offered nowhere until a plant is added, a legitimate state.
        orgId: profile.orgId,
        sku: result.value.sku,
        name: result.value.name,
      },
      {
        onSuccess: () => setNewDraft({ sku: "", name: "" }),
        onError: (err: SchedulerError) =>
          setFormError(describeWriteRefusal(err, describeSchedulerError(err))),
      },
    );
  }

  /* -- render ------------------------------------------------------------ */

  function renderRow(row: ProductRow) {
    // ⭐ D115: TWO DIFFERENT PERMISSIONS ON ONE ROW. `editable` gates the shared
    // record (rename, recolour, retire, delete) and is simply "are you a company
    // admin". Managing a PLACE is decided per place by `canManagePlace`.
    const editable = canEditProduct(isCompanyAdmin);
    const note = editRefusalNote(isCompanyAdmin);
    const isEditing = editingId === row.id;
    const isConfirming = confirmingId === row.id;
    const error = rowError !== null && rowError.id === row.id ? rowError.message : null;
    const notice = rowNotice !== null && rowNotice.id === row.id ? rowNotice.message : null;

    // The nodes offerable in THIS row's add picker: the readable pool (already
    // narrowed by the plant filter) minus the places it is already made in.
    const assigned = new Set(row.siteNodeIds);
    const addOptions = scopeOptions(addableNodes.filter((n) => !assigned.has(n.id)));

    return (
      <li key={row.id} className={row.active ? styles.row : `${styles.row} ${styles.retired}`}>
        <span className={styles.skuCell}>
          {/* The product's OWN colour (0023 §3). `colorVar` has already fallen
              back if the token is one this stylesheet does not define. Clicking
              the swatch opens the palette — a company-admin act (recolour is the
              shared record), so it is disabled for anyone who cannot edit. */}
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
              /* ⚠️ NAMED FOR ITS ROW, not just for its field — the Add card's
                 field is also labelled "Product code", so two identically-named
                 boxes would be indistinguishable to a screen reader. */
              aria-label={`Product code for ${row.sku}`}
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
            aria-label={`Name for ${row.sku}`}
            onChange={(e) => setEditDraft((d) => ({ ...d, name: e.target.value }))}
          />
        ) : (
          <span className={styles.name}>{row.name}</span>
        )}

        {/* ⭐ D115: "MADE IN" — the LIST of plants, not one owner. Each place is
            a chip; a chip this reader may manage carries a remove control, one
            they cannot is plain text (a site admin sees only their own plants
            here anyway — the list is RLS-scoped). An empty list says so plainly.
            The add picker sits below, offered when this reader manages anywhere. */}
        <span className={styles.madeIn}>
          {row.siteNodeIds.length === 0 ? (
            <span className={styles.unassigned}>Not assigned to any plant yet</span>
          ) : (
            <span className={styles.plantChips}>
              {row.siteNodeIds.map((placeId) => {
                const label = scopeLabel(placeId, nodesById);
                const removable = canManagePlace(placeId, isCompanyAdmin, adminSiteIds);
                return (
                  <span
                    key={placeId}
                    className={styles.plantChip}
                    title={scopePathLabel(placeId, nodesById)}
                  >
                    <span className={styles.plantName}>{label}</span>
                    {removable && (
                      <button
                        type="button"
                        className={styles.plantRemove}
                        aria-label={`Remove ${label} from ${row.sku}`}
                        disabled={unassignMutation.isPending}
                        onClick={() => removePlant(row, placeId)}
                      >
                        ×
                      </button>
                    )}
                  </span>
                );
              })}
            </span>
          )}
          {(canManageAny || previewUnavailable) &&
            (previewUnavailable ? (
              <span className={styles.note}>
                We couldn&rsquo;t check which plants you administer, so adding one is unavailable
                for now. Reload to try again.
              </span>
            ) : (
              addOptions.length > 0 && (
                <select
                  className={styles.addPlant}
                  aria-label={`Add a plant to ${row.sku}`}
                  value=""
                  disabled={assignMutation.isPending}
                  onChange={(e) => {
                    const nodeId = e.target.value;
                    // Reset to the placeholder immediately — the control is a
                    // one-shot action, not a value the row remembers.
                    e.target.value = "";
                    addPlant(row, nodeId);
                  }}
                >
                  <option value="">Add a plant…</option>
                  {addOptions.map((o) => (
                    <option key={o.value} value={o.value}>
                      {indentedLabel(o)}
                    </option>
                  ))}
                </select>
              )
            ))}
        </span>

        <span className={styles.actions}>
          {isEditing ? (
            <>
              <button type="button" className={styles.primary} onClick={() => saveEdit(row)}>
                Save
              </button>
              <button type="button" className={styles.quiet} onClick={() => setEditingId(null)}>
                Cancel
              </button>
            </>
          ) : (
            editable && (
              <>
                {/* ⭐ DEACTIVATE FIRST AND DELETE SECOND: anything ever scheduled
                    can never be fully deleted, so retire is the main action. */}
                <button type="button" className={styles.primary} onClick={() => toggleActive(row)}>
                  {row.active ? "Deactivate" : "Reactivate"}
                </button>
                {/* ⭐ D115: THE EDIT IS RENAME/RE-SKU ONLY now — places have their
                    own controls above. The label names what it does. */}
                <button
                  type="button"
                  className={styles.quiet}
                  title="Change its code or name"
                  onClick={() => beginEdit(row)}
                >
                  Edit
                </button>
                <button
                  type="button"
                  className={styles.quiet}
                  disabled={isConfirming}
                  onClick={() => {
                    clearRowError(row.id);
                    setRowNotice(null);
                    setConfirmingId(row.id);
                  }}
                >
                  Delete
                </button>
              </>
            )
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
        {notice !== null && <span className={styles.note}>{notice}</span>}
        {isConfirming && (
          <DeleteDialog
            kind="product"
            id={row.id}
            name={row.name}
            alreadyInactive={!row.active}
            onDeactivate={() => {
              setConfirmingId(null);
              toggleActive(row);
            }}
            onCancel={() => setConfirmingId(null)}
            onDeleted={(message) => {
              setConfirmingId(null);
              setRowNotice({ id: row.id, message });
            }}
            onFailed={(message) => {
              setConfirmingId(null);
              setRowError({ id: row.id, message });
            }}
          />
        )}
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
      {/* ⭐ D115 / THE SPLIT: CREATING A PART IS A COMPANY-ADMIN ACT — it makes
          the company-wide record. A site admin does not create parts; they opt
          their plant into parts the company has defined (the add picker on each
          row). So the whole card is company-admin-only. */}
      {isCompanyAdmin && (
        <section className={styles.card}>
          <h2 className={styles.h2}>Add a product</h2>
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
            <button type="button" className={styles.primary} onClick={submitNew}>
              Add
            </button>
          </div>
          {formError !== null && <p className={styles.error}>{formError}</p>}
          {/* ⭐ D115: A NEW PART IS OFFERED NOWHERE UNTIL A PLANT IS ADDED, and
              that is an ordinary state. The plant it is made in is chosen per
              row, in the catalogue below, not on this form. */}
          <p className={styles.hint}>
            A new part isn&rsquo;t made anywhere yet — add it to a plant from its row below. Its
            colour is chosen for it automatically; click a swatch in the list to set it by hand.
          </p>
        </section>
      )}

      <section className={styles.card}>
        <h2 className={styles.h2}>Catalogue</h2>
        {!isCompanyAdmin && (
          <p className={styles.status}>
            Only a company admin can add or rename a part number. You can add or remove your own
            plant on any part below.
          </p>
        )}
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

        {/* ⭐ COUNT WHAT YOU HIDE — `scope.ts`'s rule. Naming the plant, never the
            word "plant" (the hierarchy is user-defined). */}
        {hiddenByPlant > 0 && (
          <p className={styles.skippedLine}>
            {hiddenByPlant === 1
              ? `1 product outside ${plant.label} isn't listed.`
              : `${hiddenByPlant} products outside ${plant.label} aren't listed.`}{" "}
            Switch to &ldquo;All plants&rdquo; above to see everything.
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
              <span>Made in</span>
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
