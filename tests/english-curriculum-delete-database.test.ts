import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { defaultExperiment } from "@/lib/experiment";

const admin = "00000000-0000-4000-8000-000000000001";
const owners = Array.from({ length: 8 }, (_, index) => `00000000-0000-4000-8000-${String(index + 2).padStart(12, "0")}`);
const stages = ["bridge", "objectives", "pre_assessment", "participatory", "post_assessment", "summary"] as const;
const files = ["001_studychat.sql", "002_factorial_experiment.sql", "003_admin_delete_conversation.sql",
  "004_question_mode.sql", "005_english_assistant.sql", "006_english_groups.sql"];
const migrationFile = "supabase/migrations/007_english_curriculum_and_delete.sql";
type Activity = { title: string; prompt: string; criterion: string; word_limit?: null | { min: number; max: number } };
type Curriculum = Record<(typeof stages)[number], { description: string; activities: Activity[] }>;
type Progress = { stage: string; step: number; version: number; completed: boolean };
let pg: PGlite;

function curriculum(lengths: number[] = [1, 1, 1, 1, 1, 1]): Curriculum {
  return Object.fromEntries(stages.map((stage, index) => [stage, {
    description: `可编辑的${stage}阶段说明`,
    activities: Array.from({ length: lengths[index] }, (_, step) => ({
      title: `${stage}任务${step + 1}`, prompt: `请完成${stage}的第${step + 1}项活动。`,
      criterion: `需要回答当前${stage}活动并提供对应内容。`,
    })),
  }])) as Curriculum;
}
function changed(change: (course: Curriculum) => void): Curriculum {
  const course = curriculum(); change(course); return course;
}
async function scalar<T = any>(sql: string, params: unknown[] = [], database = pg): Promise<T> {
  return (await database.query<{ result: T }>(sql, params)).rows[0]?.result;
}
async function prepare(database: PGlite, latest = true) {
  await database.exec("create schema auth; create role anon; create role authenticated; create role service_role bypassrls; create table auth.users(id uuid primary key); create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$; grant usage on schema auth,public to authenticated,anon,service_role;");
  for (const file of files) await database.exec(await readFile("supabase/migrations/" + file, "utf8"));
  if (latest) await database.exec(await readFile(migrationFile, "utf8"));
  await database.query("insert into auth.users(id) select unnest($1::uuid[])", [[admin, ...owners]]);
  await database.query("insert into admin_users(user_id) values($1)", [admin]);
}
async function source(database = pg) {
  const settings = defaultExperiment();
  settings.personality_prompt = "原模型连接继承人格";
  settings.connections.deepseek.model = "shared-deepseek";
  settings.connections.chatgpt.model = "unrelated-bloom-model";
  return scalar("select publish_experiment($1::jsonb,$2::jsonb,$3::uuid,0,true) as result",
    [JSON.stringify(settings), JSON.stringify({ deepseek: "test-d-cipher", chatgpt: "test-c-cipher" }), admin], database);
}
async function publish(course: unknown = curriculum(), revision: number | null = 0, actor = admin, database = pg) {
  return scalar("select publish_english_course($1::uuid,$2::bigint,true,'英语公开说明','英语基础提示词','英语人格提示词',$3::jsonb) as result",
    [actor, revision, course === undefined ? null : JSON.stringify(course)], database);
}
async function register(owner = owners[0], student = "ENG001", revision: number | null = null, database = pg) {
  return scalar("select register_english_session($1::uuid,$2,'自定义课程的首条任务',$3::bigint) as result", [owner, student, revision], database);
}
async function restore(owner = owners[0], database = pg) {
  return scalar("select restore_english_session($1::uuid) as result", [owner], database);
}
async function snapshot(id: string, database = pg) {
  return scalar("select to_jsonb(c) as result from english_assistant_configs c where id=$1::uuid", [id], database);
}
async function begin(session: any, state: Progress, turn = randomUUID(), database = pg) {
  await database.query("delete from english_assistant_request_events where session_id=$1", [session.id]);
  return scalar("select begin_english_turn($1::uuid,$2::uuid,$3::uuid,'这是一份可引用的学生证据，观点清楚。',$4) as result",
    [session.id, session.owner_id, turn, state.version], database);
}
async function finish(session: any, turn: string, lease: string, state: Progress, achieved = true,
  evidence = "学生证据", database = pg) {
  return scalar("select save_english_reply($1::uuid,$2::uuid,$3::uuid,$4::jsonb,$5::jsonb,'当前活动的反馈与下一项任务。') as result",
    [session.id, turn, lease, JSON.stringify(state), JSON.stringify({ achieved, evidence, feedback: "针对当前活动给出反馈。" })], database);
}
async function remove(id: string, actor = admin, database = pg) {
  return scalar("select admin_delete_english_conversation($1::uuid,$2::uuid) as result", [id, actor], database);
}

