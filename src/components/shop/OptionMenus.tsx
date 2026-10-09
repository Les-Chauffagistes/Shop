"use client";

import type { getPublicBatch } from "@/server/shop";
import { formatCents } from "@/lib/decimal";

/** Menu d'options proposé par un lot (fiche produit publique, docs/api.md). */
export type OfferedMenu = Awaited<ReturnType<typeof getPublicBatch>>["options"][number];
export type OfferedValue = OfferedMenu["values"][number];

/** Valeur retenue par menu : le choix s'il est toujours proposé, sinon la valeur par défaut. */
export function chosenValues(options: OfferedMenu[], selected: Record<string, string>) {
  return options.map((menu) => ({
    menu,
    value: (menu.values.find((v) => v.id === selected[menu.id]) ??
      menu.values.find((v) => v.isDefault) ??
      menu.values[0]) as OfferedValue | undefined,
  }));
}

/** Sélection initiale (une valeur par menu au plus) d'après des identifiants de valeurs. */
export function selectionFrom(options: OfferedMenu[], valueIds: readonly string[]): Record<string, string> {
  const wanted = new Set(valueIds);
  return Object.fromEntries(
    options.flatMap((m) => {
      const v = m.values.find((value) => wanted.has(value.id));
      return v ? [[m.id, v.id]] : [];
    }),
  );
}

/**
 * Choix d'une valeur par menu (boutons radio natifs, sur toute la carte). `name` distingue les groupes
 * quand plusieurs machines sont configurées sur la même page.
 */
export function OptionMenus({
  options,
  selected,
  onSelect,
  name = "menu",
}: {
  options: OfferedMenu[];
  selected: Record<string, string>;
  onSelect: (menuId: string, valueId: string) => void;
  name?: string;
}) {
  if (options.length === 0) {
    return <p className="bo-muted">Ce lot est proposé sans option : la machine est livrée telle quelle.</p>;
  }
  return (
    <>
      {chosenValues(options, selected).map(({ menu, value }) => (
        <fieldset key={menu.id} className="shop-menu">
          <legend>{menu.title}</legend>
          {menu.description && <p className="bo-hint">{menu.description}</p>}
          <div className="shop-choices">
            {menu.values.map((v) => (
              <label key={v.id} className="shop-choice">
                <input
                  type="radio"
                  name={`${name}-${menu.id}`}
                  value={v.id}
                  checked={value?.id === v.id}
                  onChange={() => onSelect(menu.id, v.id)}
                />
                <span className="shop-choice-label">{v.label}</span>
                <span className="shop-choice-price bo-num">
                  {v.price === "0" ? "Sans supplément" : `+ ${formatCents(v.price)}`}
                </span>
                {v.maxQty !== null && <span className="shop-choice-note">Quantité limitée</span>}
              </label>
            ))}
          </div>
        </fieldset>
      ))}
    </>
  );
}
