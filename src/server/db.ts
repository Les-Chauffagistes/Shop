import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../../prisma/generated/client";
import { getConfig } from "./config";

// Un seul client par processus. Conservé sur globalThis pour survivre au rechargement
// des modules de `next dev` (sinon chaque modification ouvrirait un nouveau pool).
const globalForPrisma = globalThis as typeof globalThis & { prisma?: PrismaClient };

/**
 * Client Prisma partagé, créé au premier appel (et non à l'import : `next build` charge
 * les modules de route sans base ni variables d'environnement).
 */
export function getDb(): PrismaClient {
  globalForPrisma.prisma ??= new PrismaClient({
    adapter: new PrismaPg({
      connectionString: getConfig().databaseUrl,
      // Sans délai, une base injoignable bloque la requête indéfiniment.
      connectionTimeoutMillis: 5_000,
    }),
  });
  return globalForPrisma.prisma;
}