beforeAll(async () => { pg = new PGlite(); await prepare(pg); }, 60000);
beforeEach(async () => {
  await pg.exec("reset role; truncate english_assistant_delete_audit,english_assistant_state,english_assistant_configs,study_state,experiment_versions,config_versions,conversations restart identity cascade; insert into study_state(id) values(1); insert into english_assistant_state(id) values(1);");
  await source();
});
afterAll(async () => { await pg?.close(); });

describe("strict English curriculum publication and snapshots", () => {
  it("accepts optional null word limits, integer ranges and the total activity boundary through service-only publication", async () => {
    const course = curriculum([4, 4, 4, 4, 4, 4]);
    course.bridge.activities[0].word_limit = null;
    course.bridge.activities[1].word_limit = { min: 1, max: 1000 };
    await pg.exec("set role service_role");
    try {
      const published = await publish(course);
      expect(published.curriculum).toEqual(course);
      expect(published.revision).toBe(1);
      expect((await register(owners[0], "ENG001", 1)).student_id).toBe("ENG001");
    } finally { await pg.exec("reset role"); }
    expect(await scalar("select enabled as result from study_state")).toBe(true);
  });

  const invalidCourses: [string, unknown][] = [
    ["null", null], ["array", []], ["missing stage", changed(c => { delete (c as any).summary; })],
    ["extra stage", { ...curriculum(), other_stage: curriculum().bridge }],
    ["stage scalar", changed(c => { (c as any).bridge = "bridge"; })],
    ["extra stage field", changed(c => { (c.bridge as any).order = 1; })],
    ["missing description", changed(c => { delete (c.bridge as any).description; })],
    ["empty description", changed(c => { c.bridge.description = "   "; })],
    ["long description", changed(c => { c.bridge.description = "中".repeat(301); })],
    ["description type", changed(c => { (c.bridge as any).description = 1; })],
    ["no activities", changed(c => { c.bridge.activities = []; })],
    ["nine activities", curriculum([9, 1, 1, 1, 1, 1])],
    ["twenty-five activities", curriculum([5, 4, 4, 4, 4, 4])],
    ["activities type", changed(c => { (c.bridge as any).activities = {}; })],
    ["activity scalar", changed(c => { (c.bridge.activities as any)[0] = 1; })],
    ["extra activity field", changed(c => { (c.bridge.activities[0] as any).skip = true; })],
    ["missing criterion", changed(c => { delete (c.bridge.activities[0] as any).criterion; })],
    ["empty title", changed(c => { c.bridge.activities[0].title = "  "; })],
    ["long title", changed(c => { c.bridge.activities[0].title = "x".repeat(121); })],
    ["long prompt", changed(c => { c.bridge.activities[0].prompt = "x".repeat(4001); })],
    ["long criterion", changed(c => { c.bridge.activities[0].criterion = "x".repeat(2001); })],
    ["prompt type", changed(c => { (c.bridge.activities[0] as any).prompt = false; })],
    ["word limit scalar", changed(c => { (c.bridge.activities[0] as any).word_limit = 10; })],
    ["word limit missing max", changed(c => { (c.bridge.activities[0] as any).word_limit = { min: 1 }; })],
    ["word limit extra field", changed(c => { (c.bridge.activities[0] as any).word_limit = { min: 1, max: 10, count: 2 }; })],
    ["word limit string", changed(c => { (c.bridge.activities[0] as any).word_limit = { min: "1", max: 10 }; })],
    ["word limit fractional", changed(c => { c.bridge.activities[0].word_limit = { min: 1.5, max: 10 }; })],
    ["word limit zero", changed(c => { c.bridge.activities[0].word_limit = { min: 0, max: 10 }; })],
    ["word limit too large", changed(c => { c.bridge.activities[0].word_limit = { min: 1, max: 1001 }; })],
    ["word limit reverse range", changed(c => { c.bridge.activities[0].word_limit = { min: 20, max: 10 }; })],
  ];
  it.each(invalidCourses)("rejects %s without publishing or incrementing the course revision", async (_name, course) => {
    await expect(publish(course)).rejects.toThrow("INVALID_ENGLISH_COURSE");
    expect(await scalar("select revision::int as result from english_assistant_state")).toBe(0);
    expect(await scalar("select curriculum as result from english_assistant_state")).toBeNull();
  });

  it("guards table-level curriculum integrity while preserving null legacy snapshots", async () => {
    const first = await register();
    expect((await snapshot(first.config_id)).curriculum).toBeNull();
    await expect(pg.query("update english_assistant_state set curriculum='{}'::jsonb")).rejects.toThrow("english_assistant_state_curriculum");
    await expect(pg.query("update english_assistant_configs set curriculum='{}'::jsonb where id=$1", [first.config_id])).rejects.toThrow("english_assistant_configs_curriculum");
    await expect(scalar("select publish_english_course($1::uuid,0,true,'公开说明','基础提示','人格提示',null) as result", [admin])).rejects.toThrow("INVALID_ENGLISH_COURSE");
    expect(await scalar("select to_regprocedure('public.publish_english_course(uuid,bigint,boolean,text,text,text)')::text as result")).toBeNull();
    expect(await scalar("select to_regprocedure('public.register_english_session(uuid,text,text)')::text as result")).toBeNull();
    const compatible = await scalar("select register_english_session($1::uuid,'ENG002','旧三参调用仍可工作') as result", [owners[1]]);
    expect(compatible.student_id).toBe("ENG002");
  });

  it("serializes competing publications and rejects stale or missing revision and non-admin actors", async () => {
    await expect(publish(curriculum(), null)).rejects.toThrow("CONFLICT");
    await expect(publish(curriculum(), 0, owners[0])).rejects.toThrow("FORBIDDEN");
    const results = await Promise.allSettled([publish(curriculum()), publish(curriculum([2, 2, 2, 2, 2, 2]))]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(result => result.status === "rejected")).toHaveLength(1);
    expect((results.find(result => result.status === "rejected") as PromiseRejectedResult).reason.message).toContain("CONFLICT");
    expect(await scalar("select revision::int as result from english_assistant_state")).toBe(1);
  });

  it("detects course registration races, freezes curriculum revisions and restores existing bindings before checking a stale expected revision", async () => {
    const firstCourse = curriculum(); await publish(firstCourse);
    await expect(register(owners[0], "ENG001", 0)).rejects.toThrow("CONFLICT");
    expect(await scalar("select count(*)::int as result from english_assistant_configs")).toBe(0);
    expect(await scalar("select count(*)::int as result from english_assistant_messages")).toBe(0);
    const first = await register(owners[0], "ENG001", 1);
    const frozen = await snapshot(first.config_id);
    expect(frozen.curriculum).toEqual(firstCourse); expect(frozen.prompt_revision).toBe(1);
    const secondCourse = curriculum([2, 2, 2, 2, 2, 2]); await publish(secondCourse, 1);
    const restored = await register(owners[0], "ENG001", 0);
    expect(restored.id).toBe(first.id); expect(restored.config_id).toBe(first.config_id);
    expect(await snapshot(first.config_id)).toEqual(frozen);
    await expect(register(owners[1], "ENG002", 1)).rejects.toThrow("CONFLICT");
    const second = await register(owners[1], "ENG002", 2);
    expect((await snapshot(second.config_id)).curriculum).toEqual(secondCourse);
    expect((await snapshot(second.config_id)).prompt_revision).toBe(2);
    await expect(register(owners[0], "DIFFERENT", 0)).rejects.toThrow("IDENTITY_BOUND");
  });

  it("orders publication and registration under one English state lock so a stale opening cannot create a mismatched snapshot", async () => {
    const results = await Promise.allSettled([publish(curriculum()), register(owners[0], "ENG001", 0)]);
    expect(results[0].status).toBe("fulfilled"); expect(results[1].status).toBe("rejected");
    expect((results[1] as PromiseRejectedResult).reason.message).toContain("CONFLICT");
    expect(await scalar("select count(*)::int as result from english_assistant_sessions")).toBe(0);
  });
});

