import { beforeAll, beforeEach, afterAll, describe, it, expect } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { defaultSettings } from "@/lib/types";

let pg: PGlite;
const admin = "00000000-0000-4000-8000-000000000001";
const alice = "00000000-0000-4000-8000-000000000002";
const bob = "00000000-0000-4000-8000-000000000003";
async function scalar<T = any>(sql: string, params: unknown[] = []): Promise<T> {
  return (await pg.query<{ result: T }>(sql, params)).rows[0]?.result;
}
async function conversation(owner = alice) {
  return scalar("select to_jsonb(public.get_or_create_conversation($1::uuid)) as result", [owner]);
}
async function begin(id: string, turn = randomUUID(), owner = alice, content = "你好") {
  return scalar("select public.begin_turn($1::uuid,$2::uuid,$3::uuid,$4) as result", [id, owner, turn, content]);
}
async function save(id: string, turn: string, lease: string, status = "complete") {
  return scalar("select public.save_reply($1::uuid,$2::uuid,$3::uuid,'回复',$4,null) as result", [id, turn, lease, status]);
}

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec("create schema auth; create role anon; create role authenticated; create role service_role bypassrls; create table auth.users(id uuid primary key);");
  await pg.exec("create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$; grant usage on schema auth, public to authenticated, anon, service_role;");
  await pg.exec(await readFile(path.resolve("supabase/migrations/001_studychat.sql"), "utf8"));
  await pg.exec(await readFile(path.resolve("supabase/migrations/002_factorial_experiment.sql"), "utf8"));
  await pg.query("insert into auth.users(id) values($1),($2),($3)", [admin, alice, bob]);
  await pg.query("insert into public.admin_users(user_id) values($1)", [admin]);
}, 60000);
beforeEach(async () => {
  await pg.exec("reset role; truncate public.study_state,public.config_versions,public.conversations,public.messages,public.request_events restart identity cascade; insert into public.study_state(id) values(1);");
  await scalar("select public.publish_config($1::jsonb,'encrypted-test',$2::uuid,0,true) as result", [JSON.stringify(defaultSettings), admin]);
});
afterAll(async () => { await pg?.close(); });

describe("real PostgreSQL schema and transactional conversation lifecycle", () => {
  it("restores one conversation per identity and freezes its configuration", async () => {
    const first = await conversation();
    expect((await conversation()).id).toBe(first.id);
    const next = await scalar("select public.publish_config($1::jsonb,'new-encrypted',$2::uuid,1,true) as result", [JSON.stringify({ ...defaultSettings, system_prompt: "new prompt" }), admin]);
    expect((await conversation()).config_id).toBe(first.config_id);
    expect((await conversation(bob)).config_id).toBe(next.id);
  });
  it("atomically stores both turns and makes completed retries idempotent", async () => {
    const c = await conversation(); const turn = randomUUID();
    const started = await begin(c.id, turn);
    expect(started.state).toBe("acquired");
    expect(started.user.content).toBe("你好");
    expect(started.assistant.status).toBe("pending");
    await save(c.id, turn, started.lock_token);
    const repeated = await begin(c.id, turn);
    expect(repeated.state).toBe("complete");
    expect(await scalar("select count(*)::int as result from messages")).toBe(2);
    expect((await conversation()).request_count).toBe(1);
  });
  it("blocks other participants, concurrent turns and changed retry content", async () => {
    const c = await conversation(); const turn = randomUUID();
    await expect(begin(c.id, turn, bob)).rejects.toThrow("FORBIDDEN");
    await begin(c.id, turn);
    await expect(begin(c.id)).rejects.toThrow("BUSY");
    await expect(begin(c.id, turn, alice, "changed")).rejects.toThrow("TURN_CONFLICT");
  });
  it("recovers stale streams without losing partial text or duplicating messages", async () => {
    const c = await conversation(); const turn = randomUUID();
    const original = await begin(c.id, turn);
    await save(c.id, turn, original.lock_token, "pending");
    await pg.query("update conversations set locked_until = now() - interval '1 second' where id=$1", [c.id]);
    await conversation();
    expect(await scalar("select status as result from messages where role='assistant'")).toBe("failed");
    expect(await scalar("select content as result from messages where role='assistant'")).toBe("回复");
    const retry = await begin(c.id, turn);
    await expect(save(c.id, turn, original.lock_token)).rejects.toThrow("STALE_LEASE");
    await save(c.id, turn, retry.lock_token);
    expect(await scalar("select count(*)::int as result from messages")).toBe(2);
  });
  it("enforces persistent per-conversation rate limits", async () => {
    const c = await conversation();
    for (let i = 0; i < 8; i++) { const turn = randomUUID(); const t = await begin(c.id, turn); await save(c.id, turn, t.lock_token); }
    await expect(begin(c.id)).rejects.toThrow("RATE_LIMITED");
  });
  it("enforces optimistic config revisions and administrator membership", async () => {
    await expect(scalar("select public.publish_config($1::jsonb,'k',$2::uuid,0,true) as result", ["{}", admin])).rejects.toThrow("CONFLICT");
    await expect(scalar("select public.publish_config($1::jsonb,'k',$2::uuid,1,true) as result", ["{}", alice])).rejects.toThrow("FORBIDDEN");
  });
  it("pause blocks new work but retains existing history", async () => {
    const c = await conversation(); const turn = randomUUID(); const t = await begin(c.id, turn); await save(c.id, turn, t.lock_token);
    await pg.exec("update study_state set enabled=false");
    expect((await conversation()).id).toBe(c.id);
    await expect(begin(c.id)).rejects.toThrow("STUDY_PAUSED");
    await expect(conversation(bob)).rejects.toThrow("STUDY_PAUSED");
  });
  it("RLS separates participants and prevents client writes and secret reads", async () => {
    const c = await conversation(); const turn = randomUUID(); const t = await begin(c.id, turn); await save(c.id, turn, t.lock_token);
    await conversation(bob);
    await pg.exec("set role authenticated");
    await pg.query("select set_config('request.jwt.claim.sub',$1,false)", [bob]);
    try {
      expect(await scalar("select count(*)::int as result from conversations")).toBe(1);
      expect(await scalar("select count(*)::int as result from messages")).toBe(0);
      await expect(pg.query("select * from config_versions")).rejects.toThrow("permission denied");
      await expect(pg.query("insert into admin_users(user_id) values($1)", [bob])).rejects.toThrow("permission denied");
      await expect(begin(c.id)).rejects.toThrow("permission denied");
      await expect(pg.query("delete from conversations")).rejects.toThrow("permission denied");
    } finally { await pg.exec("reset role"); }
  });
});
