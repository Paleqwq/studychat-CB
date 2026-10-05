"use client";

import { type ReactNode } from "react";
import { ArrowDownToLine, ArrowLeft, ArrowRight, ArrowUpRight, BookOpen, ChevronRight, FileText, LoaderCircle, MessagesSquare, PlugZap, RefreshCw, ShieldCheck, Trash2, X } from "lucide-react";
import { englishCourseOutline, englishStages } from "@/lib/english-assistant";
import type { EnglishAdminConfiguration } from "@/lib/english-settings";
import type { EnglishConversationDetail, EnglishGroupCounts, EnglishResearchConversation } from "@/lib/english-groups";
import type { RuntimeMode } from "@/lib/types";
import { EnglishProgress } from "./english-progress";
import { ConversationConnectionDetails } from "./conversation-connection-info";
import { Markdown } from "./markdown";

const groups = [
  { code: "deepseek_personality", label: "DeepSeek · 有人格", description: "基础教学提示词 + 人格提示词" },
  { code: "deepseek_control", label: "DeepSeek · 无人格", description: "仅基础教学提示词" }
] as const;

export function englishAdminGroupLabel(code: string | null | undefined) {
  return groups.find(group => group.code === code)?.label ?? "历史未分组";
}

function Field({ label, help, children }: { label: string; help?: string; children: ReactNode }) {
  return <label className="field"><span>{label}</span>{children}{help && <small>{help}</small>}</label>;
}

function formatDate(value?: string | null) {
  const date = value ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime()) ? date.toLocaleString("zh-CN", {
    month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false
  }) : "—";
}

export function EnglishGroupSummary({ counts }: { counts: EnglishGroupCounts | null }) {
  return <div className="english-admin-group-summary">
    <div className="english-admin-groups">
      {groups.map(group => <article className="english-admin-group" key={group.code}>
        <span>{group.label}</span><strong>{counts?.[group.code] ?? "—"}</strong><p>{group.description}</p>
      </article>)}
    </div>
    <p className="small-note">英语课程独立统计登记人数，在人数较少的组中分配；人数相同时随机选择。刷新、重试和发布提示词均保留原分组。登记人数不等于完成人数，历史未分组记录单独查看。</p>
  </div>;
}

export function EnglishSettingsView({ config, counts, mode, disabled, refreshing, onEnabled, onDisclosure, onRefreshConnection }: {
  config: EnglishAdminConfiguration; counts: EnglishGroupCounts | null; mode: RuntimeMode; disabled: boolean; refreshing: boolean;
  onEnabled: (value: boolean) => void; onDisclosure: (value: string) => void; onRefreshConnection: () => void;
}) {
  return <div className="english-admin-settings">
    <section className="settings-card compact"><div className="switch-row"><div><h2>开放英语助教</h2><p>课程启用与暂停独立发布。</p></div>
      <label className="toggle"><input type="checkbox" checked={config.enabled} disabled={disabled} aria-label="开放英语助教"
        onChange={event => onEnabled(event.target.checked)}/><span/></label>
    </div><p className="small-note">新登记使用发布时的提示词和模型配置；已登记学生的分组、教学提示词和原模型 ID 保持固定。</p></section>

    <section className="settings-card"><div className="card-heading"><span className="section-icon"><PlugZap size={19}/></span>
      <div><h2>共享 DeepSeek 模型</h2><p>两组共用主后台的 DeepSeek 连接，无须在此重复配置。</p></div></div>
      <dl className="english-admin-connection">
        <div><dt>模型 ID</dt><dd><code>{config.settings.model || "尚未发布"}</code></dd></div>
        <div><dt>连接状态</dt><dd>{mode === "demo" ? "本地演示连接" : config.has_api_key && config.settings.model ? "已配置共享连接" : "请在主后台完成连接配置"}</dd></div>
        <div><dt>共享配置版本</dt><dd>{config.shared_experiment_revision === null ? "尚未发布" : "v" + config.shared_experiment_revision}</dd></div>
        <div><dt>接口协议</dt><dd>{config.settings.protocol}</dd></div>
      </dl>
      <div className="english-admin-inline-actions"><a className="button secondary small" href="/admin">前往共享模型配置<ArrowUpRight size={14}/></a>
        <button type="button" className="button text small" disabled={disabled || refreshing} onClick={onRefreshConnection}>
          {refreshing ? <LoaderCircle className="spin" size={14}/> : <RefreshCw size={14}/>}刷新模型状态</button>
      </div>
      <p className="small-note">共享地址、协议及密钥可更新；学生登记时的模型 ID 和生成参数保留。新接口须支持该模型 ID。</p>
    </section>

    <section className="settings-card"><div className="card-heading"><span className="section-icon"><ShieldCheck size={19}/></span>
      <div><h2>英语独立分组</h2><p>仅设置 DeepSeek 的有人格与无人格两组。</p></div></div><EnglishGroupSummary counts={counts}/></section>

    <section className="settings-card"><div className="card-heading"><span className="section-icon"><BookOpen size={19}/></span>
      <div><h2>PEEC 课程与登记说明</h2><p>依据教案、讲课稿和课件，按固定 BOPPPS 六阶段学习。</p></div></div>
      <p className="muted">导入 → 学习目标 → 前测 → 参与式学习 → 后测 → 总结</p>
      <Field label="英语课程登记说明" help="独立英语登记展示的说明，最多 2000 字。">
        <textarea rows={3} maxLength={2000} value={config.settings.disclosure} disabled={disabled} onChange={event => onDisclosure(event.target.value)}/>
      </Field>
    </section>
  </div>;
}

