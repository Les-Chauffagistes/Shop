import { describe, expect, it } from "vitest";
import { outcomeSentence } from "@/components/backoffice/machines/outcome-sentence";

const refund = { lineId: "l1", orderId: "o1", paidAt: null, contactEmail: "a@x.fr", amount: "100000" };

describe("outcomeSentence", () => {
  it("rien à signaler : phrase vide", () => {
    expect(outcomeSentence({ refunds: [], cancelledOrders: [] })).toBe("");
    expect(outcomeSentence(null)).toBe("");
    expect(outcomeSentence({})).toBe("");
  });

  it("remboursements, puis factures en attente annulées (singulier et pluriel)", () => {
    expect(outcomeSentence({ refunds: [refund] })).toContain("Une commande payée en trop a été remboursée");
    expect(outcomeSentence({ refunds: [refund, refund] })).toContain("2 commandes payées en trop ont été remboursées");
    expect(outcomeSentence({ cancelledOrders: [{ orderId: "o2", cause: "admin" }] })).toBe(" Une facture en attente a été annulée pour libérer sa place.");
    expect(outcomeSentence({ refunds: [refund], cancelledOrders: [{ orderId: "o2", cause: "admin" }, { orderId: "o3", cause: "admin" }] })).toMatch(
      /remboursée.* 2 factures en attente ont été annulées/,
    );
  });
});
