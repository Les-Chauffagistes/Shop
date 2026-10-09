import { afterAll, beforeEach } from "vitest";
import { prisma, resetDatabase } from "./db";

beforeEach(resetDatabase);
afterAll(() => prisma.$disconnect());