export function EnglishPromptSettings({ config, disabled, onBasePrompt, onPersonalityPrompt }: {
  config: EnglishAdminConfiguration; disabled: boolean;
  onBasePrompt: (value: string) => void; onPersonalityPrompt: (value: string) => void;
}) {
  return <div className="english-admin-settings">
    <section className="settings-card"><div className="card-heading"><span className="section-icon"><FileText size={19}/></span>
      <div><h2>基础教学提示词</h2><p>两组共同使用，补充固定 BOPPPS 流程与 PEEC 课程要求。</p></div></div>
      <div className="info-note"><BookOpen size={17}/><span>固定阶段顺序、当前任务与达标条件由系统保持。此处可补充教学风格、反馈方式和材料使用要求；不会替换固定教学流程。</span></div>
      <Field label="英语基础教学提示词" help="1–10000 字；保存后只用于新登记的英语学生。">
        <textarea className="experiment-prompt" rows={10} maxLength={10000} value={config.base_prompt} disabled={disabled}
          onChange={event => onBasePrompt(event.target.value)}/>
      </Field><div className="editor-bottom"><span>两个英语组共同使用</span><span>{config.base_prompt.length} / 10000</span></div>
    </section>
    <section className="settings-card"><div className="card-heading"><span className="section-icon"><MessagesSquare size={19}/></span>
      <div><h2>人格提示词</h2><p>仅 DeepSeek · 有人格组追加此提示词。</p></div></div>
      <Field label="英语人格提示词" help="1–10000 字；无人格组仅使用基础教学提示词。">
        <textarea className="experiment-prompt" rows={8} maxLength={10000} value={config.personality_prompt} disabled={disabled}
          onChange={event => onPersonalityPrompt(event.target.value)}/>
      </Field><div className="editor-bottom"><span>仅有人格组使用</span><span>{config.personality_prompt.length} / 10000</span></div>
    </section>
    <div className="info-note"><ShieldCheck size={17}/><span>英语提示词独立发布，保留历史登记快照。发布新版本不会重新分组，也不会改写既有英语会话。</span></div>
  </div>;
}

