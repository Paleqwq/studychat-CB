import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { defaultExperiment } from "@/lib/experiment";
import { defaultQuestionMode } from "@/lib/question-mode";
import { defaultEnglishCurriculum } from "@/lib/english-assistant";

let pg: PGlite;
let admin: string, student: string;
const settings = defaultExperiment();
settings.personality_prompt = "独立人格材料";
settings.connections.deepseek.model = "target-deepseek";
settings.connections.chatgpt.model = "target-chatgpt";
const { connections: _connections, ...baseContent } = settings;
const content = { ...baseContent, title: "迁入的研究名称", base_prompt: "源站提示词",
  question_mode: { ...defaultQuestionMode(), enabled: true } };
const keys = { deepseek: "target-encrypted-d", chatgpt: "target-encrypted-c" };

async function scalar<T = any>(sql: string, parameters: unknown[] = []): Promise<T> {
  return (await pg.query<{ result: T }>(sql, parameters)).rows[0]?.result;
}
async function save(revision = 0, actor = admin, value: unknown = content, enabled = true) {
  return scalar("select save_content_draft($1::jsonb,$2::uuid,$3,$4) as result", [JSON.stringify(value), actor, revision, enabled]);
}
async function publish(draftRevision?: number, value = settings, secrets = keys) {
  return scalar(draftRevision === undefined
    ? "select publish_experiment($1::jsonb,$2::jsonb,$3::uuid,0,true) as result"
    : "select publish_experiment_with_content_draft($1::jsonb,$2::jsonb,$3::uuid,0,true,$4) as result",
  [JSON.stringify(value), JSON.stringify(secrets), admin, ...(draftRevision === undefined ? [] : [draftRevision])]);
}
async function state() { return scalar("select to_jsonb(s) as result from study_state s"); }

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`create schema auth; create role anon; create role authenticated; create role service_role bypassrls;
    create function auth.jwt() returns jsonb language sql stable as $$ select '{}'::jsonb $$;
    create function auth.uid() returns text language sql stable as $$ select null::text $$;
    create function auth.role() returns text language sql stable as $$ select 'authenticated' $$;
    grant usage on schema auth,public to anon,authenticated,service_role;`);
  await pg.exec(await readFile("cloudbase/new_project_init.sql", "utf8"));
  await pg.exec(await readFile("cloudbase/migrations/20261005213000_content_drafts.sql", "utf8"));
  await pg.exec(await readFile("cloudbase/migrations/20261005214500_content_draft_publish_guard.sql", "utf8"));
}, 60000);
beforeEach(async () => {
  await pg.exec(`reset role; truncate app_users,study_state,english_assistant_state,experiment_versions,
    config_versions,english_assistant_configs restart identity cascade;
    insert into study_state(id) values(1); insert into english_assistant_state(id) values(1);`);
  admin = (await scalar("select get_or_create_app_user('real-admin-sub') as result")).id;
  student = (await scalar("select get_or_create_app_user('real-student-sub') as result")).id;
  await pg.query("insert into admin_users(user_id) values($1)", [admin]);
});
afterAll(async () => { await pg?.close(); });

