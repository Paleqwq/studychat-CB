import { beforeAll, beforeEach, afterAll, describe, it, expect } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { defaultExperiment } from "@/lib/experiment";
import { defaultQuestionMode, firstQuestionMessage, initialQuestionProgress, nextQuestionProgress, questionReply, neutralQuestionMessage, type QuestionProgress } from "@/lib/question-mode";

const admin = "00000000-0000-4000-8000-000000000001";
const alice = "00000000-0000-4000-8000-000000000002";
const bob = "00000000-0000-4000-8000-000000000003";
const settings = { ...defaultExperiment(), personality_prompt: "原人格", question_mode: { ...defaultQuestionMode(), enabled: true } };
settings.connections.deepseek.model = "test-d"; settings.connections.chatgpt.model = "test-c";
let pg: PGlite;
async function scalar<T = any>(sql: string, params: unknown[] = []): Promise<T> { return (await pg.query<{ result: T }>(sql, params)).rows[0]?.result; }
async function publish(config = settings, revision = 0, enabled = true) {
  return scalar("select publish_experiment($1::jsonb,$2::jsonb,$3::uuid,$4,$5) as result", [JSON.stringify(config), JSON.stringify({ deepseek: "cipher-d", chatgpt: "cipher-c" }), admin, revision, enabled]);
}
async function enroll(owner = alice, sid = "00123") { return scalar("select to_jsonb(register_participant($1::uuid,$2)) as result", [owner, sid]); }
async function ensure(id: string, owner = alice) { return scalar<QuestionProgress>("select ensure_question_session($1::uuid,$2::uuid) as result", [id, owner]); }
async function begin(id: string, turn: string = randomUUID(), owner = alice, content = "学生原话：证据与设计") {
  return scalar("select begin_turn($1::uuid,$2::uuid,$3::uuid,$4) as result", [id, owner, turn, content]);
}
async function finish(id: string, turn: string, lease: string, before: QuestionProgress, achieved = true, overrides?: object) {
  const assessment = before.phase === "retest" ? null : { achieved, observed_level: achieved ? "create" : "understand", evidence: "证据与设计", reply: achieved ? "已给出充分依据。" : "请解释这个依据。", ...overrides };
  const next = nextQuestionProgress(before, achieved);
  const content = questionReply(settings.question_mode, before, next, assessment?.reply);
  return scalar("select save_question_reply($1::uuid,$2::uuid,$3::uuid,$4::jsonb,$5::jsonb,$6) as result",
    [id, turn, lease, JSON.stringify(before), assessment ? JSON.stringify(assessment) : null, content]);
}
beforeAll(async () => {
  pg = new PGlite();
  await pg.exec("create schema auth; create role anon; create role authenticated; create role service_role bypassrls; create table auth.users(id uuid primary key); create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$; grant usage on schema auth,public to authenticated,anon,service_role;");
  for (const f of ["001_studychat.sql", "002_factorial_experiment.sql", "003_admin_delete_conversation.sql", "004_question_mode.sql"]) await pg.exec(await readFile("supabase/migrations/" + f, "utf8"));
  await pg.query("insert into auth.users values($1),($2),($3)", [admin, alice, bob]);
  await pg.query("insert into admin_users(user_id) values($1)", [admin]);
}, 60000);
beforeEach(async () => {
  await pg.exec("reset role; truncate study_state,experiment_versions,config_versions,conversations restart identity cascade; insert into study_state(id) values(1);");
  await publish();
});
afterAll(async () => { await pg?.close(); });