describe("snapshot-controlled dynamic BOPPPS activity progression", () => {
  it.each([
    [[1, 1, 1, 1, 1, 1], ["bridge:0", "objectives:0", "pre_assessment:0", "participatory:0", "post_assessment:0", "summary:0"]],
    [[2, 2, 2, 2, 2, 2], ["bridge:0", "bridge:1", "objectives:0", "objectives:1", "pre_assessment:0", "pre_assessment:1",
      "participatory:0", "participatory:1", "post_assessment:0", "post_assessment:1", "summary:0", "summary:1"]],
  ] as [number[], string[]][])("completes all activities for lengths %j without skipping any stage or final summary task", async (lengths, expected) => {
    await publish(curriculum(lengths));
    const session = await register(owners[0], "ENG001", 1);
    // A later publication must not change the enrolled student's task count.
    await publish(curriculum([3, 3, 3, 3, 3, 3]), 1);
    let state: Progress = session.english_progress; const seen: string[] = [];
    for (let index = 0; index < expected.length; index++) {
      seen.push(state.stage + ":" + state.step);
      const turn = randomUUID(); const acquired = await begin(session, state, turn);
      const saved = await finish(session, turn, acquired.lock_token, state);
      expect(saved.english_progress.version).toBe(index + 1);
      expect(saved.english_progress.completed).toBe(index === expected.length - 1);
      const repeated = await begin(session, state, turn);
      expect(repeated.state).toBe("complete"); expect(repeated.english_progress).toEqual(saved.english_progress);
      state = saved.english_progress;
    }
    expect(seen).toEqual(expected);
    expect(state).toEqual({ stage: "summary", step: lengths[5] - 1, version: expected.length, completed: true });
    expect(await scalar("select count(*)::int as result from english_assistant_turns")).toBe(expected.length);
    await expect(begin(session, state)).rejects.toThrow("ENGLISH_COMPLETED");
  });

  it("keeps failed criteria in place, rejects forged evidence and stale leases, and validates the custom activity index", async () => {
    await publish(curriculum()); const session = await register();
    const state = { stage: "participatory", step: 0, version: 3, completed: false };
    await pg.query("update english_assistant_sessions set english_progress=$1::jsonb where id=$2", [JSON.stringify(state), session.id]);
    const turn = randomUUID(); const acquired = await begin(session, state, turn);
    await expect(finish(session, turn, acquired.lock_token, state, true, "不在学生回复里的证据")).rejects.toThrow("INVALID_ENGLISH_ASSESSMENT");
    await expect(finish(session, turn, acquired.lock_token, state, true, "")).rejects.toThrow("INVALID_ENGLISH_ASSESSMENT");
    await expect(finish(session, turn, randomUUID(), state)).rejects.toThrow("STALE_LEASE");
    await expect(finish(session, turn, acquired.lock_token, { ...state, version: 4 })).rejects.toThrow("ENGLISH_STATE_CONFLICT");
    const failed = await finish(session, turn, acquired.lock_token, state, false, "");
    expect(failed.english_progress).toEqual({ ...state, version: 4 });
    const badState = { ...state, step: 1, version: 4 };
    await pg.query("update english_assistant_sessions set english_progress=$1::jsonb where id=$2", [JSON.stringify(badState), session.id]);
    const another = randomUUID(); const invalid = await begin(session, badState, another);
    await expect(finish(session, another, invalid.lock_token, badState)).rejects.toThrow("ENGLISH_STATE_CONFLICT");
  });
});

