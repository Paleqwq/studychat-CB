import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
// @ts-expect-error This small Node build script intentionally has no TypeScript declaration.
import { containerBuildEnvironment } from "../cloudbase/scripts/build-container.mjs";

const dirs: string[] = [];
async function fixture(config: unknown) {
  const dir = await mkdtemp(path.join(tmpdir(), "studychat-cb-public-build-")); dirs.push(dir);
  const file = path.join(dir, "public-build.json"); await writeFile(file, JSON.stringify(config)); return file;
}
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
const config = { NEXT_PUBLIC_DATA_BACKEND: "cloudbase", NEXT_PUBLIC_CLOUDBASE_ENV_ID: "cb-test-1",
  NEXT_PUBLIC_CLOUDBASE_REGION: "ap-shanghai", NEXT_PUBLIC_CLOUDBASE_PUBLISHABLE_KEY: "public-fixture" };
describe("CloudBase public configuration for source builds", () => {
  it("uses Docker build arguments when no staging config exists", async () => {
    expect(await containerBuildEnvironment(path.join(tmpdir(), "studychat-nonexistent-build-config"), config)).toEqual(config);
  });
  it("applies complete public config while preserving the build environment", async () => {
    expect(await containerBuildEnvironment(await fixture(config), { NODE_ENV: "production" }))
      .toEqual({ NODE_ENV: "production", ...config });
  });
  it.each(["CLOUDBASE_API_KEY", "CONFIG_ENCRYPTION_KEY", "NEXT_PUBLIC_SECRET_KEY"])
    ("refuses %s and never includes its value in the error", async name => {
      await expect(containerBuildEnvironment(await fixture({ ...config, [name]: "private-value-fixture" }), {}))
        .rejects.toThrow("only the four documented CloudBase public values");
    });
  it("rejects incomplete configuration before creating a wrong browser bundle", async () => {
    await expect(containerBuildEnvironment(await fixture({ ...config, NEXT_PUBLIC_CLOUDBASE_PUBLISHABLE_KEY: "" }), {}))
      .rejects.toThrow("incomplete or invalid");
  });
});
