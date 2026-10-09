import type { NextRequest } from "next/server";
import { requireBackoffice } from "@/server/auth";
import { batchInput, batchListQuery, createBatch, listBatches } from "@/server/batches";
import { withErrorHandling } from "@/server/errors";
import { json, readJson } from "@/server/http";

export const GET = withErrorHandling(async (request: NextRequest) => {
  await requireBackoffice();
  const query = batchListQuery.parse(Object.fromEntries(request.nextUrl.searchParams));
  return json(await listBatches(query));
});

export const POST = withErrorHandling(async (request: NextRequest) => {
  const user = await requireBackoffice();
  return json(await createBatch(await readJson(request, batchInput), user), 201);
});
