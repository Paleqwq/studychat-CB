import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { defaultExperiment } from "@/lib/experiment";

const admin = "00000000-0000-4000-8000-000000000001";
const alice = "00000000-0000-4000-8000-000000000002";
const bob = "00000000-0000-4000-8000-000000000003";
const migrations = ["001_studychat.sql", "002_factorial_experiment.sql", "003_admin_delete_conversation.sql",
  "004_question_mode.sql", "005_english_assistant.sql", "006_english_groups.sql", "007_english_curriculum_and_delete.sql"];
const migrationFile = "supabase/migrations/008_english_learning_pause.sql";
const pauseReply = "可以先休息一下。本次学习已暂停，当前题目和进度已保留。准备好后，点击“继续学习”即可从这里继续。";
const resumeReply = "欢迎回来，学习已继续。请接着完成暂停前的当前活动。";
type Progress = { stage: string; step: number; version: number; completed: boolean };
let pg: PGlite;

async function scalar<T = any>(sql: string, params: unknown[] = [], database = pg): Promise<T> {
  return (await database.query<{ result: T }>(sql, params)).rows[0]?.result;
}
async function auth(database: PGlite) {
  await database.exec("create schema auth; create role anon; create role authenticated; create role service_role bypassrls; create table auth.users(id uuid primary key); create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$; grant usage on schema auth,public to authenticated,anon,service_role;");
}
async function identities(database: PGlite) {
  await database.query("insert into auth.users(id) values($1),($2),($3)", [admin, alice, bob]);
  await database.query("insert into admin_users(user_id) values($1)", [admin]);
}
async function prepare(database: PGlite, latest = true) {
  await auth(database);
  for (const file of migrations) await database.exec(await readFile("supabase/migrations/" + file, "utf8"));
  if (latest) await database.exec(await readFile(migrationFile, "utf8"));
  await identities(database);
}
async function source(database = pg) {
  const settings = defaultExperiment();
  settings.personality_prompt = "原课程独立人格";
  settings.connections.deepseek.model = "shared-deepseek";
  settings.connections.chatgpt.model = "unrelated-bloom-model";
  return scalar("select publish_experiment($1::jsonb,$2::jsonb,$3::uuid,0,true) as result",
    [JSON.stringify(settings), JSON.stringify({ deepseek: "test-d-cipher", chatgpt: "test-c-cipher" }), admin], database);
}
async function register(owner = alice, student = "ENG001", database = pg) {
  return scalar("select register_english_session($1::uuid,$2,'英语导入任务',0) as result", [owner, student], database);
}
async function restore(owner = alice, database = pg) {
  return scalar("select restore_english_session($1::uuid) as result", [owner], database);
}
async function control(session: any, paused: boolean | null, version: number | null,
  turn: string | null = randomUUID(), content = paused ? "我不想学了" : "继续学习", owner: string | null = session.owner_id, database = pg) {
  return scalar("select set_english_learning_pause($1::uuid,$2::uuid,$3::uuid,$4,$5,$6) as result",
    [session.id, owner, turn, content, version, paused], database);
}
async function begin(session: any, version: number, turn = randomUUID(), content = "这里有学生证据。", database = pg) {
  return scalar("select begin_english_turn($1::uuid,$2::uuid,$3::uuid,$4,$5) as result", [session.id, session.owner_id, turn, content, version], database);
}
async function save(session: any, turn: string, lease: string, state: Progress, status = "complete", database = pg) {
  return scalar("select save_english_reply($1::uuid,$2::uuid,$3::uuid,$4::jsonb,$5::jsonb,$6,$7,'provider_error') as result",
    [session.id, turn, lease, JSON.stringify(state), JSON.stringify({ achieved: false, evidence: "", feedback: "继续完成当前活动。" }),
      status === "complete" ? "对当前活动给出反馈。" : "", status], database);
}

