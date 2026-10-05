"use client";
import type { RefObject } from "react";
import { LoaderCircle, Trash2, X } from "lucide-react";
import { groupLabel, type ResearchConversation } from "@/lib/experiment";
import type { RuntimeMode } from "@/lib/types";

type Props = {
  dialogRef: RefObject<HTMLDialogElement | null>;
  conversation: ResearchConversation | null;
  mode: RuntimeMode;
  confirmation: string;
  deleting: boolean;
  error: string;
  onConfirmation: (value: string) => void;
  onConfirm: () => void;
  onClose: () => void;
};

export function ConversationDeleteDialog({ dialogRef, conversation, mode, confirmation, deleting, error,
  onConfirmation, onConfirm, onClose }: Props) {
  return <dialog ref={dialogRef} className="delete-dialog" role="alertdialog" aria-labelledby="delete-conversation-title"
    aria-describedby="delete-conversation-warning" onClose={onClose}
    onCancel={event => { event.preventDefault(); onClose(); }}
    onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="delete-content">
      <header><h2 id="delete-conversation-title">永久删除会话</h2><button type="button" className="icon-button" aria-label="取消删除"
        disabled={deleting} onClick={onClose}><X size={20}/></button></header>
      {conversation && <>
        <div className="delete-target"><strong>{conversation.student_id ?? conversation.participant_code}</strong>
          <span>{conversation.participant_code} · {groupLabel(conversation.group_code)}</span><p>{conversation.title}</p></div>
        <p id="delete-conversation-warning" className="delete-warning">将永久删除此会话的全部消息、请求记录和学号登记，网站内无法撤销。建议先导出 JSON 备份。</p>
        <p className="small-note">删除后，学号和原浏览器身份可重新登记，分组人数会减少；不会删除登录账号、其他会话或模型配置。正在生成回复的会话不能删除。</p>
        {mode === "demo" && <p className="small-note">演示模式只删除本浏览器的演示记录，不操作正式数据库。</p>}
        <form onSubmit={event => { event.preventDefault(); if (!deleting && confirmation === "删除") onConfirm(); }}>
          <label className="field"><span>请输入“删除”进行确认</span><input autoFocus value={confirmation} disabled={deleting}
            onChange={event => onConfirmation(event.target.value)} autoComplete="off" maxLength={2} placeholder="删除"/></label>
          {error && <p className="error-box" role="alert">{error}</p>}
          <div className="delete-actions"><button type="button" className="button secondary" disabled={deleting} onClick={onClose}>取消</button>
            <button type="submit" className="button primary" disabled={deleting || confirmation !== "删除"}>
              {deleting ? <LoaderCircle size={16} className="spin"/> : <Trash2 size={16}/>} {deleting ? "正在删除…" : "永久删除"}
            </button></div>
        </form>
      </>}
    </section>
  </dialog>;
}
