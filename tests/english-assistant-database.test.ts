import { beforeAll, beforeEach, afterAll, describe, it, expect } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { defaultSettings } from "@/lib/types";
import { defaultExperiment } from "@/lib/experiment";
import { firstEnglishMessage, initialEnglishProgress, advanceEnglishProgress, englishTurnContent,
  type EnglishProgress } from "@/lib/english-assistant";

const admin = "00000000-0000-4000-8000-000000000001";
const alice = "00000000-0000-4000-8000-000000000002";
const bob = "00000000-0000-4000-8000-000000000003";
const settings = { ...defaultSettings, model: "original-model", system_prompt: "independent-English-placeholder" };
let pg: PGlite;
async function scalar<T = any>(sql: string, params: unknown[] = []): Promise<T> {
  return (await pg.query<{ result: T }>(sql, params)).rows[0]?.result;
}
async function register(owner = alice, sid = "00123") {
  return scalar("select register_english_session($1::uuid,$2,$3) as result", [owner, sid, firstEnglishMessage()]);
}
async function restore(owner = alice) { return scalar("select restore_english_session($1::uuid) as result", [owner]); }
async function begin(id: string, state: EnglishProgress, turn: string = randomUUID(), owner = alice,
  content = "学生原话：观点、证据、解释和回扣主题") {
  return scalar("select begin_english_turn($1::uuid,$2::uuid,$3::uuid,$4,$5) as result", [id, owner, turn, content, state.version]);
}
async function finish(id: string, turn: string, lease: string, before: EnglishProgress,
  achieved = true, overrides: object = {}) {
  const assessment = { achieved, evidence: achieved ? "证据、解释" : "", feedback: "当前作答已收到。", ...overrides };
  return scalar("select save_english_reply($1::uuid,$2::uuid,$3::uuid,$4::jsonb,$5::jsonb,$6) as result",
    [id, turn, lease, JSON.stringify(before), JSON.stringify(assessment),
      englishTurnContent(before, advanceEnglishProgress(before, achieved), assessment.feedback)]);
}
async function fail(id: string, turn: string, lease: string, state: EnglishProgress) {
  return scalar("select save_english_reply($1::uuid,$2::uuid,$3::uuid,$4::jsonb,null,'','failed','provider_error') as result",
    [id, turn, lease, JSON.stringify(state)]);
}
beforeAll(async () => {
  pg = new PGlite();
  await pg.exec("create schema auth; create role anon; create role authenticated; create role service_role bypassrls; create table auth.users(id uuid primary key); create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$; grant usage on schema auth,public to authenticated,anon,service_role;");
  for (const file of ["001_studychat.sql", "002_factorial_experiment.sql", "003_admin_delete_conversation.sql", "004_question_mode.sql", "005_english_assistant.sql"]) {
    await pg.exec(await readFile("supabase/migrations/" + file, "utf8"));
  }
  await pg.query("insert into auth.users values($1),($2),($3)", [admin, alice, bob]);
  await pg.query("insert into admin_users(user_id) values($1)", [admin]);
}, 60000);
beforeEach(async () => {
  await pg.exec("reset role; truncate english_assistant_state,english_assistant_configs,study_state,experiment_versions,config_versions,conversations restart identity cascade; insert into study_state(id) values(1); insert into english_assistant_state(id) values(1);");
  await scalar("select seed_english_config($1::jsonb,$2) as result", [JSON.stringify(settings), "english-cipher"]);
});
afterAll(async () => { await pg?.close(); });

