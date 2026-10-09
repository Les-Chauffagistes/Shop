import { withErrorHandling } from "@/server/errors";
import { json } from "@/server/http";
import { listPublicBatches } from "@/server/shop";

/** Boutique publique, sans connexion : lots au sondage. */
export const GET = withErrorHandling(async () => json(await listPublicBatches()));
