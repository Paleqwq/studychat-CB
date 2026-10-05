"use client";
import { useState } from "react";
import { bloomGuidancePreset } from "@/lib/bloom-preset";

export function BasePromptPresets({ value, onApply, disabled = false }: {
  value: string; onApply: (value: string) => void; disabled?: boolean;
}) {
  const [selected, setSelected] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [previous, setPrevious] = useState<string | null>(null);
  const same = value === bloomGuidancePreset;
  return <div className="prompt-presets">
    <label className="field"><span>预设基础模型提示词</span>
      <select value={selected} disabled={disabled} onChange={e => { setSelected(e.target.value); setConfirmed(false); }}>
        <option value="">保留当前提示词</option>
        <option value="bloom">Bloom 引导式学习 · 自适应认知层级</option>
      </select>
      <small>选择仅用于预览，不会自动替换或发布。预设只作用于共用基础提示词，不修改人格提示词。</small>
    </label>
    {selected === "bloom" && <>
      <details className="preset-preview"><summary>查看完整 Bloom 引导预设</summary><pre>{bloomGuidancePreset}</pre></details>
      <p className="small-note">第一轮由提示词引导并判定目标能力；发题、题序、两轮切换和第二轮记录由「题目问答」程序控制。</p>
      {!same && value.trim() && <label className="entry-confirm"><input type="checkbox" checked={confirmed}
        disabled={disabled} onChange={e => setConfirmed(e.target.checked)}/><span>我确认替换当前基础提示词编辑区（尚未发布）</span></label>}
      <div className="preset-actions"><button type="button" className="button secondary small"
        disabled={disabled || same || Boolean(value.trim() && !confirmed)}
        onClick={() => { setPrevious(value); onApply(bloomGuidancePreset); setConfirmed(false); }}>
        {same ? "编辑区已使用此预设" : "应用 Bloom 预设到编辑区"}
      </button>
      {previous !== null && <button type="button" className="button text small" disabled={disabled}
        onClick={() => { onApply(previous); setPrevious(null); setConfirmed(false); }}>撤销本次预设替换</button>}</div>
      <p className="small-note">应用后仍须点击「保存并发布」才生效；已有学生会话继续使用登记时的提示词。</p>
    </>}
  </div>;
}