describe("independent audited English conversation deletion", () => {
  it("deletes only the selected English history, cascades dependent rows, releases identity and adjusts counts while preserving Bloom", async () => {
    await publish();
    const session = await register(); const other = await register(owners[1], "ENG002");
    const bloom = await scalar("select to_jsonb(register_participant($1::uuid,'ENG001')) as result", [owners[0]]);
    const state = session.english_progress; const turn = randomUUID(); const acquired = await begin(session, state, turn);
    await finish(session, turn, acquired.lock_token, state);
    const beforeBloom = await scalar("select to_jsonb(c) as result from conversations c where id=$1", [bloom.id]);
    const beforeBloomCounts = await scalar("select jsonb_agg(to_jsonb(g)) as result from experiment_group_counts() g");
    const beforeSource = await scalar("select jsonb_agg(to_jsonb(e)) as result from experiment_versions e");
    const beforeCounts = await scalar("select sum(enrolled)::int as result from english_group_counts()");
    expect(await remove(session.id)).toBe(session.id);
    expect(await restore()).toBeNull(); expect((await restore(owners[1])).id).toBe(other.id);
    for (const table of ["english_assistant_messages", "english_assistant_request_events", "english_assistant_turns"]) {
      expect(await scalar(`select count(*)::int as result from ${table} where session_id=$1`, [session.id])).toBe(0);
    }
    expect(await snapshot(session.config_id)).toBeUndefined();
    expect(await scalar("select sum(enrolled)::int as result from english_group_counts()")).toBe(beforeCounts - 1);
    expect(await scalar("select to_jsonb(c) as result from conversations c where id=$1", [bloom.id])).toEqual(beforeBloom);
    expect(await scalar("select jsonb_agg(to_jsonb(g)) as result from experiment_group_counts() g")).toEqual(beforeBloomCounts);
    expect(await scalar("select jsonb_agg(to_jsonb(e)) as result from experiment_versions e")).toEqual(beforeSource);
    expect(await scalar("select count(*)::int as result from participant_enrollments where conversation_id=$1", [bloom.id])).toBe(1);
    expect(await scalar("select count(*)::int as result from auth.users where id=$1", [owners[0]])).toBe(1);
    const audit = await scalar("select to_jsonb(a) as result from english_assistant_delete_audit a");
    expect(audit).toMatchObject({ conversation_id: session.id, deleted_by: admin, student_id: "ENG001",
      participant_code: session.participant_code, group_code: session.group_code, prompt_revision: 1, messages_count: 3 });
    expect(Object.keys(audit).sort()).toEqual(["id", "conversation_id", "deleted_by", "deleted_at", "student_id",
      "participant_code", "group_code", "prompt_revision", "messages_count"].sort());
    expect(JSON.stringify(audit)).not.toMatch(/学生证据|反馈|cipher|base_prompt|personality_prompt|curriculum/);
    const fresh = await register(owners[0], "ENG001", 1);
    expect(fresh.id).not.toBe(session.id); expect(fresh.english_progress.version).toBe(0);
    expect(await scalar("select sum(enrolled)::int as result from english_group_counts()")).toBe(beforeCounts);
  });

  it("refuses missing conversations, non-admin actors and active generation leases without deleting any data or writing an audit", async () => {
    const session = await register();
    await expect(remove(session.id, owners[0])).rejects.toThrow("FORBIDDEN");
    await expect(remove(randomUUID())).rejects.toThrow("CONVERSATION_NOT_FOUND");
    await expect(remove((await scalar("select to_jsonb(register_participant($1::uuid,'BLOOM2')) as result", [owners[1]])).id)).rejects.toThrow("CONVERSATION_NOT_FOUND");
    const turn = randomUUID(); await begin(session, session.english_progress, turn);
    await expect(remove(session.id)).rejects.toThrow("CONVERSATION_BUSY");
    expect((await restore()).id).toBe(session.id);
    expect(await scalar("select count(*)::int as result from english_assistant_delete_audit")).toBe(0);
    expect(await scalar("select count(*)::int as result from english_assistant_messages where session_id=$1", [session.id])).toBe(3);
    await pg.query("update english_assistant_sessions set locked_until=now()-interval '1 second' where id=$1", [session.id]);
    expect(await remove(session.id)).toBe(session.id);
    expect(await scalar("select messages_count::int as result from english_assistant_delete_audit")).toBe(3);
    await expect(remove(session.id)).rejects.toThrow("CONVERSATION_NOT_FOUND");
  });

  it("preserves published legacy configurations and shared snapshots, then cleans an orphan only after its last session is deleted", async () => {
    const first = await register(); const second = await register(owners[1], "ENG002");
    const secondConfig = second.config_id;
    await pg.query("update english_assistant_sessions set config_id=$1 where id=$2", [first.config_id, second.id]);
    await remove(first.id);
    expect((await snapshot(first.config_id)).id).toBe(first.config_id);
    expect((await snapshot(secondConfig)).id).toBe(secondConfig);
    await remove(second.id);
    expect(await snapshot(first.config_id)).toBeUndefined();
    const legacy = await register(owners[2], "LEGACY1");
    await pg.query("update english_assistant_state set active_config_id=$1", [legacy.config_id]);
    await remove(legacy.id);
    expect((await snapshot(legacy.config_id)).id).toBe(legacy.config_id);
    expect(await scalar("select active_config_id as result from english_assistant_state")).toBe(legacy.config_id);
  });

  it("keeps audit and curriculum private and grants mutation RPCs only to service_role", async () => {
    const session = await register();
    for (const role of ["anon", "authenticated"]) {
      await pg.exec(`set role ${role}`);
      try {
        await expect(remove(session.id)).rejects.toThrow("permission denied");
        await expect(publish()).rejects.toThrow("permission denied");
        await expect(register(owners[1], "ENG002", 0)).rejects.toThrow("permission denied");
        await expect(pg.query("select * from english_assistant_delete_audit")).rejects.toThrow("permission denied");
        await expect(pg.query("select curriculum from english_assistant_configs")).rejects.toThrow("permission denied");
        await expect(pg.query("select curriculum from english_assistant_state")).rejects.toThrow("permission denied");
        await expect(pg.query("insert into english_assistant_delete_audit(conversation_id,deleted_by,student_id,participant_code,messages_count) values($1,$2,'FAKE','FAKE',0)", [session.id, admin])).rejects.toThrow("permission denied");
      } finally { await pg.exec("reset role"); }
    }
    await pg.exec("set role service_role");
    try {
      await expect(remove(session.id, owners[0])).rejects.toThrow("FORBIDDEN");
      expect(await remove(session.id)).toBe(session.id);
      expect((await pg.query("select * from english_assistant_delete_audit")).rows).toHaveLength(1);
    } finally { await pg.exec("reset role"); }
    const listColumns = (await pg.query<{ column_name: string }>("select column_name from information_schema.columns where table_schema='public' and table_name='admin_english_conversation_records'")).rows.map(row => row.column_name);
    expect(listColumns).not.toContain("curriculum");
    expect(await scalar("select relrowsecurity as result from pg_class where oid='english_assistant_delete_audit'::regclass")).toBe(true);
  });
});