describe("independent transactional BOPPPS sessions", () => {
  it("registers its own student identity and inserts one opening without touching Bloom conversations or enrollment", async () => {
    const first = await register(); const second = await register();
    expect(first.id).toBe(second.id);
    expect(first.english_progress).toEqual(initialEnglishProgress());
    expect(first.student_id).toBe("00123");
    expect(await scalar("select count(*)::int as result from english_assistant_messages")).toBe(1);
    expect(await scalar("select content as result from english_assistant_messages")).toBe(firstEnglishMessage());
    expect(await scalar("select count(*)::int as result from english_assistant_messages where role='user'")).toBe(0);
    expect(await scalar("select count(*)::int as result from conversations")).toBe(0);
    expect(await scalar("select count(*)::int as result from participant_enrollments")).toBe(0);
    expect(await scalar("select count(*)::int as result from request_events")).toBe(0);
    expect((await restore()).english_progress).toEqual(initialEnglishProgress());
    await expect(register(alice, "other")).rejects.toThrow("IDENTITY_BOUND");
    await expect(register(bob, "00123")).rejects.toThrow("STUDENT_UNAVAILABLE");
    await expect(register(bob, "!invalid")).rejects.toThrow("INVALID_STUDENT_ID");
  });
  it("enforces all twelve activities in strict BOPPPS order and returns completed retries without another transition", async () => {
    const session = await register(); let state = session.english_progress as EnglishProgress;
    const stages: string[] = []; let lastTurn = "";
    for (let index = 0; index < 12; index++) {
      await pg.exec("delete from english_assistant_request_events");
      stages.push(state.stage + ":" + state.step);
      const turn = randomUUID(); const started = await begin(session.id, state, turn);
      const saved = await finish(session.id, turn, started.lock_token, state);
      const expected = advanceEnglishProgress(state, true);
      expect(saved.english_progress).toEqual(expected);
      expect((await restore()).english_progress).toEqual(expected);
      expect((await begin(session.id, state, turn)).state).toBe("complete");
      state = expected; lastTurn = turn;
    }
    expect(stages).toEqual(["bridge:0", "objectives:0", "pre_assessment:0", "pre_assessment:1", "pre_assessment:2",
      "participatory:0", "participatory:1", "participatory:2", "participatory:3", "post_assessment:0", "post_assessment:1", "summary:0"]);
    expect(state).toEqual({ stage: "summary", step: 0, version: 12, completed: true });
    await expect(begin(session.id, state)).rejects.toThrow("ENGLISH_COMPLETED");
    expect((await begin(session.id, initialEnglishProgress(), lastTurn)).state).toBe("complete");
    expect(await scalar("select count(*)::int as result from english_assistant_turns")).toBe(12);
  });
  it("keeps unfinished practice in place, rejects stale progress and verifies latest student evidence inside the transaction", async () => {
    const session = await register();
    const state: EnglishProgress = { stage: "participatory", step: 2, version: 7, completed: false };
    await pg.query("update english_assistant_sessions set english_progress=$1::jsonb where id=$2", [JSON.stringify(state), session.id]);
    const turn = randomUUID(); const started = await begin(session.id, state, turn);
    await expect(finish(session.id, turn, started.lock_token, state, true, { evidence: "伪造的证据" })).rejects.toThrow("INVALID_ENGLISH_ASSESSMENT");
    await expect(finish(session.id, turn, started.lock_token, state, true, { evidence: "" })).rejects.toThrow("INVALID_ENGLISH_ASSESSMENT");
    await expect(finish(session.id, turn, started.lock_token, { ...state, version: state.version + 1 })).rejects.toThrow("ENGLISH_STATE_CONFLICT");
    expect((await restore()).english_progress).toEqual(state);
    const saved = await finish(session.id, turn, started.lock_token, state, false);
    expect(saved.english_progress).toEqual(advanceEnglishProgress(state, false));
    await expect(begin(session.id, state)).rejects.toThrow("ENGLISH_STATE_CONFLICT");
    expect((await begin(session.id, state, turn)).state).toBe("complete");
  });
  it("serializes concurrent turns and restores an expired lease as a retry without duplicating student messages", async () => {
    const session = await register(); const state = initialEnglishProgress(); const turn = randomUUID();
    const results = await Promise.allSettled([begin(session.id, state, turn), begin(session.id, state)]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(result => result.status === "rejected")).toHaveLength(1);
    expect((results[1] as PromiseRejectedResult).reason.message).toContain("BUSY");
    const first = (results[0] as PromiseFulfilledResult<any>).value;
    await pg.query("update english_assistant_sessions set locked_until=now()-interval '1 second' where id=$1", [session.id]);
    const restored = await restore(); expect(restored.lock_token).toBeNull();
    expect(restored.english_progress).toEqual(state);
    expect(await scalar("select status as result from english_assistant_messages where turn_id=$1 and role='assistant'", [turn])).toBe("failed");
    const second = await begin(session.id, state, turn);
    await expect(finish(session.id, turn, first.lock_token, state)).rejects.toThrow("STALE_LEASE");
    await finish(session.id, turn, second.lock_token, state);
    expect(await scalar("select count(*)::int as result from english_assistant_messages where role='user'")).toBe(1);
    expect(await scalar("select count(*)::int as result from english_assistant_turns")).toBe(1);
  });
  it("records failure without progress or audit changes and accepts only the original content on retry", async () => {
    const session = await register(); const state = initialEnglishProgress(); const turn = randomUUID();
    const started = await begin(session.id, state, turn);
    await fail(session.id, turn, started.lock_token, state);
    expect((await restore()).english_progress).toEqual(state);
    expect(await scalar("select count(*)::int as result from english_assistant_turns")).toBe(0);
    await expect(begin(session.id, state, turn, alice, "修改后的学生作答")).rejects.toThrow("TURN_CONFLICT");
    await expect(begin(session.id, state)).rejects.toThrow("BUSY");
    const retry = await begin(session.id, state, turn);
    await finish(session.id, turn, retry.lock_token, state);
    expect((await restore()).english_progress.version).toBe(1);
  });
  it("has independent pause and request limits while existing history stays readable", async () => {
    const session = await register(); const state = initialEnglishProgress();
    expect(await scalar("select enabled as result from study_state")).toBe(false);
    const turn = randomUUID(); const first = await begin(session.id, state, turn);
    await fail(session.id, turn, first.lock_token, state);
    await pg.exec("update english_assistant_state set enabled=false");
    expect((await restore()).id).toBe(session.id);
    await expect(begin(session.id, state, turn)).rejects.toThrow("ENGLISH_PAUSED");
    await expect(register(bob, "B002")).rejects.toThrow("ENGLISH_PAUSED");
    await pg.exec("update english_assistant_state set enabled=true");
    await pg.query("update english_assistant_sessions set request_count=200 where id=$1", [session.id]);
    await expect(begin(session.id, state, turn)).rejects.toThrow("SESSION_LIMIT");
    await pg.query("update english_assistant_sessions set request_count=0 where id=$1", [session.id]);
    await pg.query("insert into english_assistant_request_events(session_id) select $1::uuid from generate_series(1,7)", [session.id]);
    await expect(begin(session.id, state, turn)).rejects.toThrow("RATE_LIMITED");
    expect(await scalar("select count(*)::int as result from request_events")).toBe(0);
  });
  it("keeps English configuration snapshots independent and seeds only once", async () => {
    const session = await register();
    const ignored = await scalar("select seed_english_config($1::jsonb,$2) as result", [JSON.stringify({ ...settings, model: "ignored-second-seed" }), "ignored-cipher"]);
    expect(ignored.id).toBe(session.config_id);
    expect(await scalar("select count(*)::int as result from english_assistant_configs")).toBe(1);
    await expect(scalar("select publish_english_config($1::jsonb,$2,$3::uuid,true,null) as result", [JSON.stringify(settings), "cipher", admin])).rejects.toThrow("CONFLICT");
    await expect(scalar("select publish_english_config($1::jsonb,$2,$3::uuid,true,$4::uuid) as result", [JSON.stringify(settings), "cipher", bob, session.config_id])).rejects.toThrow("FORBIDDEN");
    const config = await scalar("select publish_english_config($1::jsonb,$2,$3::uuid,true,$4::uuid) as result", [JSON.stringify({ ...settings, model: "new-English-model" }), "new-cipher", admin, session.config_id]);
    const newer = await register(bob, "B002");
    expect(newer.config_id).toBe(config.id); expect((await restore()).config_id).toBe(session.config_id);
    expect(await scalar("select count(*)::int as result from config_versions")).toBe(0);
    expect(await scalar("select count(*)::int as result from experiment_versions")).toBe(0);
  });
  it("enforces owner isolation, private progress/configuration, RLS and service-only mutation RPCs", async () => {
    const session = await register(); await register(bob, "B002");
    await expect(begin(session.id, initialEnglishProgress(), randomUUID(), bob)).rejects.toThrow("FORBIDDEN");
    await pg.exec("set role authenticated");
    try {
      await pg.query("select set_config('request.jwt.claim.sub',$1,false)", [alice]);
      expect((await pg.query("select id from english_assistant_sessions")).rows).toEqual([{ id: session.id }]);
      expect((await pg.query("select content from english_assistant_messages")).rows).toHaveLength(1);
      await expect(pg.query("select english_progress from english_assistant_sessions")).rejects.toThrow("permission denied");
      await expect(pg.query("update english_assistant_sessions set english_progress='{}'")).rejects.toThrow("permission denied");
      await expect(pg.query("select * from english_assistant_configs")).rejects.toThrow("permission denied");
      await expect(pg.query("select * from english_assistant_state")).rejects.toThrow("permission denied");
      await expect(pg.query("select * from english_assistant_turns")).rejects.toThrow("permission denied");
      await expect(restore()).rejects.toThrow("permission denied");
      await expect(register()).rejects.toThrow("permission denied");
      await expect(begin(session.id, initialEnglishProgress())).rejects.toThrow("permission denied");
    } finally { await pg.exec("reset role"); }
  });
  it("allows the same independently registered identity in Bloom and preserves English when a Bloom conversation is deleted", async () => {
    const session = await register(); const experiment = { ...defaultExperiment(), personality_prompt: "Bloom personality" };
    experiment.connections.deepseek.model="bloom-deepseek"; experiment.connections.chatgpt.model="bloom-chatgpt";
    await scalar("select publish_experiment($1::jsonb,$2::jsonb,$3::uuid,0,true) as result",
      [JSON.stringify(experiment), JSON.stringify({ deepseek: "bloom-d", chatgpt: "bloom-c" }), admin]);
    const normal = await scalar("select to_jsonb(register_participant($1::uuid,$2)) as result", [alice, "00123"]);
    await expect(scalar("select begin_turn($1::uuid,$2::uuid,$3::uuid,'ordinary') as result", [session.id, alice, randomUUID()])).rejects.toThrow("FORBIDDEN");
    await expect(begin(normal.id, initialEnglishProgress())).rejects.toThrow("FORBIDDEN");
    await scalar("select admin_delete_conversation($1::uuid,$2::uuid) as result", [normal.id, admin]);
    expect((await restore()).id).toBe(session.id);
    expect(await scalar("select count(*)::int as result from english_assistant_messages")).toBe(1);
    await pg.exec(await readFile("supabase/migrations/005_english_assistant.sql", "utf8"));
    expect((await restore()).english_progress).toEqual(initialEnglishProgress());
    await pg.query("delete from english_assistant_sessions where id=$1", [session.id]);
    expect(await scalar("select count(*)::int as result from english_assistant_messages")).toBe(0);
  });
});
