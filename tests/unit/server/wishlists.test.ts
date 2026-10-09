import { describe, expect, it } from "vitest";
import {
  checkWishlistCreation,
  currentResalePrice,
  wishlistCancelBlocker,
  wishlistCap,
  wishlistEditBlocker,
  wishlistInput,
} from "@/server/wishlists";

describe("wishlistCap", () => {
  it("prend le plus petit du plafond configuré et de la quantité du lot", () => {
    expect(wishlistCap(5, 10)).toBe(5);
    expect(wishlistCap(5, 2)).toBe(2);
  });
});

describe("checkWishlistCreation", () => {
  it("accepte au sondage sous le plafond, plafond atteint exactement compris", () => {
    expect(checkWishlistCreation("survey", { active: 0, requested: 1, cap: 5 })).toBeNull();
    expect(checkWishlistCreation("survey", { active: 3, requested: 2, cap: 5 })).toBeNull();
  });

  it.each(["draft", "preorder", "ordering", "closed", "cancelled"] as const)("refuse hors sondage (%s)", (status) => {
    expect(checkWishlistCreation(status, { active: 0, requested: 1, cap: 5 })).toMatchObject({
      status: 409,
      code: "wishlist_closed",
    });
  });

  it("refuse au-delà du plafond en disant ce qui reste possible", () => {
    const over = checkWishlistCreation("survey", {
      active: 3,
      requested: 3,
      cap: 5,
    });
    expect(over).toMatchObject({ status: 409, code: "wishlist_limit_reached" });
    expect(over?.message).toContain("il ne vous reste que 2 machines");
    expect(checkWishlistCreation("survey", { active: 5, requested: 1, cap: 5 })?.message).toContain(
      "le maximum par personne (5)",
    );
  });
});

describe("wishlistEditBlocker", () => {
  it("configuration modifiable seulement au sondage", () => {
    expect(wishlistEditBlocker("survey", false)).toBeNull();
  });

  it.each([
    "draft",
    "preorder",
    "ordering",
    "awaiting_reception",
    "inspection",
    "tuning",
    "packaging",
    "in_transit",
    "closed",
    "cancelled",
  ] as const)("refuse au statut %s", (status) => {
    expect(wishlistEditBlocker(status, false)).toMatchObject({
      status: 409,
      code: "wishlist_not_editable",
    });
  });

  it("dès la précommande : message qui nomme le statut et rappelle que le retrait reste possible", () => {
    expect(wishlistEditBlocker("preorder", false)?.message).toBe(
      "Le sondage de ce lot est terminé (statut « Précommande ») : la configuration de votre manifestation d'intérêt ne se modifie plus. Vous pouvez encore la retirer.",
    );
    expect(wishlistEditBlocker("draft", false)?.message).toContain("n'est plus publié");
    expect(wishlistEditBlocker("cancelled", false)?.message).toContain("annulé");
  });

  it("refuse une wishlist convertie en commande payée (motif prioritaire)", () => {
    expect(wishlistEditBlocker("preorder", true)).toMatchObject({
      status: 409,
      code: "wishlist_converted",
    });
    expect(wishlistEditBlocker("survey", true)).toMatchObject({
      status: 409,
      code: "wishlist_converted",
    });
  });
});

describe("wishlistCancelBlocker", () => {
  it("retrait permis tant que la wishlist n'est pas convertie", () => {
    expect(wishlistCancelBlocker(false)).toBeNull();
  });

  it("convertie en commande payée : 409, le message renvoie vers « Renoncer » sur la commande", () => {
    const refused = wishlistCancelBlocker(true);
    expect(refused).toMatchObject({ status: 409, code: "wishlist_converted" });
    expect(refused?.message).toBe(
      "Cette manifestation d'intérêt est devenue une commande payée : elle ne peut plus être retirée. Pour y renoncer, utilisez « Renoncer » sur la commande (tant que le lot est en précommande), sinon contactez-nous.",
    );
  });
});

describe("currentResalePrice", () => {
  it("prix actuel du lot tant que la configuration est modifiable", () => {
    expect(currentResalePrice(true, 52_000n)).toBe("52000");
  });

  it("null une fois la configuration figée, ou sans prix de revente", () => {
    expect(currentResalePrice(false, 52_000n)).toBeNull();
    expect(currentResalePrice(true, null)).toBeNull();
  });
});

describe("wishlistInput", () => {
  const batchId = "00000000-0000-4000-8000-000000000001";

  it("une machine sans choix par défaut", () => {
    expect(wishlistInput.parse({ batchId })).toEqual({
      batchId,
      choices: [],
      quantity: 1,
    });
  });

  it("refuse un prix envoyé par le client et les champs inconnus", () => {
    expect(() => wishlistInput.parse({ batchId, amount: "100" })).toThrow();
    expect(() =>
      wishlistInput.parse({
        batchId,
        choices: [{ optionId: batchId, optionValueId: batchId, unitPrice: "0" }],
      }),
    ).toThrow();
  });

  it("borne la quantité", () => {
    expect(() => wishlistInput.parse({ batchId, quantity: 0 })).toThrow();
    // Au-delà du plafond par personne, c'est le contrôle du plafond (message qui le cite) qui refuse
    expect(wishlistInput.parse({ batchId, quantity: 101 }).quantity).toBe(101);
    expect(() => wishlistInput.parse({ batchId, quantity: 10_001 })).toThrow();
    expect(() => wishlistInput.parse({ batchId, quantity: 1.5 })).toThrow();
  });
});