describe("repeatable 007 upgrades and fresh initialization", () => {
  it("preserves actual pre-007 course, sessions, messages and assessments and keeps null snapshots on the original activity lengths", async () => {
    const legacy = new PGlite();
    try {
      await prepare(legacy, false); await source(legacy);
      const session = await scalar("select register_english_session($1::uuid,'OLD001','旧版固定首条任务') as result", [owners[0]], legacy);
      const prior: Progress = { stage: "pre_assessment", step: 1, version: 3, completed: false };
      await legacy.query("update english_assistant_sessions set english_progress=$1::jsonb where id=$2", [JSON.stringify(prior), session.id]);
      const firstTurn = randomUUID(); const acquired = await begin(session, prior, firstTurn, legacy);
      await finish(session, firstTurn, acquired.lock_token, prior, true, "学生证据", legacy);
      const beforeSession = await restore(owners[0], legacy); const beforeConfig = await snapshot(session.config_id, legacy);
      const beforeMessages = await scalar("select jsonb_agg(to_jsonb(m) order by sequence) as result from english_assistant_messages m", [], legacy);
      const beforeTurns = await scalar("select jsonb_agg(to_jsonb(t)) as result from english_assistant_turns t", [], legacy);
      const migration = await readFile(migrationFile, "utf8"); await legacy.exec(migration); await legacy.exec(migration);
      expect(await restore(owners[0], legacy)).toEqual(beforeSession);
      expect(await snapshot(session.config_id, legacy)).toEqual({ ...beforeConfig, curriculum: null });
      expect(await scalar("select jsonb_agg(to_jsonb(m) order by sequence) as result from english_assistant_messages m", [], legacy)).toEqual(beforeMessages);
      expect(await scalar("select jsonb_agg(to_jsonb(t)) as result from english_assistant_turns t", [], legacy)).toEqual(beforeTurns);
      await publish(curriculum(), 0, admin, legacy);
      const turn = randomUUID(); const started = await begin(session, beforeSession.english_progress, turn, legacy);
      const saved = await finish(session, turn, started.lock_token, beforeSession.english_progress, true, "学生证据", legacy);
      expect(saved.english_progress).toEqual({ stage: "participatory", step: 0, version: 5, completed: false });
      expect((await snapshot(session.config_id, legacy)).curriculum).toBeNull();
      expect(await scalar("select count(*)::int as result from english_assistant_delete_audit", [], legacy)).toBe(0);
    } finally { await legacy.close(); }
  }, 60000);

  it("includes the exact 007 migration and installs a working course publisher and deletion RPC in an empty project", async () => {
    const init = await readFile("supabase/new_project_init.sql", "utf8");
    const migration = await readFile(migrationFile, "utf8");
    expect(init.replace(/\r\n/g, "\n")).toContain(migration.replace(/\r\n/g, "\n").trim());
    expect(migration.trim()).toMatch(/notify pgrst, 'reload schema';$/);
    const fresh = new PGlite();
    try {
      await fresh.exec("create schema auth; create role anon; create role authenticated; create role service_role bypassrls; create table auth.users(id uuid primary key); create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$; grant usage on schema auth,public to authenticated,anon,service_role;");
      await fresh.exec(init);
      await fresh.query("insert into auth.users(id) values($1),($2)", [admin, owners[0]]);
      await fresh.query("insert into admin_users(user_id) values($1)", [admin]);
      await source(fresh); await publish(curriculum(), 0, admin, fresh);
      const session = await register(owners[0], "FRESH001", 1, fresh);
      expect((await snapshot(session.config_id, fresh)).curriculum).toEqual(curriculum());
      expect(await remove(session.id, admin, fresh)).toBe(session.id);
    } finally { await fresh.close(); }
  }, 60000);
});
