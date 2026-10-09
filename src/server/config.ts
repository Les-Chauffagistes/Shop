import { z } from "zod";

/**
 * Identifiant d'un utilisateur du service d'auth : `users.id` (BigInt auto-incrémenté),
 * transmis en décimal dans le claim `sub` du JWT (voir ../auth-service back, src/v1/jwt.py).
 */
export const AUTH_USER_ID_PATTERN = /^[1-9][0-9]{0,18}$/;

const MIN_PRODUCTION_SECRET_LENGTH = 32;

/**
 * Service de paiement Bitcoin SIMULÉ (jalon 4, voir ./payment-service.ts) : prix d'un bitcoin en
 * centimes d'euro (taux figé) et frais réseau estimés d'un remboursement, en satoshis.
 */
const DEFAULT_BTC_PRICE_EUR_CENTS = 9_000_000n; // 90 000,00 €
const DEFAULT_REFUND_NETWORK_FEE_SATS = 2_000n;
const MAX_BTC_PRICE_EUR_CENTS = 100_000_000_000n; // 1 000 000 000,00 €
const MAX_NETWORK_FEE_SATS = 10_000_000n; // 0,1 BTC

/** Entier positif facultatif en chaîne (BIGINT), borné ; vide = défaut. */
const optionalBigint = (name: string, min: bigint, max: bigint) => {
  const message = `${name} doit être un entier compris entre ${min} et ${max}`;
  return z
    .string()
    .trim()
    .optional()
    .transform((v) => v || undefined)
    .pipe(
      z
        .string()
        .regex(/^[0-9]{1,18}$/, message)
        .transform(BigInt)
        .refine((v) => v >= min && v <= max, message)
        .optional(),
    );
};

/** URL publique par défaut hors production (`next dev`). */
const DEV_PUBLIC_URL = "http://localhost:3000";

const required = (name: string) =>
  z.string({ error: `${name} est requise` }).trim().min(1, `${name} est requise`);

const envSchema = z
  .object({
    NODE_ENV: z.string().optional(),
    DATABASE_URL: required("DATABASE_URL").regex(
      /^postgres(ql)?:\/\//,
      "DATABASE_URL doit être une URL postgresql://",
    ),
    // Secret HS256 partagé avec auth-service back (même valeur que son JWT_SECRET).
    JWT_SECRET: required("JWT_SECRET"),
    // Définie mais éventuellement vide : une liste vide signifie « personne n'a accès au backoffice ».
    BACKOFFICE_USER_IDS: z.string({ error: "BACKOFFICE_USER_IDS est requise (peut être vide)" }),
    AUTH_API_URL: required("AUTH_API_URL").pipe(z.url({ error: "AUTH_API_URL doit être une URL" })),
    AUTH_FRONT_URL: required("AUTH_FRONT_URL").pipe(z.url({ error: "AUTH_FRONT_URL doit être une URL" })),
    // URL publique de la boutique (retour après connexion). Jamais déduite de l'en-tête Host,
    // falsifiable : redirection ouverte. Facultative hors production (http://localhost:3000).
    PUBLIC_URL: z
      .string()
      .trim()
      .optional()
      .transform((v) => v || undefined)
      .pipe(z.url({ protocol: /^https?$/, error: "PUBLIC_URL doit être une URL http(s)" }).optional()),
    // Paiement simulé : prix d'un bitcoin en centimes d'euro, frais réseau d'un remboursement (sats).
    PAYMENT_BTC_PRICE_EUR_CENTS: optionalBigint("PAYMENT_BTC_PRICE_EUR_CENTS", 1n, MAX_BTC_PRICE_EUR_CENTS),
    PAYMENT_REFUND_NETWORK_FEE_SATS: optionalBigint("PAYMENT_REFUND_NETWORK_FEE_SATS", 0n, MAX_NETWORK_FEE_SATS),
    // Secret partagé avec le service de paiement (point d'entrée interne). Vide : point d'entrée fermé (404).
    PAYMENT_WEBHOOK_SECRET: z
      .string()
      .trim()
      .optional()
      .transform((v) => v || undefined),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV === "production" && !env.PUBLIC_URL) {
      ctx.addIssue({ code: "custom", path: ["PUBLIC_URL"], message: "PUBLIC_URL est requise en production" });
    }
    if (env.NODE_ENV === "production" && env.JWT_SECRET.length < MIN_PRODUCTION_SECRET_LENGTH) {
      ctx.addIssue({
        code: "custom",
        path: ["JWT_SECRET"],
        message: `JWT_SECRET doit faire au moins ${MIN_PRODUCTION_SECRET_LENGTH} caractères en production`,
      });
    }
    if (
      env.NODE_ENV === "production" &&
      env.PAYMENT_WEBHOOK_SECRET !== undefined &&
      env.PAYMENT_WEBHOOK_SECRET.length < MIN_PRODUCTION_SECRET_LENGTH
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["PAYMENT_WEBHOOK_SECRET"],
        message: `PAYMENT_WEBHOOK_SECRET doit faire au moins ${MIN_PRODUCTION_SECRET_LENGTH} caractères en production`,
      });
    }
    splitIds(env.BACKOFFICE_USER_IDS).forEach((id, index) => {
      if (!AUTH_USER_ID_PATTERN.test(id)) {
        ctx.addIssue({
          code: "custom",
          path: ["BACKOFFICE_USER_IDS"],
          message: `BACKOFFICE_USER_IDS : l'entrée n°${index + 1} n'est pas un identifiant du service d'auth (entier positif)`,
        });
      }
    });
  });

