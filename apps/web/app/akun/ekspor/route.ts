import { exportMyData } from "@jadwalin/core";
import { getAuth, getPool } from "@/lib/server";
import { headers } from "next/headers";

export const dynamic = "force-dynamic";

export async function GET() {
  const session = await getAuth().api.getSession({ headers: await headers() });
  if (!session) return new Response("Unauthorized", { status: 401 });
  const data = await exportMyData(getPool(), session.user.id);
  return new Response(JSON.stringify(data, null, 2), {
    headers: { "content-type": "application/json; charset=utf-8", "content-disposition": 'attachment; filename="data-saya-jadwalin.json"', "cache-control": "no-store" },
  });
}
