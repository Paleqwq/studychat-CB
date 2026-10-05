import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { defaultExperiment } from "@/lib/experiment";
import { defaultQuestionMode, nextQuestionProgress, type QuestionProgress } from "@/lib/question-mode";

type AppUser = { id: string; cloudbase_subject: string | null; created_at: string };
let pg: PGlite;
let admin: AppUser, alice: AppUser, bob: AppUser;
let nativeDefinitions: unknown;

async function scalar<T = any>(sql: string, params: unknown[] = []): Promise<T> {
  return (await pg.query<{ result: T }>(sql, params)).rows[0]?.result;
}
async function identity(subject: string) {
  return scalar<AppUser>("select get_or_create_app_user($1) as result", [subject]);
}
async function claims(subject: string, role = "authenticated") {
  await pg.query("select set_config('request.jwt.claims',$1,false)", [JSON.stringify({ sub: subject, role })]);
}
async function bloom(owner = alice, student = "CB001") {
  return scalar("select to_jsonb(register_participant($1::uuid,$2)) as result", [owner.id, student]);
}
async function english(owner = alice, student = "CB001") {
  return scalar("select register_english_session($1::uuid,$2,'请开始当前英语活动',0) as result", [owner.id, student]);
}
async function restoreEnglish(owner = alice) {
  return scalar("select restore_english_session($1::uuid) as result", [owner.id]);
}
async function pause(session: any, paused: boolean, version: number, turn = randomUUID(), owner = alice) {
  return scalar("select set_english_learning_pause($1::uuid,$2::uuid,$3::uuid,$4,$5,$6) as result",
    [session.id, owner.id, turn, paused ? "不想学了" : "继续学习", version, paused]);
}
async function beginEnglish(session: any, version: number, turn = randomUUID(), owner = alice) {
  return scalar("select begin_english_turn($1::uuid,$2::uuid,$3::uuid,'这是当前活动的回答',$4) as result",
    [session.id, owner.id, turn, version]);
}
async function nativeFunctions() {
  return scalar("select jsonb_agg(jsonb_build_object('oid',p.oid,'definition',pg_get_functiondef(p.oid)) order by p.oid) as result from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='auth'");
}

beforeAll(async () => {
  pg = new PGlite();
  // CloudBase owns these roles and auth helpers. In PG mode the actual user ID
  // and native auth.uid() are TEXT, not Supabase UUIDs. Never replace these.
  await pg.exec(`create schema auth; create role anon; create role authenticated;
    create role service_role bypassrls; create role cloudbase_postgres bypassrls;
    create table auth.users(id text primary key);
    create function auth.jwt() returns jsonb language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb $$;
    create function auth.uid() returns text language sql stable as $$ select auth.jwt()->>'sub' $$;
    create function auth.role() returns text language sql stable as $$ select auth.jwt()->>'role' $$;
    grant usage on schema auth,public to authenticated,anon,service_role;
    insert into auth.users values('platform-owned-user');
    alter default privileges grant select on tables to public;`);
  nativeDefinitions = await nativeFunctions();
  await pg.exec(await readFile("cloudbase/new_project_init.sql", "utf8"));
}, 60000);
beforeEach(async () => {
  await pg.exec(`reset role; select set_config('request.jwt.claims','{}',false);
    truncate app_identity_link_audit,app_users,english_assistant_delete_audit,
      english_assistant_state,english_assistant_configs,study_state,experiment_versions,
      config_versions,conversations restart identity cascade;
    insert into study_state(id) values(1); insert into english_assistant_state(id) values(1);`);
  admin = await identity("cloudbase-admin-subject");
  alice = await identity("cloudbase-alice-subject");
  bob = await identity("cloudbase-bob-subject");
  await pg.query("insert into admin_users(user_id) values($1)", [admin.id]);
  const settings = defaultExperiment();
  settings.personality_prompt = "研究者设定的共享人格材料";
  settings.connections.deepseek.model = "shared-deepseek-test";
  settings.connections.chatgpt.model = "bloom-other-model";
  await scalar("select publish_experiment($1::jsonb,$2::jsonb,$3::uuid,0,true) as result",
    [JSON.stringify(settings), JSON.stringify({ deepseek: "encrypted-d", chatgpt: "encrypted-c" }), admin.id]);
});
afterAll(async () => { await pg?.close(); });

