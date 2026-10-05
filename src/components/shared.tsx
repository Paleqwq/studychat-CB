import { MessageCircle, ShieldCheck, Settings2, ArrowUpRight } from "lucide-react";

export function ChatMark({ size = 24 }: { size?: number }) {
  return <MessageCircle size={size} strokeWidth={1.65} aria-hidden="true"/>;
}

export function Brand({ admin = false }: { admin?: boolean }) {
  return <div className="brand"><span className="brand-mark"><ChatMark/></span>
    <span>{admin ? "研究控制台" : "学习对话"}</span></div>;
}
export function DemoBanner() {
  return <div className="demo-banner"><span className="demo-dot"/>本地演示<span className="demo-detail">仅保存到当前浏览器 · 未连接 AI 与数据库</span></div>;
}
export function SetupNotice({ admin = false }: { admin?: boolean }) {
  return <main className="setup-shell"><Brand admin={admin}/><div className="setup-card">
    <span className="setup-icon"><Settings2 size={28}/></span>
    <h1>站点尚未配置</h1><p>请由管理员完成数据库与服务端配置，完成前暂不接受对话。</p>
    <ol><li>创建对应后端的数据库并执行初始化或升级脚本。</li><li>配置公开构建变量、服务器环境变量与匿名登录。</li><li>添加管理员，登录后台发布模型和提示词。</li></ol>
    <div className="info-note"><ShieldCheck size={18}/>在配置完成前，不会发送或保存任何对话内容。</div>
    {!admin && <a className="text-link" href="/admin">管理员入口<ArrowUpRight size={15}/></a>}
  </div></main>;
}
