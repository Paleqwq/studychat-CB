import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { defaultExperiment } from "@/lib/experiment";

let pg: PGlite;
const admin = "00000000-0000-4000-8000-000000000001";
const alice = "00000000-0000-4000-8000-000000000002";
const bob = "00000000-0000-4000-8000-000000000003";
const settings = { ...defaultExperiment(), personality_prompt: "test personality" };
settings.connections.deepseek.model = "test-deepseek";
settings.connections.chatgpt.model = "test-chatgpt";
const bootstrap = "create schema auth; create role anon; create role authenticated; create role service_role bypassrls; create table auth.users(id uuid primary key); create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$; grant usage on schema auth,public to authenticated,anon,service_role;";
async function scalar<T = any>(sql: string, params: unknown[] = []): Promise<T> {
  return (await pg.query<{ result: T }>(sql, params)).rows[0]?.result;
}
async function publish(revision = 0) {
  return scalar("select publish_experiment($1::jsonb,$2::jsonb,$3::uuid,$4,true) as result", [JSON.stringify(settings),
    JSON.stringify({ deepseek: "test-encrypted-d", chatgpt: "test-encrypted-c" }), admin, revision]);
}
async function enroll(owner = alice, student = "00123") {
  return scalar("select to_jsonb(register_participant($1,$2)) as result", [owner, student]);
}
async function remove(id: string, actor: string | null = admin) {
  return scalar("select admin_delete_conversation($1,$2) as result", [id, actor]);
}
async function start(id: string, owner = alice) {
  const turn = randomUUID();
  const reply = await scalar("select begin_turn($1,$2,$3,'test message') as result", [id, owner, turn]);
  return { turn, lease: reply.lock_token };
}
async function finish(id: string, turn: string, lease: string) {
  return scalar("select save_reply($1,$2,$3,'test reply','complete',null) as result", [id, turn, lease]);
}
beforeAll(async () => {
  pg = new PGlite(); await pg.exec(bootstrap);
  for (const file of ["001_studychat.sql", "002_factorial_experiment.sql", "003_admin_delete_conversation.sql"]) {
    await pg.exec(await readFile(path.resolve("supabase/migrations", file), "utf8"));
  }
  await pg.query("insert into auth.users values($1),($2),($3)", [admin, alice, bob]);
  await pg.query("insert into admin_users(user_id) values($1)", [admin]);
}, 60000);
beforeEach(async () => {
  await pg.exec("reset role; truncate study_state,experiment_versions,config_versions,conversations restart identity cascade; insert into study_state(id) values(1);");
  await publish();
});
afterAll(async () => { await pg?.close(); });