beforeAll(async () => { pg = new PGlite(); await prepare(pg); }, 60000);
beforeEach(async () => {
  await pg.exec("reset role; truncate english_assistant_delete_audit,english_assistant_state,english_assistant_configs,study_state,experiment_versions,config_versions,conversations restart identity cascade; insert into study_state(id) values(1); insert into english_assistant_state(id) values(1);");
  await source();
});
afterAll(async () => { await pg?.close(); });

describe("personal English learning pauses", () => {
  it("preserves the current activity, inserts fixed complete message pairs and increments only the control version without affecting Bloom or other English students", async () => {
    const session = await register(); const other = await register(bob, "ENG002");
    const bloom = await scalar("select to_jsonb(register_participant($1::uuid,'ENG001')) as result", [alice]);
    const beforeBloom = await scalar("select to_jsonb(c) as result from conversations c where id=$1", [bloom.id]);
    const beforeGroups = await scalar("select jsonb_agg(to_jsonb(g)) as result from english_group_counts() g");
    const beforeCourse = await scalar("select to_jsonb(s) as result from english_assistant_state s");
    const beforeConfig = await scalar("select to_jsonb(c) as result from english_assistant_configs c where id=$1", [session.config_id]);
    const state = { stage: "participatory", step: 2, version: 7, completed: false };
    await pg.query("update english_assistant_sessions set english_progress=$1::jsonb where id=$2", [JSON.stringify(state), session.id]);
    const turn = randomUUID(); const paused = await control(session, true, 7, turn);
    expect(paused.english_paused).toBe(true);
    expect(paused.english_progress).toEqual({ ...state, version: 8 });
    expect(paused.user).toMatchObject({ role: "user", content: "我不想学了", status: "complete", turn_id: turn });
    expect(paused.assistant).toMatchObject({ role: "assistant", content: pauseReply, status: "complete", turn_id: turn });
    const resumed = await control(session, false, 8);
    expect(resumed.english_paused).toBe(false);
    expect(resumed.english_progress).toEqual({ ...state, version: 9 });
    expect(resumed.assistant.content).toBe(resumeReply);
    const restored = await restore(); expect(restored.english_paused).toBe(false);
    expect(restored.english_progress).toEqual(resumed.english_progress);
    expect(restored.request_count).toBe(0); expect(restored.lock_token).toBeNull(); expect(restored.locked_until).toBeNull();
    expect(await scalar("select count(*)::int as result from english_assistant_request_events")).toBe(0);
    expect(await scalar("select count(*)::int as result from english_assistant_turns")).toBe(0);
    const controls = (await pg.query<any>("select * from english_assistant_learning_controls order by created_at")).rows;
    expect(controls).toHaveLength(2);
    expect(controls[0]).toMatchObject({ session_id: session.id, turn_id: turn, paused: true,
      before_state: state, after_state: { ...state, version: 8 } });
    expect(await restore(bob)).toEqual(other);
    expect(await scalar("select to_jsonb(c) as result from conversations c where id=$1", [bloom.id])).toEqual(beforeBloom);
    expect(await scalar("select jsonb_agg(to_jsonb(g)) as result from english_group_counts() g")).toEqual(beforeGroups);
    expect(await scalar("select to_jsonb(s) as result from english_assistant_state s")).toEqual(beforeCourse);
    expect(await scalar("select to_jsonb(c) as result from english_assistant_configs c where id=$1", [session.config_id])).toEqual(beforeConfig);
    expect(await scalar("select english_paused as result from admin_english_conversation_records where id=$1", [session.id])).toBe(false);
    const nextTurn = randomUUID(); const started = await begin(session, 9, nextTurn);
    expect(started.english_paused).toBe(false);
    const saved = await save(session, nextTurn, started.lock_token, resumed.english_progress);
    expect(saved.english_progress).toEqual({ ...state, version: 10 });
    expect(await scalar("select count(*)::int as result from english_assistant_turns")).toBe(1);
  });

  it("blocks new teaching while paused and replays completed teaching before pause, version, completion or course-enabled checks with the latest personal pause flag", async () => {
    const session = await register(); const turn = randomUUID(); const started = await begin(session, 0, turn);
    await save(session, turn, started.lock_token, session.english_progress);
    await control(session, true, 1);
    await expect(begin(session, 2)).rejects.toThrow("ENGLISH_LEARNING_PAUSED");
    await expect(begin(session, 0)).rejects.toThrow("ENGLISH_LEARNING_PAUSED");
    await pg.exec("update english_assistant_state set enabled=false");
    const repeated = await begin(session, 0, turn);
    expect(repeated.state).toBe("complete"); expect(repeated.english_paused).toBe(true);
    expect(repeated.english_progress).toEqual({ ...session.english_progress, version: 2 });
    await control(session, false, 2);
    const resumedReplay = await begin(session, 0, turn);
    expect(resumedReplay.english_paused).toBe(false); expect(resumedReplay.english_progress.version).toBe(3);
    await expect(begin(session, 3)).rejects.toThrow("ENGLISH_PAUSED");
    expect(await scalar("select count(*)::int as result from english_assistant_request_events")).toBe(1);
  });

  it("makes control retries idempotent, validates original content and action, and returns the current state even after a later resume", async () => {
    const session = await register(); const turn = randomUUID(); const first = await control(session, true, 0, turn);
    const second = await control(session, true, 0, turn);
    expect(second).toEqual(first);
    expect(await scalar("select count(*)::int as result from english_assistant_messages")).toBe(3);
    await expect(control(session, false, 0, turn, "我不想学了")).rejects.toThrow("TURN_CONFLICT");
    await expect(control(session, true, 0, turn, "修改后的暂停请求")).rejects.toThrow("TURN_CONFLICT");
    await control(session, false, 1);
    const lateRetry = await control(session, true, 0, turn);
    expect(lateRetry.user).toEqual(first.user); expect(lateRetry.assistant).toEqual(first.assistant);
    expect(lateRetry.english_paused).toBe(false); expect(lateRetry.english_progress.version).toBe(2);
    expect(await scalar("select count(*)::int as result from english_assistant_learning_controls")).toBe(2);
    expect(await scalar("select count(*)::int as result from english_assistant_messages")).toBe(5);
    expect(await scalar("select count(*)::int as result from english_assistant_turns")).toBe(0);
  });

  it("allows pause and resume controls during an administrator course pause without allowing a new teaching request", async () => {
    const session = await register(); await pg.exec("update english_assistant_state set enabled=false");
    const paused = await control(session, true, 0); expect(paused.english_paused).toBe(true);
    const resumed = await control(session, false, 1); expect(resumed.english_paused).toBe(false);
    await expect(begin(session, 2)).rejects.toThrow("ENGLISH_PAUSED");
    expect(await scalar("select enabled as result from english_assistant_state")).toBe(false);
    expect(await scalar("select request_count as result from english_assistant_sessions")).toBe(0);
  });

  it("keeps controls available without consuming teaching rate limits or the session AI request budget", async () => {
    const session = await register();
    await pg.query("update english_assistant_sessions set request_count=200 where id=$1", [session.id]);
    await pg.query("insert into english_assistant_request_events(session_id) select $1::uuid from generate_series(1,8)", [session.id]);
    await control(session, true, 0); await control(session, false, 1);
    expect((await restore()).request_count).toBe(200);
    expect(await scalar("select count(*)::int as result from english_assistant_request_events")).toBe(8);
    await expect(begin(session, 2)).rejects.toThrow("RATE_LIMITED");
  });

  it("limits a session to eight new controls per minute while allowing idempotent replay, other students and normal teaching under their separate limits", async () => {
    const session = await register(); const other = await register(bob, "ENG002");
    const controls: { turn: string; paused: boolean; content: string; version: number }[] = [];
    for (let version = 0; version < 8; version++) {
      const entry = { turn: randomUUID(), paused: version % 2 === 0,
        content: version % 2 === 0 ? "暂停学习" : "继续学习", version };
      controls.push(entry);
      await control(session, entry.paused, entry.version, entry.turn, entry.content);
    }
    const before = await restore();
    await expect(control(session, true, 8)).rejects.toThrow("RATE_LIMITED");
    expect(await restore()).toEqual(before);
    expect(await scalar("select count(*)::int as result from english_assistant_learning_controls where session_id=$1", [session.id])).toBe(8);
    expect(await scalar("select count(*)::int as result from english_assistant_messages where session_id=$1", [session.id])).toBe(17);
    expect(before.request_count).toBe(0);
    expect(await scalar("select count(*)::int as result from english_assistant_request_events")).toBe(0);
    expect(await scalar("select count(*)::int as result from english_assistant_turns")).toBe(0);
    const first = controls[0];
    const replay = await control(session, first.paused, first.version, first.turn, first.content);
    expect(replay.english_paused).toBe(false); expect(replay.english_progress.version).toBe(8);
    await expect(control(session, false, 8, first.turn, first.content)).rejects.toThrow("TURN_CONFLICT");
    expect((await control(other, true, 0)).english_paused).toBe(true);
    const teachingTurn = randomUUID(); const started = await begin(session, 8, teachingTurn);
    const saved = await save(session, teachingTurn, started.lock_token, before.english_progress);
    expect(saved.english_progress).toEqual({ ...session.english_progress, version: 9 });
    expect((await restore()).request_count).toBe(1);
    expect(await scalar("select count(*)::int as result from english_assistant_learning_controls where session_id=$1", [session.id])).toBe(8);
  });

  it("permits a paused student to resume when the oldest event leaves the rolling minute window, with no permanent lifetime control cap", async () => {
    const session = await register(); const firstTurn = randomUUID();
    const actions = [true, false, true, false, true, false, false, true];
    for (let version = 0; version < actions.length; version++) {
      await control(session, actions[version], version, version === 0 ? firstTurn : randomUUID());
    }
    await expect(control(session, false, 8)).rejects.toThrow("RATE_LIMITED");
    expect((await restore()).english_paused).toBe(true);
    await pg.query("update english_assistant_learning_controls set created_at=now()-interval '61 seconds' where session_id=$1 and turn_id=$2", [session.id, firstTurn]);
    const resumed = await control(session, false, 8);
    expect(resumed.english_paused).toBe(false);
    expect(resumed.english_progress).toEqual({ ...session.english_progress, version: 9 });
    expect(await scalar("select count(*)::int as result from english_assistant_learning_controls where session_id=$1", [session.id])).toBe(9);
    expect(await scalar("select count(*)::int as result from english_assistant_learning_controls where session_id=$1 and created_at>now()-interval '1 minute'", [session.id])).toBe(8);
    expect((await restore()).request_count).toBe(0);
  });

  it("serializes competing controls at the eighth-event boundary without exceeding the independent event limit", async () => {
    const session = await register();
    for (let version = 0; version < 7; version++) await control(session, false, version);
    const results = await Promise.allSettled([control(session, true, 7), control(session, false, 7)]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect((results.find(result => result.status === "rejected") as PromiseRejectedResult).reason.message).toContain("ENGLISH_STATE_CONFLICT");
    expect(await scalar("select count(*)::int as result from english_assistant_learning_controls where session_id=$1", [session.id])).toBe(8);
    expect((await restore()).english_progress.version).toBe(8);
    await expect(control(session, false, 8)).rejects.toThrow("RATE_LIMITED");
  });

  it("does not let a control steal a live generation lease, and leaves the teaching request unchanged", async () => {
    const session = await register(); const turn = randomUUID(); const started = await begin(session, 0, turn);
    await expect(control(session, true, 0)).rejects.toThrow("BUSY");
    const restored = await restore(); expect(restored.lock_token).toBe(started.lock_token);
    expect(restored.english_paused).toBe(false); expect(restored.english_progress).toEqual(session.english_progress);
    expect(await scalar("select count(*)::int as result from english_assistant_learning_controls")).toBe(0);
    expect(await scalar("select count(*)::int as result from english_assistant_messages")).toBe(3);
    expect(await scalar("select status as result from english_assistant_messages where turn_id=$1 and role='assistant'", [turn])).toBe("pending");
  });

  it.each(["failed", "expired"])("bypasses a %s teaching pair for controls and permits its original teaching retry after resuming", async mode => {
    const session = await register(); const turn = randomUUID(); const started = await begin(session, 0, turn);
    if (mode === "failed") await save(session, turn, started.lock_token, session.english_progress, "failed");
    else await pg.query("update english_assistant_sessions set locked_until=now()-interval '1 second' where id=$1", [session.id]);
    const paused = await control(session, true, 0);
    expect(paused.english_progress).toEqual({ ...session.english_progress, version: 1 });
    expect((await restore()).lock_token).toBeNull();
    expect(await scalar("select status as result from english_assistant_messages where turn_id=$1 and role='assistant'", [turn])).toBe("failed");
    if (mode === "expired") expect(await scalar("select error_code as result from english_assistant_messages where turn_id=$1 and role='assistant'", [turn])).toBe("interrupted");
    const resumed = await control(session, false, 1);
    const retry = await begin(session, 2, turn);
    const saved = await save(session, turn, retry.lock_token, resumed.english_progress);
    expect(saved.english_progress).toEqual({ ...session.english_progress, version: 3 });
    expect((await restore()).request_count).toBe(2);
    expect(await scalar("select count(*)::int as result from english_assistant_messages where turn_id=$1 and role='user'", [turn])).toBe(1);
    expect(await scalar("select count(*)::int as result from english_assistant_turns")).toBe(1);
  });

  it("refuses to reinterpret a completed or failed teaching turn as a control", async () => {
    const session = await register(); const failedTurn = randomUUID(); const started = await begin(session, 0, failedTurn);
    await save(session, failedTurn, started.lock_token, session.english_progress, "failed");
    await expect(control(session, true, 0, failedTurn, "这里有学生证据。")).rejects.toThrow("TURN_CONFLICT");
    const retried = await begin(session, 0, failedTurn);
    await save(session, failedTurn, retried.lock_token, session.english_progress);
    await expect(control(session, true, 1, failedTurn, "这里有学生证据。")).rejects.toThrow("TURN_CONFLICT");
    expect(await scalar("select count(*)::int as result from english_assistant_learning_controls")).toBe(0);
  });

  it("serializes racing controls and teaching attempts without advancing an activity or starting generation after a pause", async () => {
    const session = await register();
    const race = await Promise.allSettled([control(session, true, 0), begin(session, 0)]);
    expect(race[0].status).toBe("fulfilled"); expect(race[1].status).toBe("rejected");
    expect((race[1] as PromiseRejectedResult).reason.message).toContain("ENGLISH_LEARNING_PAUSED");
    expect((await restore()).request_count).toBe(0);
    const duplicateTurn = randomUUID();
    const duplicate = await Promise.allSettled([control(session, false, 1, duplicateTurn), control(session, false, 1, duplicateTurn)]);
    expect(duplicate.every(result => result.status === "fulfilled")).toBe(true);
    expect((await restore()).english_progress.version).toBe(2);
    const conflicting = await Promise.allSettled([control(session, true, 2), control(session, false, 2)]);
    expect(conflicting.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect((conflicting.find(result => result.status === "rejected") as PromiseRejectedResult).reason.message).toContain("ENGLISH_STATE_CONFLICT");
    expect((await restore()).english_progress).toEqual({ ...session.english_progress, version: 3 });
  });

  it("rejects new controls after course completion while allowing an earlier completed control to replay the latest state", async () => {
    const session = await register(); const turn = randomUUID(); await control(session, true, 0, turn);
    const completed = { stage: "summary", step: 0, version: 20, completed: true };
    await pg.query("update english_assistant_sessions set english_progress=$1::jsonb where id=$2", [JSON.stringify(completed), session.id]);
    await expect(control(session, false, 20)).rejects.toThrow("ENGLISH_COMPLETED");
    const repeated = await control(session, true, 0, turn);
    expect(repeated.english_progress).toEqual(completed); expect(repeated.english_paused).toBe(true);
    expect(await scalar("select count(*)::int as result from english_assistant_learning_controls")).toBe(1);
  });

  it.each([
    ["stale version", { version: 1 }, "ENGLISH_STATE_CONFLICT"],
    ["missing version", { version: null }, "ENGLISH_STATE_CONFLICT"],
    ["wrong owner", { owner: bob }, "FORBIDDEN"],
    ["missing owner", { owner: null }, "FORBIDDEN"],
    ["missing turn", { turn: null }, "INVALID_ENGLISH_CONTROL"],
    ["missing action", { paused: null }, "INVALID_ENGLISH_CONTROL"],
    ["empty content", { content: "" }, "INVALID_CONTENT"],
    ["blank content", { content: "    " }, "INVALID_CONTENT"],
    ["long content", { content: "x".repeat(8001) }, "INVALID_CONTENT"],
  ] as [string, Record<string, unknown>, string][])("rejects %s without messages, controls or state changes", async (_name, values, error) => {
    const session = await register();
    const args = { paused: true as boolean | null, version: 0 as number | null, turn: randomUUID() as string | null,
      content: "暂停学习", owner: alice as string | null, ...values };
    await expect(control(session, args.paused, args.version, args.turn, args.content, args.owner)).rejects.toThrow(error);
    expect(await restore()).toEqual(session);
    expect(await scalar("select count(*)::int as result from english_assistant_messages")).toBe(1);
    expect(await scalar("select count(*)::int as result from english_assistant_learning_controls")).toBe(0);
  });

  it("rejects unknown sessions and a null owner in the teaching RPC as well as the control RPC", async () => {
    const session = await register();
    await expect(control({ ...session, id: randomUUID() }, true, 0)).rejects.toThrow("FORBIDDEN");
    await expect(scalar("select begin_english_turn($1::uuid,null,$2::uuid,'学生回复',0) as result", [session.id, randomUUID()])).rejects.toThrow("FORBIDDEN");
  });

  it("keeps the control audit private, limits control RPC execution to service_role and does not grant direct pause writes", async () => {
    const session = await register();
    for (const role of ["anon", "authenticated"]) {
      await pg.exec(`set role ${role}`);
      try {
        await expect(control(session, true, 0)).rejects.toThrow("permission denied");
        await expect(pg.query("select * from english_assistant_learning_controls")).rejects.toThrow("permission denied");
        await expect(pg.query("update english_assistant_sessions set english_paused=true where id=$1", [session.id])).rejects.toThrow("permission denied");
      } finally { await pg.exec("reset role"); }
    }
    await pg.exec("set role service_role");
    try {
      expect((await control(session, true, 0)).english_paused).toBe(true);
      expect((await pg.query("select * from english_assistant_learning_controls")).rows).toHaveLength(1);
      expect(await scalar("select english_paused as result from admin_english_conversation_records where id=$1", [session.id])).toBe(true);
    } finally { await pg.exec("reset role"); }
    expect(await scalar("select relrowsecurity as result from pg_class where oid='english_assistant_learning_controls'::regclass")).toBe(true);
  });

  it("cascades only a deleted English session's controls while preserving other controls and the independent deletion audit", async () => {
    const session = await register(); const other = await register(bob, "ENG002");
    await control(session, true, 0); await control(session, false, 1); await control(other, true, 0);
    await scalar("select admin_delete_english_conversation($1::uuid,$2::uuid) as result", [session.id, admin]);
    expect(await scalar("select count(*)::int as result from english_assistant_learning_controls where session_id=$1", [session.id])).toBe(0);
    expect(await scalar("select count(*)::int as result from english_assistant_learning_controls where session_id=$1", [other.id])).toBe(1);
    expect(await scalar("select messages_count::int as result from english_assistant_delete_audit where conversation_id=$1", [session.id])).toBe(5);
    const fresh = await register(); expect(fresh.english_paused).toBe(false);
    expect(fresh.english_progress).toEqual(session.english_progress);
  });
});

describe("safe 008 upgrades and initialization", () => {
  it("preserves actual pre-008 teaching history and snapshots through repeat installation and appends the pause view column without changing prior view options", async () => {
    const legacy = new PGlite();
    try {
      await prepare(legacy, false); await source(legacy);
      const session = await register(alice, "OLD001", legacy);
      const turn = randomUUID(); const started = await begin(session, 0, turn, "这里有学生证据。", legacy);
      await save(session, turn, started.lock_token, session.english_progress, "complete", legacy);
      const before = await restore(alice, legacy);
      const messages = await scalar("select jsonb_agg(to_jsonb(m) order by sequence) as result from english_assistant_messages m", [], legacy);
      const turns = await scalar("select jsonb_agg(to_jsonb(t)) as result from english_assistant_turns t", [], legacy);
      const config = await scalar("select jsonb_agg(to_jsonb(c)) as result from english_assistant_configs c", [], legacy);
      const columns = (await legacy.query<{ column_name: string }>("select column_name from information_schema.columns where table_schema='public' and table_name='admin_english_conversation_records' order by ordinal_position")).rows.map(row => row.column_name);
      await legacy.exec("alter view admin_english_conversation_records set (security_invoker=true)");
      const options = await scalar("select reloptions as result from pg_class where oid='admin_english_conversation_records'::regclass", [], legacy);
      const migration = await readFile(migrationFile, "utf8"); await legacy.exec(migration); await legacy.exec(migration);
      expect(await restore(alice, legacy)).toEqual({ ...before, english_paused: false });
      expect(await scalar("select jsonb_agg(to_jsonb(m) order by sequence) as result from english_assistant_messages m", [], legacy)).toEqual(messages);
      expect(await scalar("select jsonb_agg(to_jsonb(t)) as result from english_assistant_turns t", [], legacy)).toEqual(turns);
      expect(await scalar("select jsonb_agg(to_jsonb(c)) as result from english_assistant_configs c", [], legacy)).toEqual(config);
      expect(await scalar("select reloptions as result from pg_class where oid='admin_english_conversation_records'::regclass", [], legacy)).toEqual(options);
      expect((await legacy.query<{ column_name: string }>("select column_name from information_schema.columns where table_schema='public' and table_name='admin_english_conversation_records' order by ordinal_position")).rows.map(row => row.column_name)).toEqual([...columns, "english_paused"]);
      expect(await scalar("select count(*)::int as result from english_assistant_learning_controls", [], legacy)).toBe(0);
      expect((await control(session, true, 1, randomUUID(), "暂停学习", alice, legacy)).english_paused).toBe(true);
    } finally { await legacy.close(); }
  }, 60000);

  it("includes the exact 008 migration and installs a working pause control in a fresh empty project", async () => {
    const init = await readFile("supabase/new_project_init.sql", "utf8");
    const migration = await readFile(migrationFile, "utf8");
    expect(init.replace(/\r\n/g, "\n")).toContain(migration.replace(/\r\n/g, "\n").trim());
    expect(migration.trim()).toMatch(/notify pgrst, 'reload schema';$/);
    const fresh = new PGlite();
    try {
      await auth(fresh); await fresh.exec(init); await identities(fresh); await source(fresh);
      const session = await register(alice, "FRESH001", fresh); expect(session.english_paused).toBe(false);
      expect((await control(session, true, 0, randomUUID(), "不想学了", alice, fresh)).english_paused).toBe(true);
      await expect(begin(session, 1, randomUUID(), "回复当前题目", fresh)).rejects.toThrow("ENGLISH_LEARNING_PAUSED");
    } finally { await fresh.close(); }
  }, 60000);
});
