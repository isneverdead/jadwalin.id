export const dynamic = "force-dynamic";

/** Liveness untuk pemantau uptime: proses web hidup dan bisa menjawab. Tanpa dependensi apa pun (tak menyentuh DB). */
export function GET() {
  return Response.json({ status: "ok" }, { headers: { "Cache-Control": "no-store" } });
}
