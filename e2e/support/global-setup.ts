import { execSync } from "node:child_process";
import { Client } from "pg";
import { E2E_DATABASE_URL } from "./env";

/**
 * Recrée la base des parcours (données du lancement précédent effacées : une migration peut refuser
 * explicitement des données qu'elle ne sait pas reprendre), applique les migrations et le seed.
 * env.ts garantit que l'URL désigne une base *_e2e.
 */
export default async function globalSetup() {
  const url = new URL(E2E_DATABASE_URL);
  const database = url.pathname.slice(1);
  const admin = new URL(E2E_DATABASE_URL);
  admin.pathname = "/postgres";
  const client = new Client({ connectionString: admin.toString() });
  await client.connect();
  try {
    const quoted = `"${database.replace(/"/g, "")}"`;
    await client.query(`DROP DATABASE IF EXISTS ${quoted} WITH (FORCE)`);
    await client.query(`CREATE DATABASE ${quoted}`);
  } finally {
    await client.end();
  }
  const env = { ...process.env, DATABASE_URL: E2E_DATABASE_URL };
  execSync("npx prisma migrate deploy", { stdio: "inherit", env });
  execSync("npx prisma db seed", { stdio: "inherit", env });
}
