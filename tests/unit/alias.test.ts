import { expect, it } from "vitest";

it("résout l'alias @/ vers src/ comme dans tsconfig", async () => {
  await expect(import("@/app/globals.css")).resolves.toBeDefined();
});
