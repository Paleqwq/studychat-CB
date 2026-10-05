export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Container liveness only; credentials and external services stay private.
export function GET() {
  return Response.json({ status: "ok" }, { headers: { "Cache-Control": "no-store" } });
}
