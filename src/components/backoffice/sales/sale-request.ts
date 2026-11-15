import type { addressPayload } from "@/components/shop/AddressFields";
import { chosenValues, type OfferedMenu } from "@/components/shop/OptionMenus";
import { sumCents } from "@/components/shop/format";

/**
 * Corps de `POST /api/backoffice/manual-sales` à partir de la saisie de l'écran « Vente manuelle » (docs/api.md). Aucune
 * règle ici : prix, stock, blocages et machines sont tranchés par le serveur ; on ne fait que mettre en forme.
 */

/** Moyen d'encaissement hors chaîne (`means`) */
export type Means = "cash" | "bank_transfer" | "other";

/** Valeur choisie par menu, pour une machine (identifiant du menu → identifiant de la valeur) */
export type Selection = Record<string, string>;

/**
 * Une ligne par machine : la même configuration pour toutes (`perMachine` faux, celle de la machine 1), ou celle de
 * chaque machine. Un menu sans choix valable reçoit la valeur par défaut (chosenValues), comme sur la boutique.
 */
export function saleLines(options: OfferedMenu[], selections: Selection[], count: number, perMachine: boolean) {
  return Array.from({ length: count }, (_, i) => {
    const selection = (perMachine ? selections[i] : selections[0]) ?? {};
    const choices = chosenValues(options, selection).flatMap(({ menu, value }) =>
      value ? [{ optionId: menu.id, optionValueId: value.id }] : [],
    );
    return choices.length > 0 ? { choices } : {};
  });
}

/** Total indicatif (centimes) : prix de la machine nue plus les options de chaque machine. Le serveur relit les prix. */
export function indicativeTotal(basePrice: string, options: OfferedMenu[], selections: Selection[], count: number, perMachine: boolean) {
  return sumCents(
    Array.from({ length: count }, (_, i) => {
      const selection = (perMachine ? selections[i] : selections[0]) ?? {};
      return sumCents([basePrice, ...chosenValues(options, selection).map((c) => c.value?.price ?? "0")]);
    }),
  );
}

/** Adresse de la vente : `{ addressId }` d'une adresse du client, ou les champs saisis (enregistrés sur le client). */
export type SaleAddress = ReturnType<typeof addressPayload>;

export function saleBody(input: {
  userId: string;
  batchId: string;
  lines: ReturnType<typeof saleLines>;
  /** Machine choisie par ligne (`null` : choix automatique) ; aucune choisie : champ omis (choix d'office sur un lot de stock) */
  machineIds: (string | null)[];
  billing: SaleAddress;
  /** `null` : livraison à l'adresse de facturation */
  shipping: SaleAddress | null;
  means: Means;
  reference: string;
  reason: string;
}) {
  const reference = input.reference.trim();
  const reason = input.reason.trim();
  const machineIds = input.machineIds.slice(0, input.lines.length);
  const picked = machineIds.some((id) => id !== null);
  return {
    userId: input.userId,
    batchId: input.batchId,
    lines: input.lines,
    ...(picked ? { machineIds: input.lines.map((_, i) => machineIds[i] ?? null) } : {}),
    billingAddress: input.billing,
    ...(input.shipping ? { shippingAddress: input.shipping } : {}),
    means: input.means,
    ...(reference ? { reference } : {}),
    // Vide : le serveur trace « Vente au comptoir »
    ...(reason ? { reason } : {}),
  };
}

export type SaleBody = ReturnType<typeof saleBody>;
