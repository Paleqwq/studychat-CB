import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { assertSameOrigin } from "@/lib/server/http";

function localRequest(host: string, origin: string, extra: Record<string, string> = {}) {
  return new NextRequest("http://127.0.0.1:3001/api/admin/settings", {
    method: "PUT", headers: { Host: host, Origin: origin, ...extra }
  });
}

describe("same-origin protection with NextURL loopback normalization", () => {
  it.each(["127.0.0.1", "localhost", "[::1]", "127.0.0.2"])("accepts matching loopback Host and Origin for %s", hostname => {
    const request = localRequest(hostname + ":3001", "http://" + hostname + ":3001");
    expect(new URL(request.url).hostname).toBe("localhost");
    expect(() => assertSameOrigin(request)).not.toThrow();
  });
  it.each([
    "http://localhost:3001", "http://127.0.0.2:3001", "http://127.0.0.1:3002",
    "https://127.0.0.1:3001", "https://evil.example", "http://127.0.0.1.evil.example:3001",
    "null", "", "http://127.0.0.1:3001/", "http://127.0.0.1:3001 https://evil.example"
  ])("rejects a nonmatching or invalid origin: %s", origin => {
    expect(() => assertSameOrigin(localRequest("127.0.0.1:3001", origin))).toThrow("不允许跨站请求");
  });
  it.each([
    "evil.example:3001", "localhost.evil.example:3001", "localhost:3002", "127.0.0.1:99999",
    "127.999.0.1:3001", "127.0.0.1:3001@evil.example", "127.0.0.1:3001/path",
    "127.0.0.1:3001?test", "127.0.0.1:3001,evil.example", ""
  ])("does not accept a malformed, non-loopback or port-changing Host: %s", host => {
    expect(() => assertSameOrigin(localRequest(host, "http://localhost:3001"))).toThrow();
  });
  it("does not trust forwarded headers to authorize another origin", () => {
    expect(() => assertSameOrigin(localRequest("127.0.0.1:3001", "https://evil.example", {
      "X-Forwarded-Host": "evil.example", "X-Forwarded-Proto": "https", Forwarded: "host=evil.example;proto=https"
    }))).toThrow("不允许跨站请求");
  });
  it("preserves exact same-origin validation for public deployments", () => {
    expect(() => assertSameOrigin(new NextRequest("https://study.example/api/admin/settings", {
      headers: { Host: "study.example", Origin: "https://study.example" }
    }))).not.toThrow();
    expect(() => assertSameOrigin(new NextRequest("https://study.example/api/admin/settings", {
      headers: { Host: "evil.example", Origin: "https://evil.example", "X-Forwarded-Host": "evil.example" }
    }))).toThrow("不允许跨站请求");
    expect(() => assertSameOrigin(new NextRequest("https://study.example/api/admin/settings", {
      headers: { Host: "127.0.0.1", Origin: "https://127.0.0.1" }
    }))).toThrow("不允许跨站请求");
  });
  it("preserves authenticated non-browser clients without an Origin header", () => {
    expect(() => assertSameOrigin(new NextRequest("http://127.0.0.1:3001/api/admin/settings"))).not.toThrow();
  });
});