export function EnglishRecordsView({ records, counts, total, offset, loading, studentFilter, groupFilter,
  onStudentFilter, onGroupFilter, onQuery, onOpen, onDelete, deleting = false }: {
  records: EnglishResearchConversation[]; counts: EnglishGroupCounts | null; total: number; offset: number; loading: boolean;
  studentFilter: string; groupFilter: string; onStudentFilter: (value: string) => void; onGroupFilter: (value: string) => void;
  onQuery: (offset: number) => void; onOpen: (id: string) => void;
  onDelete?: (conversation: EnglishResearchConversation) => void; deleting?: boolean;
}) {
  return <section className="records-card english-admin-records">
    <header className="records-heading"><div><h2>英语会话记录<span>{total}</span></h2><p>英语登记、分组人数和对话历史独立保存。</p></div>
      <button type="button" className="button secondary small" disabled={loading} onClick={() => onQuery(offset)}><RefreshCw size={14}/>刷新</button>
    </header>
    <div className="records-summary"><EnglishGroupSummary counts={counts}/></div>
    <form className="record-filters" onSubmit={event => { event.preventDefault(); onQuery(0); }}>
      <Field label="学号"><input value={studentFilter} maxLength={32} onChange={event => onStudentFilter(event.target.value)} placeholder="完整学号" spellCheck={false}/></Field>
      <Field label="英语分组"><select value={groupFilter} onChange={event => onGroupFilter(event.target.value)}>
        <option value="">全部英语记录</option>{groups.map(group => <option key={group.code} value={group.code}>{group.label}</option>)}
        <option value="legacy">历史未分组</option>
      </select></Field><button className="button secondary" disabled={loading}>查询</button>
    </form>
    {loading ? <div className="empty-state" role="status"><LoaderCircle className="spin" size={25}/><p>正在读取英语记录…</p></div> : records.length === 0 ?
      <div className="empty-state"><span><MessagesSquare size={28}/></span><h3>暂无符合条件的英语记录</h3><p>学生登记英语课程后可在此查看，或调整筛选条件再查询。</p></div> :
      <div className="record-table-wrap"><table className="record-table"><thead><tr><th>学号 / 会话</th><th>英语分组 / 提示词版本</th><th>开始时间</th><th><span className="sr-only">操作</span></th></tr></thead>
        <tbody>{records.map(record => <tr key={record.id}><td><strong>{record.student_id ?? record.participant_code}</strong><span>{record.title}</span></td>
          <td>{englishAdminGroupLabel(record.group_code)}<span>{record.prompt_revision !== null ? "提示词 v" + record.prompt_revision : "历史课程配置"}</span></td>
          <td>{formatDate(record.created_at)}</td><td><div className="record-actions"><button type="button" className="button text small" disabled={deleting} onClick={() => onOpen(record.id)}>查看对话<ChevronRight size={14}/></button>
            {onDelete && <button type="button" className="button text small" disabled={deleting} aria-label={"删除英语会话 " + record.student_id} onClick={() => onDelete(record)}><Trash2 size={14}/>删除会话</button>}
          </div></td>
        </tr>)}</tbody></table></div>}
    <div className="pagination"><span>共 {total} 个英语会话 · 时间以本机时区显示</span><div>
      <button type="button" className="icon-button" aria-label="上一页英语记录" disabled={offset === 0 || loading} onClick={() => onQuery(Math.max(0, offset - 50))}><ArrowLeft size={16}/></button>
      <span>{Math.floor(offset / 50) + 1}</span>
      <button type="button" className="icon-button" aria-label="下一页英语记录" disabled={offset + 50 >= total || loading} onClick={() => onQuery(offset + 50)}><ArrowRight size={16}/></button>
    </div></div>
  </section>;
}

