/**
 * React Query hooks over the product wrappers in `src/lib/api/products.ts`
 * (migration 0023, D102), for `ProductsPanel`.
 *
 * Modelled on `useSiteAccess.ts` exactly: a `useMutation<TResult,
 * SchedulerError, TVars>` per write, `onSuccess` invalidates the query key,
 * and deliberately NO optimistic updates.
 *
 * ⭐ WHY NO OPTIMISTIC UPDATE HERE IN PARTICULAR. `useHierarchyMutations.ts`'s
 * header gives the general reason (reproducing the server's answer client-side
 * is the duplicated logic it forbids), and products add a sharper one: the
 * BEFORE INSERT trigger `products_set_color_token` picks the colour, and
 * `app_pick_product_color()` — the function that decides which — is granted to
 * NOBODY, so this client cannot compute the answer even in principle. An
 * optimistic row would have to invent a colour and then watch it change. The
 * refetch is the only honest source.
 *
 * ONE KEY for the whole section, and every write invalidates all of it.
 * Deactivating a product does not change any other row, but creating one
 * changes which colours are left in its owner's palette — so a per-row key
 * would be a cache that is right about the row and wrong about the list.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createProduct,
  deleteProduct,
  fetchAdminProducts,
  setProductActive,
  setProductColor,
  updateProduct,
  type AdminProduct,
  type CreateProductInput,
  type SchedulerError,
  type SetProductActiveInput,
  type SetProductColorInput,
  type UpdateProductInput,
} from "@/lib/api";

export const productKeys = {
  all: ["admin-products"] as const,
};

/**
 * The catalogue.
 *
 * `enabled` is REQUIRED, not defaulted — the same rule `useHierarchyTree` and
 * `useBoardWindow` follow. `products_select` is RLS-scoped to the caller's
 * org, so a read fired before the session resolves can only be a 401 (D91 /
 * `canQueryAsUser`).
 *
 * Resolves to `(AdminProduct | null)[]` with the nulls INTACT: the skipping
 * and counting is `productRows()` in the pure module, which is where a unit
 * test can reach it. See `fetchAdminProducts`.
 */
export function useAdminProducts(enabled: boolean) {
  return useQuery<ReadonlyArray<AdminProduct | null>, SchedulerError>({
    queryKey: productKeys.all,
    queryFn: fetchAdminProducts,
    enabled,
  });
}

/** `insert into products` — `org_id` has no default, so the caller supplies it. */
export function useCreateProduct() {
  const queryClient = useQueryClient();

  return useMutation<AdminProduct, SchedulerError, CreateProductInput>({
    mutationFn: (input) => createProduct(input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: productKeys.all });
    },
  });
}

/** Rename / re-sku. Owner and colour are untouched — see `updateProduct`. */
export function useUpdateProduct() {
  const queryClient = useQueryClient();

  return useMutation<AdminProduct, SchedulerError, UpdateProductInput>({
    mutationFn: (input) => updateProduct(input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: productKeys.all });
    },
  });
}

/**
 * Set one product's colour by hand.
 *
 * Its own mutation rather than a field on the rename, because it is its own
 * control with its own refusal — see `setProductColor`'s header. The automatic
 * pick at creation is untouched; this only ever overrides one row.
 */
export function useSetProductColor() {
  const queryClient = useQueryClient();

  return useMutation<AdminProduct, SchedulerError, SetProductColorInput>({
    mutationFn: (input) => setProductColor(input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: productKeys.all });
      // ⭐ The BOARD draws from this column too (0023 §3 put `color_token` in
      // `board_window`), so a colour change that only refreshed the admin list
      // would leave the board showing the old swatch until something else
      // happened to invalidate it.
      void queryClient.invalidateQueries({ queryKey: ["board"] });
    },
  });
}

/** The main action: retire a product, or bring it back. */
export function useSetProductActive() {
  const queryClient = useQueryClient();

  return useMutation<AdminProduct, SchedulerError, SetProductActiveInput>({
    mutationFn: (input) => setProductActive(input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: productKeys.all });
    },
  });
}

/**
 * The secondary action. Fails with `StillInUse` for anything that has ever
 * been scheduled, which is most of what anyone will try to delete — the panel
 * turns that into "deactivate it instead" rather than into a retry.
 */
export function useDeleteProduct() {
  const queryClient = useQueryClient();

  return useMutation<void, SchedulerError, string>({
    mutationFn: (id) => deleteProduct(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: productKeys.all });
    },
  });
}
