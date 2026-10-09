import { requireBackoffice } from "@/server/auth";
import { getAdminOrder } from "@/server/backoffice-orders";
import { withErrorHandling } from "@/server/errors";
import { json, pathId } from "@/server/http";
import { orderNotFound } from "@/server/orders";

type Context = { params: Promise<{ orderId: string }> };

export const GET = withErrorHandling(async (_request: Request, { params }: Context) => {
  await requireBackoffice();
  return json(await getAdminOrder(await pathId(params, "orderId", orderNotFound())));
});