export function EnglishRecordDetail({ detail, loading, error, onClose, onRetry, onExport, onDelete, deleting = false }: {
  detail: EnglishConversationDetail | null; loading: boolean; error: string;
  onClose: () => void; onRetry: () => void; onExport: () => void;
  onDelete?: () => void; deleting?: boolean;
}) {
  return <section className="record-drawer english-admin-record-detail">
    <header><div><p className="eyebrow">英语会话详情</p><h2>{detail?.conversation.student_id ?? detail?.conversation.participant_code ?? "读取英语会话"}</h2></div>
      <button type="button" autoFocus className="icon-button" aria-label="关闭英语会话详情" onClick={onClose}><X size={20}/></button>
    </header>
    {detail ? <div className="english-admin-detail-body">
      <div className="detail-meta"><span>{detail.messages.length} 条消息 · {detail.config.prompt_revision !== null ? "提示词 v" + detail.config.prompt_revision : "历史课程配置"}</span>
        <div className="record-actions"><button type="button" className="button secondary small" onClick={onExport}><ArrowDownToLine size={15}/>导出 JSON</button>
          {onDelete && <button type="button" className="button secondary small" disabled={deleting} onClick={onDelete}><Trash2 size={15}/>删除会话</button>}
        </div></div>
      <div className="detail-assignment"><strong>{englishAdminGroupLabel(detail.conversation.group_code)}</strong>
        <span>{detail.conversation.assigned_at ? "登记 " + formatDate(detail.conversation.assigned_at) : "历史记录"}</span></div>
      {detail.config.id !== null && detail.connection && <ConversationConnectionDetails connection={detail.connection} model={detail.config.settings.model}/>}
      <EnglishProgress state={detail.english_progress} course={detail.config.curriculum ? englishCourseOutline(detail.config.curriculum) : null}/>
      <details className="config-details"><summary>登记时 BOPPPS 流程内容</summary>
        {detail.config.curriculum ? englishStages.map(stage => <section className="english-admin-curriculum-snapshot" key={stage.id}>
          <h3>{stage.label}</h3><p>{detail.config.curriculum![stage.id].description}</p>
          {detail.config.curriculum![stage.id].activities.map((activity, index) => <div key={index}>
            <strong>活动 {index + 1} · {activity.title}</strong><p>学生任务</p><pre>{activity.prompt}</pre><p>达标条件</p><pre>{activity.criterion}</pre>
            {activity.word_limit && <p>英文正文 {activity.word_limit.min}–{activity.word_limit.max} 词</p>}
          </div>)}
        </section>) : <p>此历史记录未保存独立的 BOPPPS 课程内容快照。</p>}
      </details>
      <details className="config-details"><summary>登记时提示词与模型</summary>
        {detail.config.id === null ? <p>历史演示未保存模型与提示词快照，无法核实登记时的模型与提示词。</p> : <>
          <p>{detail.config.settings.model} · {detail.config.source_revision ? "共享模型来源 v" + detail.config.source_revision : "历史模型配置"}</p>
          <h3>基础教学提示词</h3><pre>{detail.config.base_prompt || detail.config.settings.system_prompt}</pre>
          <h3>人格提示词{detail.conversation.personality ? "（本组使用）" : "（本组不使用）"}</h3><pre>{detail.config.personality_prompt || "无独立人格提示词"}</pre>
        </>}
      </details>
      {detail.english_turns && <details className="config-details"><summary>课程判定与阶段记录（{detail.english_turns.length}）</summary>
        <p>模型判定需结合学生原回答复核。</p><pre>{JSON.stringify(detail.english_turns, null, 2)}</pre></details>}
      <div className="record-messages">{detail.messages.map(message => <article key={message.id} className={"record-message " + message.role}>
        <div><strong>{message.role === "user" ? "学生" : "英语助教"}</strong><span>{formatDate(message.created_at)} · {message.status === "complete" ? "已保存" : "未完成"}</span></div>
        <Markdown>{message.content || "（未返回文本）"}</Markdown>
      </article>)}</div>
      <div className="export-note">{detail.config.id === null ? "JSON 包含英语会话、学习进度与阶段记录；历史演示没有登记快照。" : "JSON 包含英语会话、登记快照、学习进度与阶段记录，不包含密钥。当前连接说明用于下一次请求，不代表历史消息实际使用的接口。"}</div>
    </div> : <div className="empty-state">
      {loading ? <><LoaderCircle size={24} className="spin"/><p role="status">正在读取英语会话详情…</p></> : <>
        <p role="alert">{error || "英语会话暂时无法读取。"}</p><button type="button" className="button secondary" onClick={onRetry}><RefreshCw size={16}/>重试读取</button>
      </>}
    </div>}
  </section>;
}
