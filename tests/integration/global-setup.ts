import { execSync } from "node:child_process";
import { Client } from "pg";
import { TEST_DATABASE_URL } from "./env";

// Base de test repartie de zéro à chaque lancement (schéma public recréé), puis migrations Prisma.
// Les tests ne vident les tables qu'avant chaque test : sans cette remise à zéro, les données du
// lancement précédent pourraient faire échouer une migration qui refuse explicitement des données
// qu'elle ne sait pas reprendre (ex. v5 : facture impayée sans montant BTC attendu).
// env.ts garantit que l'URL désigne une base *_test.
export default async function setup() {
  const client = new Client({ connectionString: TEST_DATABASE_URL });
  await client.connect();
  try {
    await client.query('DROP SCHEMA IF EXISTS "public" CASCADE');
    await client.query('CREATE SCHEMA "public"');
  } finally {
    await client.end();
  }
  execSync("npx prisma migrate deploy", {
    stdio: "inherit",
    env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL },
  });
}
