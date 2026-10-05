"use client";

import type { RefObject } from "react";
import { LoaderCircle, RefreshCw, Trash2, X } from "lucide-react";
import type { EnglishResearchConversation } from "@/lib/english-groups";
import type { RuntimeMode } from "@/lib/types";
import { englishAdminGroupLabel } from "./english-admin-views";

export function EnglishDeleteDialog({ dialogRef, conversation, messageCount, loading, mode, confirmation, deleting, error,
  onConfirmation, onConfirm, onClose, onRetryDetails }: {
  dialogRef: RefObject<HTMLDialogElement | null>; conversation: EnglishResearchConversation | null;
  messageCount: number | null; loading: boolean; mode: RuntimeMode; confirmation: string; deleting: boolean; error: string;
  onConfirmation: (value: string) => void; onConfirm: () => void; onClose: () => void; onRetryDetails: () => void;
}) {
  const ready = Boolean(conversation && messageCount !== null && !loading && !deleting && confirmation === conversation.student_id);
  return <dialog ref={dialogRef} className="delete-dialog english-admin-delete-dialog" role="alertdialog"
    aria-labelledby="english-delete-title" aria-describedby="english-delete-warning" onClose={onClose}
    onCancel={event => { event.preventDefault(); onClose(); }} onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="delete-content"><header><h2 id="english-delete-title">永久删除英语会话</h2>
      <button type="button" className="icon-button" aria-label="取消删除英语会话" disabled={deleting} onClick={onClose}><X size={20}/></button></header>
      {conversation && <>
        <div className="delete-target"><strong>{conversation.student_id}</strong><span>{conversation.participant_code} · {englishAdminGroupLabel(conversation.group_code)}</span>
          <p>{conversation.title}</p><p>{loading ? "正在读取消息数量…" : messageCount === null ? "消息数量暂时无法读取" : messageCount + " 条英语消息"} · {conversation.request_count} 次请求</p></div>
        <p id="english-delete-warning" className="delete-warning">将永久删除该学生的英语会话、全部英语消息、学习进度与阶段记录，并释放本次英语学号登记。网站内无法撤销，建议先导出 JSON。</p>
        <p className="small-note">英语分组人数会减少，删除后可重新登记英语课程。正在生成回复的英语会话不能删除。</p>
        {mode === "demo" && <p className="small-note">演示模式只删除本浏览器的英语演示记录。</p>}
        {error && <p className="error-box" role="alert">{error}</p>}
        {messageCount === null && !loading && <button type="button" className="button secondary small" disabled={deleting} onClick={onRetryDetails}><RefreshCw size={14}/>重试读取消息数量</button>}
        <form onSubmit={event => { event.preventDefault(); if (ready) onConfirm(); }}>
          <label className="field"><span>请输入学号 {conversation.student_id} 确认删除</span><input autoFocus value={confirmation} maxLength={32} disabled={deleting}
            onChange={event => onConfirmation(event.target.value)} placeholder={conversation.student_id} autoComplete="off" autoCapitalize="characters" spellCheck={false}/></label>
          <div className="delete-actions"><button type="button" className="button secondary" disabled={deleting} onClick={onClose}>取消</button>
            <button type="submit" className="button primary" disabled={!ready}>{deleting ? <LoaderCircle size={16} className="spin"/> : <Trash2 size={16}/>}{deleting ? "正在删除…" : "永久删除英语会话"}</button></div>
        </form>
      </>}
    </section>
  </dialog>;
}
