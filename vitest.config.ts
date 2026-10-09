import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { integrationEnv } from "./tests/integration/env";

const alias = { "@": fileURLToPath(new URL("./src", import.meta.url)) };

// Deux projets : `npm run test:unit` et `npm run test:integration` (voir package.json).
export default defineConfig({
  test: {
    // `npm run test:coverage` : rapport dans coverage/ (ignoré par git)
    coverage: {
      provider: "v8",
      include: ["src/**/*.{ts,tsx}"],
      exclude: ["src/**/*.test.ts"],
      reporter: ["text-summary", "html"],
    },
    projects: [
      {
        resolve: { alias },
        test: {
          name: "unit",
          environment: "node",
          include: ["src/**/*.test.ts", "tests/unit/**/*.test.ts"],
        },
      },
      {
        resolve: { alias },
        test: {
          name: "integration",
          environment: "node",
          include: ["tests/integration/**/*.test.ts"],
          globalSetup: ["tests/integration/global-setup.ts"],
          setupFiles: ["tests/integration/setup.ts"],
          env: integrationEnv,
          // Une seule base partagée : pas de parallélisme entre fichiers.
          fileParallelism: false,
          testTimeout: 20_000,
          hookTimeout: 60_000,
        },
      },
    ],
  },
});