describe("CloudBase native auth and internal UUID mapping", () => {
  it("installs the full reviewed schema without changing native auth functions, users or role attributes", async () => {
    const source = await readFile("cloudbase/new_project_init.sql", "utf8");
    expect(source).toMatch(/DO \$studychat_init\$/);
    expect(source.trim()).toMatch(/\$studychat_init\$;$/);
    expect(source.match(/^begin;$/gm)).toBeNull();
    expect(source.match(/^commit;$/gm)).toBeNull();
    expect(await nativeFunctions()).toEqual(nativeDefinitions);
    expect(await scalar("select id as result from auth.users")).toBe("platform-owned-user");
    expect(await scalar("select pg_get_function_result('auth.uid()'::regprocedure) as result")).toBe("text");
    expect(await scalar("select rolbypassrls as result from pg_roles where rolname='service_role'")).toBe(true);
    expect(await scalar("select count(*)::int as result from information_schema.table_constraints where constraint_type='FOREIGN KEY' and table_schema='public'")).toBeGreaterThan(20);
    expect(await scalar("select count(*)::int as result from information_schema.constraint_column_usage where table_schema='auth' and table_name='users' and constraint_schema='public'")).toBe(0);
    execFileSync(process.execPath, ["cloudbase/scripts/build-schema.mjs", "--check"], { encoding: "utf8" });
  });

  it("maps a verified text subject idempotently, serializes duplicate registration and never treats a UUID subject as the business UUID", async () => {
    expect(await identity(alice.cloudbase_subject!)).toEqual(alice);
    const subject = `native-${randomUUID()}`;
    const results = await Promise.all([identity(subject), identity(subject)]);
    expect(results[0]).toEqual(results[1]);
    expect(results[0].id).toMatch(/^[\da-f-]{36}$/);
    expect(results[0].id).not.toBe(subject);
    expect(await scalar("select count(*)::int as result from app_users where cloudbase_subject=$1", [subject])).toBe(1);
    const uuidSubject = randomUUID();
    const mapped = await identity(uuidSubject); expect(mapped.id).not.toBe(uuidSubject);
    await claims(uuidSubject); expect(await scalar("select app_current_user_id() as result")).toBe(mapped.id);
    await claims(alice.id); expect(await scalar("select app_current_user_id() as result")).toBeNull();
  });

  it.each([null, "", " ", " anon", "anon", "authenticated", "service_role", "cloud user", "user\n", "x".repeat(129)])(
    "rejects unsafe/reserved subjects %s before creating an identity", async subject => {
      const count = await scalar("select count(*)::int as result from app_users");
      await expect(scalar("select get_or_create_app_user($1) as result", [subject])).rejects.toThrow("INVALID_IDENTITY");
      expect(await scalar("select count(*)::int as result from app_users")).toBe(count);
    });

  it("keeps creation/linking/import RPCs server-only and exposes no identity or credential rows to either client role", async () => {
    const session = await english();
    for (const role of ["anon", "authenticated"]) {
      await pg.exec(`set role ${role}`); await claims(alice.cloudbase_subject!, role);
      try {
        await expect(identity(`untrusted-${role}`)).rejects.toThrow("permission denied");
        await expect(scalar("select seed_legacy_app_users($1::uuid[]) as result", [[randomUUID()]])).rejects.toThrow("permission denied");
        await expect(scalar("select link_legacy_app_user($1::uuid,'stolen') as result", [alice.id])).rejects.toThrow("permission denied");
        for (const table of ["app_users", "app_identity_link_audit", "admin_users", "config_versions", "experiment_versions", "english_assistant_configs", "english_assistant_learning_controls"]) {
          await expect(pg.query(`select * from ${table}`)).rejects.toThrow("permission denied");
        }
        await expect(pause(session, true, 0)).rejects.toThrow("permission denied");
        await expect(pg.query("update english_assistant_sessions set english_paused=true where id=$1", [session.id])).rejects.toThrow("permission denied");
      } finally { await pg.exec("reset role"); }
    }
    await pg.exec("set role service_role");
    try { expect((await identity("trusted-server-subject")).cloudbase_subject).toBe("trusted-server-subject"); }
    finally { await pg.exec("reset role"); }
  });

  it("uses exact JWT subject ownership for authenticated reads while unknown, raw business UUID and Publishable identities see no records", async () => {
    const first = await bloom(); const second = await bloom(bob, "CB002");
    await english(); const other = await english(bob, "CB002");
    const turn = randomUUID();
    const started = await scalar("select begin_turn($1::uuid,$2::uuid,$3::uuid,'你好') as result", [first.id, alice.id, turn]);
    await scalar("select save_reply($1::uuid,$2::uuid,$3::uuid,'回复','complete',null) as result", [first.id, turn, started.lock_token]);
    await pg.exec("set role authenticated");
    try {
      await claims(bob.cloudbase_subject!);
      expect(await scalar("select id as result from conversations")).toBe(second.id);
      expect(await scalar("select count(*)::int as result from messages")).toBe(0);
      expect(await scalar("select id as result from english_assistant_sessions")).toBe(other.id);
      expect(await scalar("select count(*)::int as result from english_assistant_messages")).toBe(1);
      for (const subject of ["unmapped-subject", alice.id, "anon", "service_role"]) {
        await claims(subject);
        expect(await scalar("select app_current_user_id() as result")).toBeNull();
        expect(await scalar("select count(*)::int as result from conversations")).toBe(0);
        expect(await scalar("select count(*)::int as result from english_assistant_messages")).toBe(0);
      }
      await claims(alice.cloudbase_subject!, "anon");
      expect(await scalar("select app_current_user_id() as result")).toBeNull();
    } finally { await pg.exec("reset role"); }
    await pg.exec("set role anon"); await claims(alice.cloudbase_subject!, "anon");
    try {
      await expect(pg.query("select id from conversations")).rejects.toThrow("permission denied");
      await expect(pg.query("select id from english_assistant_sessions")).rejects.toThrow("permission denied");
      await expect(scalar("select app_current_user_id() as result")).rejects.toThrow("permission denied");
    } finally { await pg.exec("reset role"); }
  });

  it("stages original UUIDs and links only unbound identities once, without claiming records by student number", async () => {
    const legacy = randomUUID(), extra = randomUUID();
    await pg.exec("set role service_role");
    try {
      expect(await scalar("select seed_legacy_app_users($1::uuid[]) as result", [[legacy, extra, legacy]])).toBe(2);
      expect(await scalar("select seed_legacy_app_users($1::uuid[]) as result", [[legacy]])).toBe(0);
      const imported = { id: legacy, cloudbase_subject: null, created_at: "" };
      const session = await english(imported, "LEGACY001");
      const before = await restoreEnglish(imported);
      await expect(scalar("select link_legacy_app_user($1::uuid,$2) as result", [legacy, alice.cloudbase_subject])).rejects.toThrow("IDENTITY_CONFLICT");
      const linked = await scalar<AppUser>("select link_legacy_app_user($1::uuid,'verified-import-subject') as result", [legacy]);
      expect(linked.id).toBe(legacy); expect(linked.cloudbase_subject).toBe("verified-import-subject");
      expect(await identity("verified-import-subject")).toEqual(linked);
      expect(await restoreEnglish(imported)).toEqual(before);
      expect((await restoreEnglish(linked)).id).toBe(session.id);
      expect(await scalar("select link_legacy_app_user($1::uuid,'verified-import-subject') as result", [legacy])).toEqual(linked);
      await expect(scalar("select link_legacy_app_user($1::uuid,'replacement') as result", [legacy])).rejects.toThrow("IDENTITY_CONFLICT");
      await expect(scalar("select link_legacy_app_user($1::uuid,'verified-import-subject') as result", [extra])).rejects.toThrow("IDENTITY_CONFLICT");
      await expect(scalar("select link_legacy_app_user($1::uuid,'missing') as result", [randomUUID()])).rejects.toThrow("IDENTITY_NOT_FOUND");
      expect(await scalar("select count(*)::int as result from app_identity_link_audit")).toBe(1);
    } finally { await pg.exec("reset role"); }
    await pg.exec("set role authenticated");
    try {
      await claims("LEGACY001"); expect(await scalar("select count(*)::int as result from english_assistant_sessions")).toBe(0);
      await claims("verified-import-subject"); expect(await scalar("select owner_id as result from english_assistant_sessions")).toBe(legacy);
    } finally { await pg.exec("reset role"); }
  });
});

