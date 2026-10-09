import { afterEach, describe, expect, it, vi } from "vitest";
import { eurCentsToSats, SimulatedPaymentService, simulatedAddress } from "@/server/payment-service";

describe("eurCentsToSats", () => {
  it("convertit au taux figé, arrondi au sat supérieur (jamais moins que le prix)", () => {
    // 1 BTC = 90 000,00 € ; 500,00 € = 0,00555… BTC
    expect(eurCentsToSats(50_000n, 9_000_000n)).toBe(555_556n);
    expect(eurCentsToSats(9_000_000n, 9_000_000n)).toBe(100_000_000n);
    expect(eurCentsToSats(0n, 9_000_000n)).toBe(0n);
    expect(eurCentsToSats(1n, 9_000_000n)).toBe(12n);
  });

  it("reste exact sur de grands montants (bigint, pas de virgule flottante)", () => {
    expect(eurCentsToSats(10_000_000_000_000n, 3n)).toBe(333_333_333_333_333_333_334n);
  });

  it("refuse un taux nul ou un montant négatif", () => {
    expect(() => eurCentsToSats(1n, 0n)).toThrow(RangeError);
    expect(() => eurCentsToSats(-1n, 1n)).toThrow(RangeError);
  });
});

describe("simulatedAddress", () => {
  it("adresse de réseau de test bech32, 44 caractères", () => {
    const address = simulatedAddress(new Uint8Array(38).fill(255));
    expect(address).toMatch(/^bcrt1q[qpzry9x8gf2tvdw0s3jn54khce6mua7l]{38}$/);
  });
});

describe("SimulatedPaymentService", () => {
  afterEach(() => vi.restoreAllMocks());

  it("une adresse différente par facture et le montant attendu au taux configuré", async () => {
    const service = new SimulatedPaymentService({ btcPriceEurCents: 9_000_000n, refundNetworkFeeSats: 1_500n });
    const addresses = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const invoice = await service.requestInvoice({ orderId: `o${i}`, amountCents: 50_000n });
      expect(invoice.expectedSats).toBe(555_556n);
      addresses.add(invoice.address);
    }
    expect(addresses.size).toBe(200);
    expect(await service.estimateRefundNetworkFeeSats()).toBe(1_500n);
  });
});
