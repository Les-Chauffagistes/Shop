import { describe, expect, it } from "vitest";
import { parseConfig } from "@/server/config";

const valid = {
  DATABASE_URL: "postgresql://u:p@localhost:5432/shop",
  JWT_SECRET: "dev-secret",
  BACKOFFICE_USER_IDS: " 12, 7 ,,",
  AUTH_API_URL: "http://localhost:8080/",
  AUTH_FRONT_URL: "http://localhost:3005",
};

describe("parseConfig", () => {
  it("lit et normalise une configuration valide", () => {
    const config = parseConfig(valid);
    expect(config.databaseUrl).toBe(valid.DATABASE_URL);
    expect([...config.backofficeUserIds]).toEqual(["12", "7"]);
    expect(config.authApiUrl).toBe("http://localhost:8080");
    expect(new TextDecoder().decode(config.jwtSecret)).toBe("dev-secret");
  });

  it("accepte une whitelist vide (personne n'a accès au backoffice)", () => {
    expect(parseConfig({ ...valid, BACKOFFICE_USER_IDS: "" }).backofficeUserIds.size).toBe(0);
  });

  it.each(["DATABASE_URL", "JWT_SECRET", "BACKOFFICE_USER_IDS", "AUTH_API_URL", "AUTH_FRONT_URL"])(
    "refuse l'absence de %s en la nommant",
    (name) => {
      const env: Record<string, string | undefined> = { ...valid, [name]: undefined };
      expect(() => parseConfig(env)).toThrow(name);
    },
  );

  it("refuse un secret vide ou blanc", () => {
    expect(() => parseConfig({ ...valid, JWT_SECRET: "   " })).toThrow("JWT_SECRET");
  });

  it("exige un secret long en production", () => {
    expect(() => parseConfig({ ...valid, NODE_ENV: "production" })).toThrow("32 caractères");
    expect(() =>
      parseConfig({ ...valid, NODE_ENV: "production", JWT_SECRET: "x".repeat(32), PUBLIC_URL: "https://shop.example.com" }),
    ).not.toThrow();
  });

  it("lit le paiement simulé : taux, frais réseau (défauts), secret facultatif", () => {
    expect(parseConfig(valid).payment).toEqual({ btcPriceEurCents: 9_000_000n, refundNetworkFeeSats: 2_000n, webhookSecret: null });
    const custom = parseConfig({
      ...valid,
      PAYMENT_BTC_PRICE_EUR_CENTS: " 6000000 ",
      PAYMENT_REFUND_NETWORK_FEE_SATS: "0",
      PAYMENT_WEBHOOK_SECRET: "s3cret",
    }).payment;
    expect(custom).toEqual({ btcPriceEurCents: 6_000_000n, refundNetworkFeeSats: 0n, webhookSecret: "s3cret" });
    for (const bad of ["0", "-1", "2.5", "abc", "100000000001"]) {
      expect(() => parseConfig({ ...valid, PAYMENT_BTC_PRICE_EUR_CENTS: bad })).toThrow("PAYMENT_BTC_PRICE_EUR_CENTS");
    }
    expect(() => parseConfig({ ...valid, PAYMENT_REFUND_NETWORK_FEE_SATS: "-5" })).toThrow("PAYMENT_REFUND_NETWORK_FEE_SATS");
  });

  it("exige un secret de paiement long en production, s'il est fourni", () => {
    const prod = { ...valid, NODE_ENV: "production", JWT_SECRET: "x".repeat(32), PUBLIC_URL: "https://shop.example.com" };
    expect(() => parseConfig({ ...prod, PAYMENT_WEBHOOK_SECRET: "court" })).toThrow("PAYMENT_WEBHOOK_SECRET");
    expect(parseConfig({ ...prod, PAYMENT_WEBHOOK_SECRET: "y".repeat(32) }).payment.webhookSecret).toBe("y".repeat(32));
    expect(parseConfig(prod).payment.webhookSecret).toBeNull();
  });

  it("lit l'URL publique (retour après connexion), exigée en production", () => {
    expect(parseConfig(valid).publicOrigin).toBe("http://localhost:3000");
    expect(parseConfig({ ...valid, PUBLIC_URL: "https://shop.example.com/" }).publicOrigin).toBe("https://shop.example.com");
    expect(() => parseConfig({ ...valid, PUBLIC_URL: "javascript:alert(1)" })).toThrow("PUBLIC_URL");
    expect(() => parseConfig({ ...valid, NODE_ENV: "production", JWT_SECRET: "x".repeat(32) })).toThrow("PUBLIC_URL");
  });

  it("refuse une URL de base qui n'est pas PostgreSQL", () => {
    expect(() => parseConfig({ ...valid, DATABASE_URL: "mysql://localhost/shop" })).toThrow("DATABASE_URL");
  });

  it.each(["abc", "0", "-3", "1.5", "5e1d0000-0000-4000-8000-000000000401"])(
    "refuse l'identifiant backoffice %s",
    (id) => {
      expect(() => parseConfig({ ...valid, BACKOFFICE_USER_IDS: `1,${id}` })).toThrow("BACKOFFICE_USER_IDS");
    },
  );

  it("n'affiche jamais les valeurs dans le message d'erreur", () => {
    const secretUrl = "mysql://admin:topsecret@db/shop";
    expect(() => parseConfig({ ...valid, DATABASE_URL: secretUrl, NODE_ENV: "production" })).toThrow(
      expect.objectContaining({ message: expect.not.stringContaining("topsecret") }),
    );
  });
});
