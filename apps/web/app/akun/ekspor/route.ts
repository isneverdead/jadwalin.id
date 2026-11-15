import { exportMyData } from "@jadwalin/core";
import { currentUser, getPool } from "@/lib/server";

export const dynamic = "force-dynamic";

export async function GET() {
  const user = await currentUser();
  if (!user) return new Response("Unauthorized", { status: 401 });
  const data = await exportMyData(getPool(), user.id);
  return new Response(JSON.stringify(data, null, 2), {
    headers: { "content-type": "application/json; charset=utf-8", "content-disposition": 'attachment; filename="data-saya-jadwalin.json"', "cache-control": "no-store" },
  });
}
