import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { defaultExperiment } from "@/lib/experiment";
import { defaultSettings } from "@/lib/types";

const admin = "00000000-0000-4000-8000-000000000001";
const owners = Array.from({ length: 20 }, (_, index) => `00000000-0000-4000-8000-${String(index + 2).padStart(12, "0")}`);
const migrations = ["001_studychat.sql", "002_factorial_experiment.sql", "003_admin_delete_conversation.sql", "004_question_mode.sql", "005_english_assistant.sql"];
const groupingFile = "supabase/migrations/006_english_groups.sql";
const inheritedPersonality = "从原后台继承的人格提示词";
const courseBase = "英语课程共同基础提示词";
const coursePersonality = "英语独立人格提示词";
let pg: PGlite;

async function prepare(database: PGlite, grouped = true) {
  await database.exec("create schema auth; create role anon; create role authenticated; create role service_role bypassrls; create table auth.users(id uuid primary key); create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$; grant usage on schema auth,public to authenticated,anon,service_role;");
  for (const file of migrations) await database.exec(await readFile("supabase/migrations/" + file, "utf8"));
  if (grouped) await database.exec(await readFile(groupingFile, "utf8"));
}
async function scalar<T = any>(sql: string, params: unknown[] = [], database = pg): Promise<T> {
  return (await database.query<{ result: T }>(sql, params)).rows[0]?.result;
}
function experiment(model = "shared-deepseek-model") {
  const result = { ...defaultExperiment(), base_prompt: "原Bloom基础提示词", personality_prompt: inheritedPersonality };
  result.connections.deepseek = { ...result.connections.deepseek, model, api_base_url: "https://api.deepseek.com/v1", temperature: 0.4, max_tokens: 3072 };
  result.connections.chatgpt = { ...result.connections.chatgpt, model: "unrelated-chatgpt-model" };
  return result;
}
async function publishSource(revision = 0, enabled = false, settings = experiment()) {
  return scalar("select publish_experiment($1::jsonb,$2::jsonb,$3::uuid,$4,$5) as result",
    [JSON.stringify(settings), JSON.stringify({ deepseek: "shared-deepseek-cipher", chatgpt: "unrelated-chatgpt-cipher" }), admin, revision, enabled]);
}
async function publishCourse(revision = 0, enabled = true, actor = admin, disclosure = "英语独立登记说明", base = courseBase, personality = coursePersonality) {
  return scalar("select publish_english_course($1::uuid,$2,$3,$4,$5,$6) as result", [actor, revision, enabled, disclosure, base, personality]);
}
async function register(owner = owners[0], student = "00123") {
  return scalar("select register_english_session($1::uuid,$2,$3) as result", [owner, student, "固定 BOPPPS 英语导入"]);
}
async function snapshot(configId: string) {
  return scalar("select to_jsonb(c) as result from english_assistant_configs c where id=$1", [configId]);
}
async function counts() {
  return (await pg.query<{ group_code: string; enrolled: number }>("select * from english_group_counts()")).rows;
}

beforeAll(async () => {
  pg = new PGlite();
  await prepare(pg);
  await pg.query("insert into auth.users(id) select unnest($1::uuid[])", [[admin, ...owners]]);
  await pg.query("insert into admin_users(user_id) values($1)", [admin]);
}, 60000);
beforeEach(async () => {
  await pg.exec("reset role; truncate english_assistant_state,english_assistant_configs,study_state,experiment_versions,config_versions,conversations restart identity cascade; insert into study_state(id) values(1); insert into english_assistant_state(id) values(1);");
  await publishSource();
});
afterAll(async () => { await pg?.close(); });

