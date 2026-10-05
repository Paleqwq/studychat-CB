import { beforeAll, beforeEach, afterAll, describe, it, expect } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { defaultExperiment, effectiveSettings, groups } from "@/lib/experiment";
import { resolveProviderEndpoint } from "@/lib/provider-endpoint";
import { applyConnectionSettings } from "@/lib/conversation-connection";

let pg: PGlite;
const admin = "00000000-0000-4000-8000-000000000001";
const alice = "00000000-0000-4000-8000-000000000002";
const bob = "00000000-0000-4000-8000-000000000003";
const settings = { ...defaultExperiment(), base_prompt: "共同研究任务", personality_prompt: "正式人格材料" };
settings.connections.deepseek.model = "deepseek-test";
settings.connections.chatgpt.model = "chatgpt-test";
settings.connections.chatgpt.protocol = "anthropic";
const keys = { deepseek: "encrypted-deepseek", chatgpt: "encrypted-chatgpt" };
async function scalar<T = any>(sql: string, params: unknown[] = []): Promise<T> {
  return (await pg.query<{ result: T }>(sql, params)).rows[0]?.result;
}
async function publish(revision = 0, enabled = true, config = settings, actor = admin, secrets = keys) {
  return scalar("select publish_experiment($1::jsonb,$2::jsonb,$3::uuid,$4,$5) as result", [JSON.stringify(config), JSON.stringify(secrets), actor, revision, enabled]);
}
async function enroll(owner = alice, student = "001234") {
  return scalar("select to_jsonb(register_participant($1::uuid,$2)) as result", [owner, student]);
}
async function restore(owner = alice) {
  return scalar("select to_jsonb(restore_conversation($1::uuid)) as result", [owner]);
}
beforeAll(async () => {
  pg = new PGlite();
  await pg.exec("create schema auth; create role anon; create role authenticated; create role service_role bypassrls; create table auth.users(id uuid primary key);");
  await pg.exec("create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$; grant usage on schema auth,public to authenticated,anon,service_role;");
  for (const file of ["001_studychat.sql", "002_factorial_experiment.sql"]) await pg.exec(await readFile(path.resolve("supabase/migrations", file), "utf8"));
  await pg.query("insert into auth.users values($1),($2),($3)", [admin, alice, bob]);
  await pg.query("insert into admin_users(user_id) values($1)", [admin]);
}, 60000);
beforeEach(async () => {
  await pg.exec("reset role; truncate study_state,experiment_versions,config_versions,conversations restart identity cascade; insert into study_state(id) values(1);");
  await publish();
});
afterAll(async () => { await pg?.close(); });