describe("atomic administrator conversation deletion", () => {
  it("deletes only the selected conversation and its messages, request events and enrollment", async () => {
    const first = await enroll(); const other = await enroll(bob, "00234");
    const a = await start(first.id); await finish(first.id, a.turn, a.lease);
    const b = await start(other.id, bob); await finish(other.id, b.turn, b.lease);
    const group = await scalar("select group_code as result from participant_enrollments where conversation_id=$1", [first.id]);
    const countsBefore = (await pg.query<any>("select * from experiment_group_counts()")).rows;
    expect(await remove(first.id)).toBe(first.id);
    for (const table of ["messages", "request_events", "participant_enrollments"]) {
      expect(await scalar(`select count(*)::int as result from ${table} where conversation_id=$1`, [first.id])).toBe(0);
    }
    expect(await scalar("select count(*)::int as result from conversations where id=$1", [first.id])).toBe(0);
    expect(await scalar("select count(*)::int as result from conversations where id=$1", [other.id])).toBe(1);
    expect(await scalar("select count(*)::int as result from messages where conversation_id=$1", [other.id])).toBe(2);
    expect(await scalar("select count(*)::int as result from request_events where conversation_id=$1", [other.id])).toBe(1);
    expect(await scalar("select count(*)::int as result from auth.users")).toBe(3);
    expect(await scalar("select count(*)::int as result from config_versions")).toBe(4);
    expect(await scalar("select count(*)::int as result from experiment_versions")).toBe(1);
    expect(await scalar("select count(*)::int as result from experiment_groups")).toBe(4);
    const countsAfter = (await pg.query<any>("select * from experiment_group_counts()")).rows;
    for (const before of countsBefore) {
      const after = countsAfter.find(row => row.group_code === before.group_code);
      expect(Number(after?.enrolled ?? 0)).toBe(Number(before.enrolled) - (before.group_code === group ? 1 : 0));
    }
  });
  it("releases the student identifier and browser identity for a new enrollment under the latest configuration", async () => {
    const first = await enroll();
    const latest = await publish(1);
    await remove(first.id);
    expect(await scalar("select to_jsonb(restore_conversation($1)) as result", [alice])).toBeNull();
    const next = await enroll();
    expect(next.id).not.toBe(first.id);
    expect(await scalar("select experiment_id as result from participant_enrollments where owner_id=$1", [alice])).toBe(latest.id);
    expect(await scalar("select count(*)::int as result from participant_enrollments")).toBe(1);
  });
  it("rejects non-admin or null actors without deleting any rows", async () => {
    const c = await enroll();
    for (const actor of [alice, null]) await expect(remove(c.id, actor)).rejects.toThrow("FORBIDDEN");
    expect(await scalar("select count(*)::int as result from conversations")).toBe(1);
    expect(await scalar("select count(*)::int as result from participant_enrollments")).toBe(1);
  });
  it("rejects missing or already deleted IDs without affecting other conversations", async () => {
    const c = await enroll(); const other = await enroll(bob, "00234");
    await expect(remove(randomUUID())).rejects.toThrow("CONVERSATION_NOT_FOUND");
    await remove(c.id);
    await expect(remove(c.id)).rejects.toThrow("CONVERSATION_NOT_FOUND");
    expect(await scalar("select id as result from conversations")).toBe(other.id);
  });
  it("blocks active generation atomically and permits deletion after the reply finishes", async () => {
    const c = await enroll(); const { turn, lease } = await start(c.id);
    await expect(remove(c.id)).rejects.toThrow("CONVERSATION_BUSY");
    expect(await scalar("select count(*)::int as result from participant_enrollments")).toBe(1);
    expect(await scalar("select count(*)::int as result from messages")).toBe(2);
    await finish(c.id, turn, lease);
    expect(await remove(c.id)).toBe(c.id);
  });
  it("permits expired interrupted sessions to be deleted and prevents stale replies from resurrecting them", async () => {
    const c = await enroll(); const { turn, lease } = await start(c.id);
    await pg.query("update conversations set locked_until=clock_timestamp()-interval '1 second' where id=$1", [c.id]);
    await remove(c.id);
    await expect(finish(c.id, turn, lease)).rejects.toThrow("STALE_LEASE");
    expect(await scalar("select count(*)::int as result from messages")).toBe(0);
  });
  it("supports historical conversations that do not have experiment enrollments", async () => {
    const id = await scalar("insert into conversations(owner_id,config_id) select $1,id from config_versions limit 1 returning id as result", [alice]);
    const { turn, lease } = await start(id); await finish(id, turn, lease);
    expect(await remove(id)).toBe(id);
    expect(await scalar("select count(*)::int as result from messages")).toBe(0);
    expect(await scalar("select count(*)::int as result from config_versions")).toBe(4);
  });
  it("does not grant direct deletion or RPC execution to anonymous/authenticated clients, including admin JWTs", async () => {
    const c = await enroll();
    for (const role of ["anon", "authenticated"]) {
      await pg.exec("set role " + role);
      try {
        await pg.query("select set_config('request.jwt.claim.sub',$1,false)", [admin]);
        expect(await scalar("select auth.uid() as result")).toBe(admin);
        await expect(remove(c.id)).rejects.toThrow("permission denied");
        await expect(pg.query("delete from conversations where id=$1", [c.id])).rejects.toThrow("permission denied");
      } finally { await pg.exec("reset role"); }
    }
    await pg.exec("set role service_role");
    try {
      await expect(remove(c.id, alice)).rejects.toThrow("FORBIDDEN");
      expect(await remove(c.id)).toBe(c.id);
    } finally { await pg.exec("reset role"); }
  });
  it("can rerun the installation migration without deleting existing data", async () => {
    const c = await enroll();
    await pg.exec(await readFile(path.resolve("supabase/migrations/003_admin_delete_conversation.sql"), "utf8"));
    expect(await scalar("select id as result from conversations")).toBe(c.id);
    expect(await scalar("select count(*)::int as result from participant_enrollments")).toBe(1);
  });
  it("includes the exact standalone deletion migration in the fresh-project initialization SQL", async () => {
    const init = await readFile(path.resolve("supabase/new_project_init.sql"), "utf8");
    const migration = await readFile(path.resolve("supabase/migrations/003_admin_delete_conversation.sql"), "utf8");
    expect(init.replace(/\r\n/g, "\n")).toContain(migration.replace(/\r\n/g, "\n").trim());
    const fresh = new PGlite();
    try {
      await fresh.exec(bootstrap); await fresh.exec(init);
      expect((await fresh.query("select proname from pg_proc where proname='admin_delete_conversation'")).rows).toHaveLength(1);
    } finally { await fresh.close(); }
  });
});