describe("independent DeepSeek English enrollment groups", () => {
  it("balances two cumulative English groups and leaves original enrollment, counts and model configuration untouched", async () => {
    await pg.exec("update study_state set enabled=true");
    const bloom = await scalar("select to_jsonb(register_participant($1::uuid,$2)) as result", [owners[0], "00123"]);
    await pg.exec("update study_state set enabled=false");
    const beforeSettings = await scalar("select jsonb_agg(to_jsonb(e)) as result from experiment_versions e");
    const beforeGroups = await scalar("select jsonb_agg(to_jsonb(g) order by group_code) as result from experiment_group_counts() g");
    for (let index = 0; index < 17; index++) {
      const row = await register(owners[index], index === 0 ? "00123" : "ENG" + index);
      expect(row.model_factor).toBe("deepseek");
      expect(row.group_code).toBe(row.personality ? "deepseek_personality" : "deepseek_control");
      const totals = await counts();
      expect(totals).toHaveLength(2);
      expect(Math.abs(Number(totals[0].enrolled) - Number(totals[1].enrolled))).toBeLessThanOrEqual(1);
    }
    expect((await counts()).map(row => Number(row.enrolled)).sort()).toEqual([8, 9]);
    expect(await scalar("select count(*)::int as result from participant_enrollments")).toBe(1);
    expect(await scalar("select id as result from conversations")).toBe(bloom.id);
    expect(await scalar("select jsonb_agg(to_jsonb(e)) as result from experiment_versions e")).toEqual(beforeSettings);
    expect(await scalar("select jsonb_agg(to_jsonb(g) order by group_code) as result from experiment_group_counts() g")).toEqual(beforeGroups);
    expect(await scalar("select count(*)::int as result from config_versions")).toBe(4);
  });

  it("freezes the assigned group and prompts on restoration and uses new course/source revisions only for new English registration", async () => {
    const first = await register();
    const frozen = await snapshot(first.config_id);
    expect(frozen.source_revision).toBe(1);
    expect(frozen.prompt_revision).toBe(0);
    expect(frozen.settings.model).toBe("shared-deepseek-model");
    const published = await publishCourse();
    expect(published.revision).toBe(1);
    const source = await publishSource(1, false, experiment("new-shared-deepseek-model"));
    const resumed = await register();
    expect(resumed.id).toBe(first.id);
    expect(resumed.config_id).toBe(first.config_id);
    expect(resumed.group_code).toBe(first.group_code);
    expect(await snapshot(first.config_id)).toEqual(frozen);
    const second = await register(owners[1], "ENG2");
    const next = await snapshot(second.config_id);
    expect(second.group_code).not.toBe(first.group_code);
    expect(next.source_experiment_id).toBe(source.id);
    expect(next.source_revision).toBe(2);
    expect(next.prompt_revision).toBe(1);
    expect(next.base_prompt).toBe(courseBase);
    expect(next.personality_prompt).toBe(second.personality ? coursePersonality : null);
    expect(next.settings.model).toBe("new-shared-deepseek-model");
    expect(next.settings.disclosure).toBe("英语独立登记说明");
    expect(await scalar("select count(*)::int as result from english_assistant_messages")).toBe(2);
    await expect(register(owners[0], "OTHER")).rejects.toThrow("IDENTITY_BOUND");
    await expect(register(owners[2], "00123")).rejects.toThrow("STUDENT_UNAVAILABLE");
  });

  it("requires only the shared DeepSeek model/key, never ChatGPT, and copies no original questions or prompts into provider settings", async () => {
    await pg.exec("update experiment_versions set settings=jsonb_set(settings,'{connections}',jsonb_build_object('deepseek',settings->'connections'->'deepseek')) || '{\"question_mode\":{\"enabled\":true}}'::jsonb, encrypted_keys=jsonb_build_object('deepseek',encrypted_keys->'deepseek')");
    const first = await register();
    const second = await register(owners[1], "ENG2");
    for (const session of [first, second]) {
      const config = await snapshot(session.config_id);
      expect(config.settings.model).toBe("shared-deepseek-model");
      expect(config.settings.temperature).toBe(0.4);
      expect(config.settings.max_tokens).toBe(3072);
      expect(config.api_key_ciphertext).toBe("shared-deepseek-cipher");
      expect(config.base_prompt).toContain("PEEC");
      expect(config.personality_prompt).toBe(session.personality ? inheritedPersonality : null);
      expect(config.settings.question_mode).toBeUndefined();
      expect(JSON.stringify(config.settings)).not.toMatch(/原Bloom|unrelated-chatgpt/);
    }
    expect(await scalar("select count(*)::int as result from english_assistant_configs")).toBe(2);
    expect(await scalar("select count(*)::int as result from conversations")).toBe(0);
  });

  it("rejects missing DeepSeek and missing inherited personality instead of falling back to ChatGPT or creating invalid groups", async () => {
    await pg.exec("update experiment_versions set settings=settings #- '{connections,deepseek}'");
    await expect(register()).rejects.toThrow("NOT_CONFIGURED");
    expect(await scalar("select count(*)::int as result from english_assistant_configs")).toBe(0);
    await pg.query("update experiment_versions set settings=$1::jsonb", [JSON.stringify({ ...experiment(), personality_prompt: " " })]);
    await expect(register()).rejects.toThrow("NOT_CONFIGURED");
    await publishCourse();
    expect((await register()).group_code).toMatch(/^deepseek_(personality|control)$/);
    await pg.exec("delete from english_assistant_sessions; update experiment_versions set encrypted_keys='{}'");
    await expect(register()).rejects.toThrow("NOT_CONFIGURED");
  });

  it("publishes only English prompts with optimistic concurrency and independent pause while preserving existing restoration", async () => {
    const session = await register();
    const original = await scalar("select to_jsonb(s) as result from study_state s");
    const first = await publishCourse(0, false);
    expect(first).toMatchObject({ revision: 1, enabled: false, base_prompt: courseBase, personality_prompt: coursePersonality });
    expect(await scalar("select to_jsonb(s) as result from study_state s")).toEqual(original);
    expect((await register()).id).toBe(session.id);
    await expect(register(owners[1], "ENG2")).rejects.toThrow("ENGLISH_PAUSED");
    await expect(publishCourse(0)).rejects.toThrow("CONFLICT");
    await expect(publishCourse(1, true, owners[1])).rejects.toThrow("FORBIDDEN");
    const second = await publishCourse(1, true);
    expect(second.revision).toBe(2);
    expect((await register(owners[1], "ENG2")).id).toBeDefined();
    expect(await scalar("select count(*)::int as result from experiment_versions")).toBe(1);
    expect(await scalar("select count(*)::int as result from config_versions")).toBe(4);
  });

  it("validates every prompt and disclosure before publication", async () => {
    for (const [disclosure, base, personality] of [["", courseBase, coursePersonality], ["d", " ", coursePersonality], ["d", courseBase, " "], ["d".repeat(2001), courseBase, coursePersonality], ["d", "b".repeat(10001), coursePersonality], ["d", courseBase, "p".repeat(10001)]]) {
      await expect(publishCourse(0, true, admin, disclosure, base, personality)).rejects.toThrow("INVALID_ENGLISH_COURSE");
    }
    expect(await scalar("select revision as result from english_assistant_state")).toBe(0);
  });

  it("accepts only one competing publication for the same English revision", async () => {
    const results = await Promise.allSettled([
      publishCourse(0, true, admin, "first disclosure", "first base", "first personality"),
      publishCourse(0, false, admin, "second disclosure", "second base", "second personality"),
    ]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find(result => result.status === "rejected") as PromiseRejectedResult;
    expect(String(rejected.reason)).toContain("CONFLICT");
    expect(await scalar("select revision as result from english_assistant_state")).toBe(1);
    expect(await scalar("select count(*)::int as result from experiment_versions")).toBe(1);
  });

  it("keeps group counts cumulative across course revisions and ignores legacy ungrouped rows", async () => {
    const first = await register();
    await pg.query("update english_assistant_sessions set group_code=null,model_factor=null,personality=null,assigned_at=null where id=$1", [first.id]);
    expect((await counts()).map(row => Number(row.enrolled))).toEqual([0, 0]);
    for (let index = 1; index < 7; index++) {
      if (index === 3) await publishCourse();
      await register(owners[index], "ENG" + index);
    }
    expect((await counts()).map(row => Number(row.enrolled))).toEqual([3, 3]);
    expect((await scalar("select to_jsonb(r) as result from admin_english_conversation_records r where id=$1", [first.id])).group_code).toBeNull();
  });

  it("provides an administrator record view without provider credentials or prompt content", async () => {
    await publishCourse();
    const session = await register();
    const record = await scalar("select to_jsonb(r) as result from admin_english_conversation_records r where id=$1", [session.id]);
    expect(record).toMatchObject({ student_id: "00123", model_factor: "deepseek", prompt_revision: 1, experiment_revision: 1 });
    expect(record.group_code).toBe(session.group_code);
    expect(record.english_progress).toEqual(session.english_progress);
    expect(JSON.stringify(record)).not.toMatch(/cipher|settings|base_prompt|personality_prompt|api_base_url/);
  });

  it("hides group/source/prompt fields from students and retires old connection RPCs for service_role", async () => {
    const session = await register();
    await pg.exec("set role authenticated");
    try {
      await pg.query("select set_config('request.jwt.claim.sub',$1,false)", [owners[0]]);
      expect((await pg.query("select id from english_assistant_sessions")).rows).toEqual([{ id: session.id }]);
      for (const sql of ["select group_code from english_assistant_sessions", "select personality from english_assistant_sessions", "select * from english_assistant_configs", "select * from english_assistant_state", "select * from admin_english_conversation_records", "select * from english_group_counts()", "select register_english_session(null,'OTHER','opening')", "select publish_english_course(null,0,true,'d','b','p')"]) {
        await expect(pg.query(sql)).rejects.toThrow("permission denied");
      }
    } finally { await pg.exec("reset role"); }
    await pg.exec("set role service_role");
    try {
      await expect(pg.query("select seed_english_config('{}','key')")).rejects.toThrow("permission denied");
      await expect(pg.query("select publish_english_config('{}','key',null,true,null)")).rejects.toThrow("permission denied");
      expect((await pg.query("select * from english_group_counts()")).rows).toHaveLength(2);
      expect((await pg.query("select * from admin_english_conversation_records")).rows).toHaveLength(1);
    } finally { await pg.exec("reset role"); }
  });

  it("rejects partial or contradictory assignment columns", async () => {
    const session = await register();
    await expect(pg.query("update english_assistant_sessions set model_factor=null where id=$1", [session.id])).rejects.toThrow("english_assistant_group_assignment");
    await expect(pg.query("update english_assistant_sessions set personality=not personality where id=$1", [session.id])).rejects.toThrow("english_assistant_group_assignment");
    await expect(pg.query("update english_assistant_sessions set model_factor='chatgpt' where id=$1", [session.id])).rejects.toThrow("english_assistant_group_assignment");
  });

  it("preserves actual pre-006 English messages, progress, disclosure and unknown group identity during a repeatable migration", async () => {
    const legacy = new PGlite();
    try {
      await prepare(legacy, false);
      await legacy.query("insert into auth.users values($1)", [owners[0]]);
      await scalar("select seed_english_config($1::jsonb,'legacy-cipher') as result", [JSON.stringify({ ...defaultSettings, model: "legacy-model", disclosure: "历史英语登记说明" })], legacy);
      const original = await scalar("select register_english_session($1::uuid,'LEGACY','历史开场') as result", [owners[0]], legacy);
      await legacy.query("update english_assistant_sessions set english_progress=$1::jsonb where id=$2", [JSON.stringify({ stage: "pre_assessment", step: 1, version: 3, completed: false }), original.id]);
      const before = await scalar("select to_jsonb(s) as result from english_assistant_sessions s", [], legacy);
      const migration = await readFile(groupingFile, "utf8");
      await legacy.exec(migration);
      await legacy.exec(migration);
      const restored = await scalar("select register_english_session($1::uuid,'LEGACY','must-not-replace-history') as result", [owners[0]], legacy);
      for (const key of Object.keys(before)) expect(restored[key]).toEqual(before[key]);
      expect(restored.group_code).toBeNull(); expect(restored.personality).toBeNull();
      expect(await scalar("select content as result from english_assistant_messages", [], legacy)).toBe("历史开场");
      expect(await scalar("select disclosure as result from english_assistant_state", [], legacy)).toBe("历史英语登记说明");
      expect(await scalar("select count(*)::int as result from english_assistant_configs", [], legacy)).toBe(1);
      expect(await scalar("select sum(enrolled)::int as result from english_group_counts()", [], legacy)).toBe(0);
    } finally { await legacy.close(); }
  }, 60000);

  it("initializes an empty new project with the exact six migrations", async () => {
    const fresh = new PGlite();
    try {
      await fresh.exec("create schema auth; create role anon; create role authenticated; create role service_role bypassrls; create table auth.users(id uuid primary key); create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$; grant usage on schema auth,public to authenticated,anon,service_role;");
      await fresh.exec(await readFile("supabase/new_project_init.sql", "utf8"));
      const state = await scalar("select to_jsonb(s) as result from english_assistant_state s", [], fresh);
      expect(state.revision).toBe(0); expect(state.personality_prompt).toBeNull();
      expect(state.base_prompt).toContain("PEEC");
      expect(await scalar("select sum(enrolled)::int as result from english_group_counts()", [], fresh)).toBe(0);
    } finally { await fresh.close(); }
  }, 60000);
});
