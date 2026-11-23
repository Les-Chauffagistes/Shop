import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/server/errors";
import { eurCentsToSats, HttpPaymentService, SimulatedPaymentService, simulatedAddress } from "@/server/payment-service";

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

describe("HttpPaymentService", () => {
  const service = { url: "http://bitcoin:8086", token: "tok" };
  const make = (fetchImpl: typeof fetch) => new HttpPaymentService(service, { refundNetworkFeeSats: 1_500n }, fetchImpl);
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

  afterEach(() => vi.restoreAllMocks());

  it("demande une adresse : corps, clé d'API, sats en bigint", async () => {
    const fetchMock = vi.fn(async () => json(201, { address: "tb1qabc", expectedSats: "1194445", btcPriceEurCents: "9000000" }));
    const invoice = await make(fetchMock as unknown as typeof fetch).requestInvoice({ orderId: "o-1", amountCents: 119_000n });
    expect(invoice).toEqual({ address: "tb1qabc", expectedSats: 1_194_445n });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://bitcoin:8086/v1/invoices");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ orderId: "o-1", amountCents: "119000" });
    expect((init.headers as Record<string, string>)["X-Api-Key"]).toBe("tok");
  });

  it.each([
    ["503 price_unavailable", async () => json(503, { error: "price_unavailable" })],
    ["409 invoice_conflict", async () => json(409, { error: "invoice_conflict" })],
    ["401", async () => json(401, {})],
    ["réseau coupé", async () => Promise.reject(new TypeError("fetch failed"))],
    ["délai dépassé", async () => Promise.reject(new DOMException("timeout", "TimeoutError"))],
    ["réponse sans adresse", async () => json(201, { expectedSats: "1" })],
    ["sats non entiers", async () => json(201, { address: "tb1q", expectedSats: "1.5" })],
  ])("%s : 503 payment_unavailable, sans relance", async (_name, impl) => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchMock = vi.fn(impl);
    const error = await make(fetchMock as unknown as typeof fetch)
      .requestInvoice({ orderId: "o", amountCents: 1n })
      .catch((e) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 503, code: "payment_unavailable" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("n'écrit jamais le jeton dans les logs", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    await make((async () => json(503, {})) as unknown as typeof fetch).requestInvoice({ orderId: "o", amountCents: 1n }).catch(() => {});
    expect(JSON.stringify(spy.mock.calls)).not.toContain("tok");
  });

  it("estime les frais de remboursement, repli sur la configuration si le service est indisponible", async () => {
    expect(await make((async () => json(200, { refundNetworkFeeSats: "2000" })) as unknown as typeof fetch).estimateRefundNetworkFeeSats()).toBe(2_000n);
    expect(await make((async () => json(503, {})) as unknown as typeof fetch).estimateRefundNetworkFeeSats()).toBe(1_500n);
    expect(await make((async () => Promise.reject(new Error("x"))) as unknown as typeof fetch).estimateRefundNetworkFeeSats()).toBe(1_500n);
    expect(await make((async () => json(200, { refundNetworkFeeSats: "abc" })) as unknown as typeof fetch).estimateRefundNetworkFeeSats()).toBe(1_500n);
  });
});
