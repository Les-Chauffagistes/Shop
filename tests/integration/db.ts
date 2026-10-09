import { getDb } from "@/server/db";

// Même client que l'application ; DATABASE_URL pointe sur la base de test (vitest.config.ts).
export const prisma = getDb();

/**
 * Vide toutes les tables du schéma public (sauf _prisma_migrations), puis remet la ligne de
 * réglages (ShopSettings, créée par la migration v5) à ses valeurs par défaut.
 */
export async function resetDatabase() {
  const tables = await prisma.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  if (tables.length === 0) return;
  const list = tables.map((t) => `"public"."${t.tablename}"`).join(", ");
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
  await prisma.$executeRaw`INSERT INTO "ShopSettings" DEFAULT VALUES`;
}
