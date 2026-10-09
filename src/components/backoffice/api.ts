/**
 * Appels aux routes `/api/backoffice/**` depuis le navigateur (cookie `access_token` envoyé
 * automatiquement, même origine). Toute réponse d'erreur est convertie en `ApiFailure`
 * portant le message français de l'API, affichable tel quel (docs/api.md, « Erreurs »).
 */

export type ApiIssue = { path: string; message: string };

/** Élément qui empêche une suppression ou une modification (docs/api.md, « Erreurs »). */
export type ApiBlocker = { kind: "batch" | "option_value" | "part_order" | "stock_movement"; id: string; label: string };

export class ApiFailure extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly issues: ApiIssue[] = [],
    readonly blockers: ApiBlocker[] = [],
    /** Données structurées de certaines erreurs (dates ISO, sats en chaînes) : `docs/api.md`, « Erreurs » */
    readonly details: Record<string, unknown> | null = null,
  ) {
    super(message);
    this.name = "ApiFailure";
  }
}

const NETWORK_MESSAGE = "Le serveur ne répond pas. Vérifiez votre connexion puis réessayez.";
const UNEXPECTED_MESSAGE = "Réponse inattendue du serveur. Réessayez plus tard.";

export async function api<T = unknown>(method: "GET" | "POST" | "PATCH" | "DELETE", path: string, body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      method,
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: "no-store",
    });
  } catch {
    throw new ApiFailure(0, "network", NETWORK_MESSAGE);
  }
  const text = await response.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      throw new ApiFailure(response.status, "unexpected", UNEXPECTED_MESSAGE);
    }
  }
  if (!response.ok) {
    const error = (
      data as {
        error?: {
          code?: string;
          message?: string;
          issues?: ApiIssue[];
          blockers?: ApiBlocker[];
          details?: Record<string, unknown>;
        };
      } | null
    )?.error;
    if (response.status === 401) {
      throw new ApiFailure(401, "unauthenticated", "Votre session a expiré. Rechargez la page pour vous reconnecter.");
    }
    throw new ApiFailure(
      response.status,
      error?.code ?? "unexpected",
      error?.message ?? UNEXPECTED_MESSAGE,
      error?.issues ?? [],
      error?.blockers ?? [],
      error?.details ?? null,
    );
  }
  return data as T;
}

/** Chaîne d'un champ de `details` (identifiant, date ISO, sats), sinon null. */
export function detailOf(failure: ApiFailure | null, key: string): string | null {
  const value = failure?.details?.[key];
  return typeof value === "string" ? value : null;
}

/** Normalise une erreur quelconque (réseau, bug) en ApiFailure affichable. */
export function toFailure(error: unknown): ApiFailure {
  if (error instanceof ApiFailure) return error;
  return new ApiFailure(0, "unexpected", UNEXPECTED_MESSAGE);
}