export type Config = {
  databaseUrl: string;
  jwtSecret: Uint8Array;
  backofficeUserIds: ReadonlySet<string>;
  authApiUrl: string;
  authFrontUrl: string;
  /** Origine publique de la boutique (sans chemin), ex. https://shop.example.com */
  publicOrigin: string;
  /** Paiement Bitcoin simulé : taux figé et frais réseau estimés (voir ./payment-service.ts) */
  payment: {
    /** Prix d'un bitcoin, centimes d'euro */
    btcPriceEurCents: bigint;
    /** Frais réseau estimés d'un remboursement, satoshis */
    refundNetworkFeeSats: bigint;
    /** Secret du point d'entrée interne de paiement ; null = point d'entrée fermé */
    webhookSecret: string | null;
  };
};

function splitIds(raw: string): string[] {
  return raw
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
}

/** Valide un environnement. Les messages d'erreur ne contiennent jamais les valeurs. */
export function parseConfig(env: Record<string, string | undefined>): Config {
  const result = envSchema.safeParse(env);
  if (!result.success) {
    const problems = result.error.issues.map((issue) => `- ${issue.message}`).join("\n");
    throw new Error(`Configuration invalide :\n${problems}`);
  }
  const parsed = result.data;
  return {
    databaseUrl: parsed.DATABASE_URL,
    jwtSecret: new TextEncoder().encode(parsed.JWT_SECRET),
    backofficeUserIds: new Set(splitIds(parsed.BACKOFFICE_USER_IDS)),
    authApiUrl: parsed.AUTH_API_URL.replace(/\/$/, ""),
    authFrontUrl: parsed.AUTH_FRONT_URL.replace(/\/$/, ""),
    publicOrigin: new URL(parsed.PUBLIC_URL ?? DEV_PUBLIC_URL).origin,
    payment: {
      btcPriceEurCents: parsed.PAYMENT_BTC_PRICE_EUR_CENTS ?? DEFAULT_BTC_PRICE_EUR_CENTS,
      refundNetworkFeeSats: parsed.PAYMENT_REFUND_NETWORK_FEE_SATS ?? DEFAULT_REFUND_NETWORK_FEE_SATS,
      webhookSecret: parsed.PAYMENT_WEBHOOK_SECRET ?? null,
    },
  };
}

let cached: Config | undefined;

/** Configuration du processus, validée au premier appel (voir src/instrumentation.ts). */
export function getConfig(): Config {
  cached ??= parseConfig(process.env);
  return cached;
}