describe("CloudBase preserves independent course transactions", () => {
  it("preserves atomic Bloom guidance/retest progress, evidence checks and completed replay after identity mapping", async () => {
    const settings = { ...defaultExperiment(), personality_prompt: "原人格", question_mode: { ...defaultQuestionMode(), enabled: true } };
    settings.connections.deepseek.model = "shared-deepseek-test"; settings.connections.chatgpt.model = "bloom-other-model";
    await scalar("select publish_experiment($1::jsonb,$2::jsonb,$3::uuid,1,true) as result",
      [JSON.stringify(settings), JSON.stringify({ deepseek: "encrypted-d", chatgpt: "encrypted-c" }), admin.id]);
    const conversation = await bloom(); let progress = await scalar<QuestionProgress>("select ensure_question_session($1::uuid,$2::uuid) as result", [conversation.id, alice.id]);
    let lastTurn = "";
    for (let i = 0; i < 6; i++) {
      const turn = randomUUID(); const started = await scalar("select begin_turn($1::uuid,$2::uuid,$3::uuid,'学生回答：证据与设计') as result", [conversation.id, alice.id, turn]);
      const assessment = progress.phase === "retest" ? null : { achieved: true, observed_level: "create", evidence: "证据与设计", reply: "已给出充分依据" };
      if (i === 0) {
        await expect(scalar("select save_question_reply($1::uuid,$2::uuid,$3::uuid,$4::jsonb,$5::jsonb,'反馈') as result", [conversation.id, turn, started.lock_token, JSON.stringify(progress), JSON.stringify({ ...assessment, evidence: "未提供的证据" })])).rejects.toThrow("INVALID_QUESTION_ASSESSMENT");
        expect(await scalar("select question_progress as result from conversations where id=$1", [conversation.id])).toEqual(progress);
        expect(await scalar("select count(*)::int as result from question_turns")).toBe(0);
      }
      const saved = await scalar("select save_question_reply($1::uuid,$2::uuid,$3::uuid,$4::jsonb,$5::jsonb,'当前任务反馈') as result", [conversation.id, turn, started.lock_token, JSON.stringify(progress), assessment ? JSON.stringify(assessment) : null]);
      expect(saved.question_progress).toEqual(nextQuestionProgress(progress, true));
      expect((await scalar("select begin_turn($1::uuid,$2::uuid,$3::uuid,'学生回答：证据与设计') as result", [conversation.id, alice.id, turn])).state).toBe("complete");
      progress = saved.question_progress; lastTurn = turn;
    }
    expect(progress.phase).toBe("completed");
    expect(await scalar("select count(*)::int as result from question_turns where before_state->>'phase'='retest' and assessment is null")).toBe(3);
    await expect(scalar("select begin_turn($1::uuid,$2::uuid,$3::uuid,'新答案') as result", [conversation.id, alice.id, randomUUID()])).rejects.toThrow("QUESTION_COMPLETED");
    expect((await scalar("select begin_turn($1::uuid,$2::uuid,$3::uuid,'学生回答：证据与设计') as result", [conversation.id, alice.id, lastTurn])).state).toBe("complete");
  });

  it("allocates two English DeepSeek groups independently of four Bloom groups and keeps source model snapshots", async () => {
    const source = await bloom();
    for (let i = 0; i < 8; i++) await english(await identity(`english-student-${i}`), `ENG${i}`);
    const rows = (await pg.query<{ group_code: string; total: number }>("select group_code,count(*)::int as total from english_assistant_sessions group by group_code order by group_code")).rows;
    expect(rows).toEqual([{ group_code: "deepseek_control", total: 4 }, { group_code: "deepseek_personality", total: 4 }]);
    expect(await scalar("select count(*)::int as result from experiment_groups")).toBe(4);
    expect(await scalar("select count(*)::int as result from participant_enrollments")).toBe(1);
    expect(await scalar("select id as result from conversations")).toBe(source.id);
    const configs = (await pg.query<{ model: string; ciphertext: string; source: string }>("select settings->>'model' as model,api_key_ciphertext as ciphertext,source_experiment_id::text as source from english_assistant_configs")).rows;
    expect(configs).toHaveLength(8);
    expect(configs.every(config => config.model === "shared-deepseek-test" && config.ciphertext === "encrypted-d" && config.source)).toBe(true);
  });

  it("makes controls idempotent, refuses stale/wrong-owner writes, resumes the same activity and keeps deletion audit independent of Bloom", async () => {
    const originalBloom = await bloom(); const session = await english(); const other = await english(bob, "CB002");
    const turn = randomUUID(); const paused = await pause(session, true, 0, turn);
    expect(paused.english_progress).toEqual({ ...session.english_progress, version: 1 });
    expect(await pause(session, true, 0, turn)).toEqual(paused);
    await expect(beginEnglish(session, 1)).rejects.toThrow("ENGLISH_LEARNING_PAUSED");
    await expect(pause(session, false, 1, randomUUID(), bob)).rejects.toThrow("FORBIDDEN");
    await expect(pause(session, false, 0)).rejects.toThrow("ENGLISH_STATE_CONFLICT");
    const resumed = await pause(session, false, 1);
    expect(resumed.english_progress).toEqual({ ...session.english_progress, version: 2 });
    expect(resumed.english_paused).toBe(false); expect((await restoreEnglish()).request_count).toBe(0);
    const teachingTurn = randomUUID(); const started = await beginEnglish(session, 2, teachingTurn);
    await expect(pause(session, true, 2)).rejects.toThrow("BUSY");
    await scalar("select save_english_reply($1::uuid,$2::uuid,$3::uuid,$4::jsonb,$5::jsonb,'当前任务反馈') as result",
      [session.id, teachingTurn, started.lock_token, JSON.stringify(resumed.english_progress),
        JSON.stringify({ achieved: false, evidence: "", feedback: "请继续当前活动" })]);
    const replay = await beginEnglish(session, 0, teachingTurn); expect(replay.state).toBe("complete");
    expect(replay.english_progress).toEqual({ ...session.english_progress, version: 3 });
    await expect(scalar("select admin_delete_english_conversation($1::uuid,$2::uuid) as result", [session.id, bob.id])).rejects.toThrow("FORBIDDEN");
    expect(await scalar("select admin_delete_english_conversation($1::uuid,$2::uuid) as result", [session.id, admin.id])).toBe(session.id);
    expect(await scalar("select count(*)::int as result from english_assistant_learning_controls where session_id=$1", [session.id])).toBe(0);
    expect(await scalar("select count(*)::int as result from english_assistant_messages where session_id=$1", [session.id])).toBe(0);
    expect(await scalar("select messages_count::int as result from english_assistant_delete_audit where conversation_id=$1", [session.id])).toBe(7);
    expect(await restoreEnglish(bob)).toEqual(other);
    expect(await scalar("select id as result from conversations")).toBe(originalBloom.id);
    expect(await scalar("select count(*)::int as result from participant_enrollments")).toBe(1);
  });

  it("publishes and freezes a custom BOPPPS curriculum using internal admin UUIDs", async () => {
    const stages = ["bridge", "objectives", "pre_assessment", "participatory", "post_assessment", "summary"];
    const course = Object.fromEntries(stages.map(stage => [stage, { description: `阶段${stage}`, activities: [{ title: "当前任务", prompt: "完成当前任务", criterion: "需要具体证据" }] }]));
    await expect(scalar("select publish_english_course($1::uuid,0,true,'说明','基础提示','人格提示',$2::jsonb) as result", [bob.id, JSON.stringify(course)])).rejects.toThrow("FORBIDDEN");
    await scalar("select publish_english_course($1::uuid,0,true,'说明','基础提示','人格提示',$2::jsonb) as result", [admin.id, JSON.stringify(course)]);
    const session = await scalar("select register_english_session($1::uuid,'CB001','课程首题',1) as result", [alice.id]);
    const updated = structuredClone(course); updated.bridge.activities[0].prompt = "新版首题";
    await scalar("select publish_english_course($1::uuid,1,true,'说明','新版基础提示','人格提示',$2::jsonb) as result", [admin.id, JSON.stringify(updated)]);
    expect(await scalar("select curriculum as result from english_assistant_configs where id=$1", [session.config_id])).toEqual(course);
    expect(await scalar("select curriculum as result from english_assistant_state")).toEqual(updated);
    expect(await scalar("select source_experiment_id is not null as result from english_assistant_configs where id=$1", [session.config_id])).toBe(true);
  });
});
