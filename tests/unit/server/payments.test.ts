import { describe, expect, it, vi } from "vitest";

// Secret du point d'entrée interne : lu dans la configuration (simulée ici)
const secret = vi.hoisted(() => ({ value: null as string | null }));
vi.mock("@/server/config", () => ({ getConfig: () => ({ payment: { webhookSecret: secret.value } }) }));

const { requirePaymentService } = await import("@/server/payments");

const request = (authorization?: string) =>
  new Request("http://shop.test/api/internal/payments", {
    method: "POST",
    headers: authorization ? { authorization } : {},
  });

describe("requirePaymentService", () => {
  it("point d'entrée fermé sans secret configuré : 404, comme une route inexistante", () => {
    secret.value = null;
    expect(() => requirePaymentService(request("Bearer x"))).toThrow(expect.objectContaining({ status: 404 }));
  });

  it("secret absent ou faux : 401 ; bon secret : accepté", () => {
    secret.value = "le-secret-du-service";
    expect(() => requirePaymentService(request())).toThrow(expect.objectContaining({ status: 401 }));
    expect(() => requirePaymentService(request("Bearer autre"))).toThrow(expect.objectContaining({ status: 401 }));
    expect(() => requirePaymentService(request("le-secret-du-service"))).toThrow(expect.objectContaining({ status: 401 }));
    expect(() => requirePaymentService(request("Bearer le-secret-du-service"))).not.toThrow();
  });
});