describe("2x2 experiment migration and enrollment", () => {
  it("atomically builds four exact model/prompt combinations with model-specific credentials", async () => {
    const rows = (await pg.query<any>("select g.*,v.settings,v.api_key_ciphertext from experiment_groups g join config_versions v on v.id=g.config_id")).rows;
    expect(rows).toHaveLength(4);
    for (const group of groups) {
      const row = rows.find(r => r.group_code === group.code);
      expect(row.settings).toEqual(effectiveSettings(settings, group));
      expect(row.api_key_ciphertext).toBe(keys[group.model]);
    }
  });
  it("persists independent protocol endpoints in all four groups while keeping old sessions frozen", async () => {
    const first = await enroll();
    const before = await scalar("select settings as result from config_versions where id=$1", [first.config_id]);
    const next = structuredClone(settings);
    next.connections.deepseek.api_base_url = "https://deepseek-gateway.example/compat/v1";
    next.connections.deepseek.api_url_mode = "base";
    next.connections.chatgpt.api_base_url = "https://chatgpt-gateway.example/claude/messages/";
    next.connections.chatgpt.api_url_mode = "endpoint";
    const published = await publish(1, true, next);
    const rows = (await pg.query<any>("select g.*,v.settings from experiment_groups g join config_versions v on v.id=g.config_id where g.experiment_id=$1", [published.id])).rows;
    for (const group of groups) {
      const row = rows.find(r => r.group_code === group.code);
      expect(row.settings).toEqual(effectiveSettings(next, group));
      expect(resolveProviderEndpoint(row.settings)).toBe(group.model === "deepseek"
        ? "https://deepseek-gateway.example/compat/v1/chat/completions" : "https://chatgpt-gateway.example/claude/messages/");
    }
    expect((await restore()).config_id).toBe(first.config_id);
    expect(await scalar("select settings as result from config_versions where id=$1", [first.config_id])).toEqual(before);
  });
  it("rotates published transports and credentials without rewriting old experiment snapshots or enrollments", async () => {
    const conversation = await enroll();
    const before = await scalar("select to_jsonb(v) as result from config_versions v where id=$1", [conversation.config_id]);
    const enrollment = await scalar("select to_jsonb(e) as result from participant_enrollments e where conversation_id=$1", [conversation.id]);
    const group = groups.find(g => g.code === enrollment.group_code)!;
    const next = structuredClone(settings);
    next.base_prompt = "new-task"; next.personality_prompt = "new-personality";
    next.connections[group.model] = { ...next.connections[group.model], protocol: "openai-responses", api_url_mode: "endpoint",
      api_base_url: "https://rotated.example/native/responses/", model: "changed-for-new-enrollments", max_tokens: 8192, temperature: 1 };
    const nextKeys = { deepseek: "rotated-d", chatgpt: "rotated-c" };
    const current = await publish(1, true, next, admin, nextKeys);
    const effective = applyConnectionSettings(before.settings, current.settings.connections[group.model]);
    expect(resolveProviderEndpoint(effective)).toBe("https://rotated.example/native/responses/");
    for (const key of ["model", "system_prompt", "temperature", "max_tokens", "title", "disclosure"])
      expect(effective[key as keyof typeof effective]).toEqual(before.settings[key]);
    expect(current.encrypted_keys[group.model]).toBe(nextKeys[group.model]);
    expect(await scalar("select to_jsonb(v) as result from config_versions v where id=$1", [conversation.config_id])).toEqual(before);
    expect(await scalar("select to_jsonb(e) as result from participant_enrollments e where conversation_id=$1", [conversation.id])).toEqual(enrollment);
    expect((await restore()).config_id).toBe(conversation.config_id);
    expect(await scalar("select count(*)::int as result from conversations")).toBe(1);
  });
  it("preserves leading zeros, normalizes letter case, and does not enroll on restore", async () => {
    expect((await restore())?.id).toBeFalsy();
    expect(await scalar("select count(*)::int as result from conversations")).toBe(0);
    const one = await enroll(alice, " 00ab12 ");
    expect((await enroll(alice, "00AB12")).id).toBe(one.id);
    expect(await scalar("select student_id as result from participant_enrollments")).toBe("00AB12");
    expect((await restore()).id).toBe(one.id);
  });
  it("rejects duplicate student IDs across identities and blocks identity rebinding", async () => {
    await enroll();
    await expect(enroll(bob)).rejects.toThrow("STUDENT_UNAVAILABLE");
    await expect(enroll(alice, "009999")).rejects.toThrow("IDENTITY_BOUND");
    expect(await scalar("select count(*)::int as result from participant_enrollments")).toBe(1);
    expect((await restore(bob))?.id).toBeFalsy();
    await expect(enroll(bob, "../private")).rejects.toThrow("INVALID_STUDENT_ID");
  });
  it("balances queued registrations with a maximum group size difference of one", async () => {
    // PGlite queues work on one connection; real multi-connection lock contention requires deployment QA.
    const owners = Array.from({ length: 41 }, () => randomUUID());
    for (const owner of owners) await pg.query("insert into auth.users values($1)", [owner]);
    await Promise.all(owners.map((owner, i) => enroll(owner, "S" + i)));
    const counts = (await pg.query<{ enrolled: number }>("select enrolled::int from experiment_group_counts()")).rows.map(r => r.enrolled);
    expect(counts).toHaveLength(4);
    expect(counts.reduce((a, b) => a + b, 0)).toBe(41);
    expect(Math.max(...counts) - Math.min(...counts)).toBe(1);
  });
  it("makes repeated registration requests idempotent", async () => {
    const result = await Promise.all(Array.from({ length: 8 }, () => enroll()));
    expect(new Set(result.map(c => c.id)).size).toBe(1);
    expect(await scalar("select count(*)::int as result from participant_enrollments")).toBe(1);
  });
  it("freezes group, prompt and model versions across publication and pause", async () => {
    const first = await enroll();
    const group = await scalar("select to_jsonb(e) as result from participant_enrollments e");
    await publish(1, false, { ...settings, personality_prompt: "修改后人格", base_prompt: "新任务" });
    expect((await enroll()).config_id).toBe(first.config_id);
    expect(await scalar("select to_jsonb(e) as result from participant_enrollments e")).toEqual(group);
    expect((await restore()).id).toBe(first.id);
    await expect(enroll(bob, "002")).rejects.toThrow("STUDY_PAUSED");
    await pg.exec("update study_state set enabled=true");
    const second = await enroll(bob, "002");
    expect(second.config_id).not.toBe(first.config_id);
    expect(await scalar("select v.revision::int as result from experiment_versions v join participant_enrollments e on e.experiment_id=v.id where e.owner_id=$1", [bob])).toBe(2);
  });
  it("fails closed on incomplete configuration, stale revision and missing groups", async () => {
    await expect(publish(1, true, settings, admin, { ...keys, chatgpt: "" })).rejects.toThrow("INVALID_EXPERIMENT");
    await expect(publish(1, true, { ...settings, personality_prompt: " " })).rejects.toThrow("INVALID_EXPERIMENT");
    await expect(publish(0)).rejects.toThrow("CONFLICT");
    await expect(publish(1, true, settings, alice)).rejects.toThrow("FORBIDDEN");
    expect(await scalar("select count(*)::int as result from experiment_versions")).toBe(1);
    await pg.exec("delete from experiment_groups where group_code='deepseek_control'");
    await expect(enroll()).rejects.toThrow("NOT_CONFIGURED");
    expect(await scalar("select count(*)::int as result from conversations")).toBe(0);
  });
  it("preserves legacy records without labeling them as experimental participants", async () => {
    const id = await scalar("insert into conversations(owner_id,config_id) select $1,id from config_versions limit 1 returning id as result", [alice]);
    await expect(enroll()).rejects.toThrow("LEGACY_SESSION");
    expect((await restore()).id).toBe(id);
    const record = await scalar("select to_jsonb(v) as result from admin_conversation_records v");
    expect(record.student_id).toBeNull();
    expect(record.group_code).toBeNull();
    expect(await scalar("select count(*)::int as result from participant_enrollments")).toBe(0);
  });
  it("retains durable turn, interrupted-stream recovery and ownership protections", async () => {
    const c = await enroll(); const turn = randomUUID();
    const start = await scalar("select begin_turn($1,$2,$3,'测试') as result", [c.id, alice, turn]);
    await scalar("select save_reply($1,$2,$3,'部分文本','pending',null) as result", [c.id, turn, start.lock_token]);
    await pg.query("update conversations set locked_until=now()-interval '1 second' where id=$1", [c.id]);
    await restore();
    expect(await scalar("select content as result from messages where role='assistant'")).toBe("部分文本");
    expect(await scalar("select status as result from messages where role='assistant'")).toBe("failed");
    await expect(scalar("select begin_turn($1,$2,$3,'测试') as result", [c.id, bob, turn])).rejects.toThrow("FORBIDDEN");
  });
  it("hides student assignments, config IDs, private views and RPCs even through direct REST roles", async () => {
    await enroll(); await enroll(bob, "002");
    await pg.exec("set role authenticated");
    await pg.query("select set_config('request.jwt.claim.sub',$1,false)", [alice]);
    try {
      expect((await pg.query("select id,participant_code from conversations")).rows).toHaveLength(1);
      for (const sql of ["select config_id from conversations", "select lock_token from conversations", "select * from participant_enrollments",
        "select * from experiment_groups", "select * from experiment_versions", "select * from admin_conversation_records",
        "select * from experiment_group_counts()", "delete from participant_enrollments"]) await expect(pg.query(sql)).rejects.toThrow("permission denied");
      await expect(enroll()).rejects.toThrow("permission denied");
      await expect(restore(bob)).rejects.toThrow("permission denied");
    } finally { await pg.exec("reset role"); }
    await pg.exec("set role service_role");
    try {
      expect((await restore()).id).toBeTruthy();
      await expect(scalar("select get_or_create_conversation($1) as result", [alice])).rejects.toThrow("permission denied");
    } finally { await pg.exec("reset role"); }
  });
});
