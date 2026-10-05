import { afterEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ storageKeys: [] as string[] }));
vi.mock("@supabase/supabase-js", () => ({ createClient: (_url: string, _key: string, options: { auth: { storageKey: string } }) => {
  mocks.storageKeys.push(options.auth.storageKey);
  return { auth: {
    getSession: async () => ({ data: { session: null }, error: null }),
    signInAnonymously: async () => ({ data: { session: { access_token: options.auth.storageKey } }, error: null })
  } };
} }));
import { accessToken } from "@/lib/browser";
import { assertEnglishAccessCode } from "@/lib/server/english-access";
afterEach(() => vi.unstubAllEnvs());

describe("English browser identity and access-code isolation", () => {
  it("uses separate browser identities even when both courses sign in concurrently", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "test-key");
    const tokens = await Promise.all([accessToken("participant"), accessToken("english-participant")]);
    expect(tokens).toEqual(["studychat.participant.auth", "studychat.english-participant.auth"]);
    expect(mocks.storageKeys).toEqual(tokens);
  });
  it("uses only the independent English access code", () => {
    vi.stubEnv("STUDY_ACCESS_CODE", "bloom-access");
    vi.stubEnv("ENGLISH_ASSISTANT_ACCESS_CODE", "");
    expect(() => assertEnglishAccessCode(new Request("http://localhost"))).not.toThrow();
    vi.stubEnv("ENGLISH_ASSISTANT_ACCESS_CODE", "english-access");
    expect(() => assertEnglishAccessCode(new Request("http://localhost", { headers: { "x-study-code": "bloom-access" } }))).toThrow("英语助教访问码");
    expect(() => assertEnglishAccessCode(new Request("http://localhost", { headers: { "x-study-code": "english-access" } }))).not.toThrow();
  });
});