describe("private teaching drafts before model publication", () => {
  it("persists the complete whitelisted content while leaving models, sessions and live availability untouched", async () => {
    const saved = await save();
    expect(saved).toMatchObject({ content, draft_revision: 1, enabled: true });
    const current = await state();
    expect(current).toMatchObject({ active_experiment_id: null, active_config_id: null, enabled: false,
      content_draft: content, draft_revision: 1, draft_enabled: true, draft_updated_by: admin });
    expect(await scalar("select count(*)::int as result from experiment_versions")).toBe(0);
    expect(await scalar("select count(*)::int as result from config_versions")).toBe(0);
    await expect(scalar("select to_jsonb(register_participant($1::uuid,'S001')) as result", [student])).rejects.toThrow("NOT_CONFIGURED");
    await expect(scalar("select register_english_session($1::uuid,'S001','开始',0) as result", [student])).rejects.toThrow("NOT_CONFIGURED");
  });

  it.each(["connections", "api_keys", "encrypted_keys", "model", "system_prompt", "student_id", "enabled"])(
    "rejects forbidden top-level field %s even through a service-side SQL call", async key => {
      await expect(save(0, admin, { ...content, [key]: "forbidden" })).rejects.toThrow("INVALID_CONTENT_DRAFT");
      expect((await state()).content_draft).toBeNull();
    });

  it("rejects malformed nested questions and protects integrity during direct table updates", async () => {
    const bad = structuredClone(content);
    (bad.question_mode.questions[0] as any).api_key = "forbidden";
    await expect(save(0, admin, bad)).rejects.toThrow("INVALID_CONTENT_DRAFT");
    await expect(save(0, admin, { ...content, personality_prompt: " " })).rejects.toThrow("INVALID_CONTENT_DRAFT");
    await expect(pg.query("update study_state set content_draft=$1::jsonb", [JSON.stringify({ ...content, model: "bad" })])).rejects.toThrow("study_content_draft_valid");
  });

  it("checks admin identity and draft compare-and-swap separately from the published revision", async () => {
    await expect(save(0, student)).rejects.toThrow("FORBIDDEN");
    await save();
    await expect(save(0)).rejects.toThrow("CONFLICT");
    await save(1, admin, { ...content, base_prompt: "后来的草稿" });
    expect((await state()).draft_revision).toBe(2);
    await expect(publish(1)).rejects.toThrow("CONFLICT");
    expect((await state()).active_experiment_id).toBeNull();
    expect((await state()).content_draft.base_prompt).toBe("后来的草稿");
  });

  it("clears a draft only when a valid revision-checked model publication commits", async () => {
    await save();
    await expect(publish(1, settings, { ...keys, chatgpt: "" })).rejects.toThrow("INVALID_EXPERIMENT");
    expect((await state()).content_draft).toEqual(content);
    const first = await publish(1, { ...settings, ...content });
    const current = await state();
    expect(current).toMatchObject({ active_experiment_id: first.id, enabled: true, content_draft: null,
      draft_revision: 2, draft_enabled: false, draft_updated_at: null, draft_updated_by: null });
    expect(first.encrypted_keys).toEqual(keys);
    expect(await scalar("select count(*)::int as result from experiment_groups")).toBe(4);
    await expect(save(2)).rejects.toThrow("CONTENT_DRAFT_UNAVAILABLE");
  });

  it("rejects legacy publication when a saved draft exists and rolls back every new configuration and group", async () => {
    await save();
    const before = await state();
    await expect(publish()).rejects.toThrow("CONFLICT");
    expect(await state()).toEqual(before);
    expect(await scalar("select count(*)::int as result from experiment_versions")).toBe(0);
    expect(await scalar("select count(*)::int as result from config_versions")).toBe(0);
    expect(await scalar("select count(*)::int as result from experiment_groups")).toBe(0);
  });

  it("retains legacy publication compatibility when there is no saved draft", async () => {
    const first = await publish();
    expect((await state()).active_experiment_id).toBe(first.id);
    expect(await scalar("select count(*)::int as result from experiment_groups")).toBe(4);
  });

  it("does not retain the revision marker after a successful statement or reuse it on a later draft", async () => {
    await save();
    await publish(1, { ...settings, ...content });
    expect(await scalar("select coalesce(current_setting('studychat.content_draft_revision',true),'') as result")).toBe("");
    await pg.exec("update study_state set active_experiment_id=null,enabled=false");
    await save(2);
    await expect(publish()).rejects.toThrow("CONFLICT");
    expect((await state()).content_draft).toEqual(content);
  });

  it("publishes the checked draft into new snapshots and leaves existing records intact on later normal publications", async () => {
    await save();
    const first = await publish(1, { ...settings, ...content });
    const conversation = await scalar("select to_jsonb(register_participant($1::uuid,'S001')) as result", [student]);
    const frozen = await scalar("select to_jsonb(v) as result from config_versions v where id=$1", [conversation.config_id]);
    await scalar("select publish_experiment($1::jsonb,$2::jsonb,$3::uuid,$4,false) as result",
      [JSON.stringify({ ...settings, base_prompt: "新正式提示词" }), JSON.stringify(keys), admin, first.revision]);
    expect(await scalar("select to_jsonb(v) as result from config_versions v where id=$1", [conversation.config_id])).toEqual(frozen);
    expect(await scalar("select count(*)::int as result from participant_enrollments")).toBe(1);
  });

  it("supports atomic import of Bloom drafts and English teaching content, including rollback on invalid English content", async () => {
    const before = await state();
    await pg.exec("begin");
    try {
      await save();
      await expect(scalar("select publish_english_course($1::uuid,0,true,'说明','课程','人格','{}'::jsonb) as result", [admin]))
        .rejects.toThrow("INVALID_ENGLISH_COURSE");
    } finally { await pg.exec("rollback"); }
    expect(await state()).toEqual(before);
    await pg.exec("begin");
    try {
      await pg.exec("select 1 from english_assistant_state where id=1 for update");
      await save();
      await scalar("select publish_english_course($1::uuid,0,true,'说明','英语课程','英语人格',$2::jsonb) as result",
        [admin, JSON.stringify(defaultEnglishCurriculum())]);
      await pg.exec("commit");
    } catch (error) { await pg.exec("rollback"); throw error; }
    expect((await state()).content_draft).toEqual(content);
    expect(await scalar("select revision::int as result from english_assistant_state")).toBe(1);
  });

  it("keeps the content and both new RPCs inaccessible to anonymous and authenticated client roles", async () => {
    await save();
    for (const role of ["anon", "authenticated"]) {
      await pg.exec(`set role ${role}`);
      try {
        await expect(pg.query("select content_draft from study_state")).rejects.toThrow("permission denied");
        await expect(save(1)).rejects.toThrow("permission denied");
        await expect(publish(1)).rejects.toThrow("permission denied");
      } finally { await pg.exec("reset role"); }
    }
    await pg.exec("set role service_role");
    try { expect((await save(1)).draft_revision).toBe(2); }
    finally { await pg.exec("reset role"); }
  });
});