describe("transactional two-round question sessions", () => {
  it("freezes three questions in all four configurations and inserts exactly one opening, without a fake student message", async () => {
    const rows = (await pg.query<any>("select settings from config_versions")).rows;
    expect(rows).toHaveLength(4);
    for (const row of rows) expect(row.settings.question_mode).toEqual(settings.question_mode);
    const c = await enroll();
    expect(await ensure(c.id)).toEqual(initialQuestionProgress());
    expect(await ensure(c.id)).toEqual(initialQuestionProgress());
    expect(await scalar("select count(*)::int as result from messages")).toBe(1);
    // Already-applied migration 004 retains its original opening. The student
    // presentation is neutral without a new migration or a history rewrite.
    const storedOpening = await scalar<string>("select content as result from messages");
    expect(storedOpening).toContain("第一轮 · 引导学习");
    expect(neutralQuestionMessage(storedOpening)).toBe(firstQuestionMessage(settings.question_mode));
    expect(await scalar("select content as result from messages")).toBe(storedOpening);
    expect(await scalar("select count(*)::int as result from messages where role='user'")).toBe(0);
    const next = structuredClone(settings); next.question_mode.questions[0].prompt = "新配置题目";
    await publish(next, 1);
    expect(await ensure(c.id)).toEqual(initialQuestionProgress());
    expect(await scalar("select settings->'question_mode' as result from config_versions where id=$1", [c.config_id])).toEqual(settings.question_mode);
  });
  it("atomically runs guidance then the same three retest questions and refuses new answers after completion", async () => {
    const c = await enroll(); let state = await ensure(c.id); let lastTurn = "";
    for (let i = 0; i < 7; i++) {
      await pg.exec("delete from request_events"); // This test targets progression, not the existing 8/minute limit.
      const turn = randomUUID(); const started = await begin(c.id, turn);
      expect(started.question_progress).toEqual(state);
      const achieved = i !== 0;
      const saved = await finish(c.id, turn, started.lock_token, state, achieved);
      expect(saved.question_progress).toEqual(nextQuestionProgress(state, achieved));
      const after = saved.question_progress;
      expect(await scalar("select question_progress as result from conversations where id=$1", [c.id])).toEqual(after);
      expect((await begin(c.id, turn)).state).toBe("complete");
      expect(await scalar("select count(*)::int as result from question_turns")).toBe(i + 1);
      state = after; lastTurn = turn;
    }
    expect(state.phase).toBe("completed");
    await expect(begin(c.id)).rejects.toThrow("QUESTION_COMPLETED");
    expect((await begin(c.id, lastTurn)).state).toBe("complete");
    const audits = (await pg.query<any>("select * from question_turns order by created_at")).rows;
    expect(audits.filter(a => a.before_state.phase === "retest")).toHaveLength(3);
    expect(audits.filter(a => a.before_state.phase === "retest").every(a => a.assessment === null)).toBe(true);
  });
  it("leaves progress unchanged on failed guidance, retries with the same turn, and rejects stale leases and forged evidence", async () => {
    const c = await enroll(); const state = await ensure(c.id); const turn = randomUUID();
    const first = await begin(c.id, turn);
    await expect(begin(c.id)).rejects.toThrow("BUSY");
    await expect(finish(c.id, turn, first.lock_token, state, true, { evidence: "伪造" })).rejects.toThrow("INVALID_QUESTION_ASSESSMENT");
    await expect(finish(c.id, turn, first.lock_token, state, true, { observed_level: "remember" })).rejects.toThrow("INVALID_QUESTION_ASSESSMENT");
    await expect(finish(c.id, turn, first.lock_token, { ...state, version: 9 })).rejects.toThrow("QUESTION_STATE_CONFLICT");
    await scalar("select save_reply($1::uuid,$2::uuid,$3::uuid,'','failed','provider_error') as result", [c.id, turn, first.lock_token]);
    expect(await ensure(c.id)).toEqual(state);
    const second = await begin(c.id, turn);
    await expect(finish(c.id, turn, first.lock_token, state)).rejects.toThrow("STALE_LEASE");
    await finish(c.id, turn, second.lock_token, state);
    expect(await scalar("select count(*)::int as result from messages where role='user'")).toBe(1);
    expect(await scalar("select count(*)::int as result from question_turns")).toBe(1);
  });
  it("enforces owner isolation, pause, private progress/audits and service-only RPCs", async () => {
    const c = await enroll();
    await expect(ensure(c.id, bob)).rejects.toThrow("FORBIDDEN");
    await pg.exec("update study_state set enabled=false");
    await expect(ensure(c.id)).rejects.toThrow("STUDY_PAUSED");
    await pg.exec("update study_state set enabled=true");
    await ensure(c.id);
    await pg.exec("update study_state set enabled=false");
    expect(await ensure(c.id)).toEqual(initialQuestionProgress()); // Existing history remains readable.
    await expect(begin(c.id)).rejects.toThrow("STUDY_PAUSED");
    await pg.exec("set role authenticated");
    try {
      await pg.query("select set_config('request.jwt.claim.sub',$1,false)", [alice]);
      await expect(pg.query("select question_progress from conversations")).rejects.toThrow("permission denied");
      await expect(pg.query("select * from question_turns")).rejects.toThrow("permission denied");
      await expect(ensure(c.id)).rejects.toThrow("permission denied");
      await expect(pg.query("select question_mode_available()")).rejects.toThrow("permission denied");
    } finally { await pg.exec("reset role"); }
  });
  it("preserves free chat, supports rerunning the migration and cascades audits only for an explicitly deleted conversation", async () => {
    const c = await enroll(); const state = await ensure(c.id); const turn = randomUUID(); const started = await begin(c.id, turn);
    await finish(c.id, turn, started.lock_token, state);
    await pg.exec(await readFile("supabase/migrations/004_question_mode.sql", "utf8"));
    expect((await ensure(c.id)).question_index).toBe(1);
    await publish({ ...settings, question_mode: { ...settings.question_mode, enabled: false } }, 1);
    const free = await enroll(bob, "00234");
    expect(await ensure(free.id, bob)).toBeNull();
    expect((await begin(free.id, randomUUID(), bob)).question_progress).toBeNull();
    await scalar("select admin_delete_conversation($1::uuid,$2::uuid) as result", [c.id, admin]);
    expect(await scalar("select count(*)::int as result from question_turns")).toBe(0);
    expect(await scalar("select count(*)::int as result from conversations")).toBe(1);
  });
  it("rejects invalid question configurations and includes the exact migration in new-project initialization", async () => {
    const bad = structuredClone(settings); bad.question_mode.questions.pop();
    await expect(publish(bad, 1)).rejects.toThrow("INVALID_QUESTION_MODE");
    expect(await scalar("select count(*)::int as result from experiment_versions")).toBe(1);
    const migration = await readFile("supabase/migrations/004_question_mode.sql", "utf8");
    const init = await readFile("supabase/new_project_init.sql", "utf8");
    expect(init.replace(/\r\n/g, "\n")).toContain(migration.replace(/\r\n/g, "\n").trim());
  });
  it("rejects a stale browser's version atomically but permits an already committed idempotent retry", async () => {
    const c = await enroll(); const state = await ensure(c.id); const turn = randomUUID();
    const start = (version: number, turnId = turn) => scalar("select begin_question_turn($1::uuid,$2::uuid,$3::uuid,$4,$5) as result",
      [c.id, alice, turnId, "学生原话：证据与设计", version]);
    const first = await start(0);
    await finish(c.id, turn, first.lock_token, state);
    await expect(start(0, randomUUID())).rejects.toThrow("QUESTION_STATE_CONFLICT");
    expect((await start(0)).state).toBe("complete");
    expect(await scalar("select count(*)::int as result from messages where role='user'")).toBe(1);
  });
});
