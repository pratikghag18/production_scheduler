/* ---------------------------------------------------------------------------
   Import — the admin section that picks WHAT to import and hands off to the
   generic wizard.

   ⭐ `IMPORT_PANEL_READY` LIVES HERE (§19.62): turning the section on is a
   one-line edit to this file, and Group H in `scaleAudit.test.ts` asserts every
   rail id has a panel.

   TAKES NO PROPS and DECIDES NOTHING. Each entity (products, people) is a thin
   container that feeds the entity-agnostic `ImportWizard`; this file only chooses
   between them. The wizard chrome — choose a file, template, map, preview, apply
   — is written once (`ImportWizard.tsx`), not per entity.
   --------------------------------------------------------------------------- */
import { useState } from "react";
import { ProductsImport } from "./ProductsImport";
import { OperatorsImport } from "./OperatorsImport";
import styles from "./ImportPanel.module.css";

/** Flip to `true` in the same commit that gives this panel a real body. */
export const IMPORT_PANEL_READY = true;

type ImportEntity = "products" | "operators";

const TABS: { key: ImportEntity; label: string }[] = [
  { key: "products", label: "Products" },
  { key: "operators", label: "People" },
];

export function ImportPanel() {
  const [entity, setEntity] = useState<ImportEntity>("products");

  return (
    <div className={styles.panel}>
      <div className={styles.entityTabs} role="tablist" aria-label="What to import">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={entity === t.key}
            className={
              entity === t.key ? `${styles.entityTab} ${styles.entityTabOn}` : styles.entityTab
            }
            onClick={() => setEntity(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>
      {entity === "products" ? <ProductsImport /> : <OperatorsImport />}
    </div>
  );
}
