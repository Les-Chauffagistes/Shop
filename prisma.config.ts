import { defineConfig } from "prisma/config";

// DATABASE_URL est fourni par l'environnement (variable ou secret Swarm), jamais committé.
export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
    seed: "tsx prisma/seed.ts",
  },
  datasource: {
    url: process.env.DATABASE_URL ?? "",
  },
});
