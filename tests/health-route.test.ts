import { expect, it, vi } from "vitest";
import { GET } from "@/app/api/health/route";

it("provides container liveness without reading or disclosing private environment configuration", async () => {
  vi.stubEnv("CONFIG_ENCRYPTION_KEY", "private-health-fixture");
  vi.stubEnv("SUPABASE_SECRET_KEY", "private-database-fixture");
  try {
    const response = GET();
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({ status: "ok" });
  } finally { vi.unstubAllEnvs(); }
});
