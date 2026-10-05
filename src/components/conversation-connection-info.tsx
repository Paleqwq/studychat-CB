import type { ConversationConnectionInfo } from "@/lib/conversation-connection";

export function ConversationConnectionDetails({ connection, model }: {
  connection: ConversationConnectionInfo; model: string;
}) {
  return <details className="config-details" open>
    <summary>当前连接配置 · 下次请求生效</summary>
    {connection.source === "unavailable" ? <p role="status">当前未发布完整连接，请管理员检查地址和密钥后保存并发布。</p> : <>
      <p>{connection.source === "latest" ? "使用最新发布的连接 · 实验 v" + connection.experiment_revision : "历史未分组会话 · 保留登记时的连接"}</p>
      <p>{connection.settings?.protocol} · 原模型 ID：{model}</p>
      <pre>{connection.endpoint}</pre>
    </>}
    <p className="small-note">仅更新 API 地址、协议、认证及密钥；原模型 ID、提示词、分组、生成参数和历史消息不变。新接口须支持原模型 ID。</p>
    <p className="small-note">正在生成的回复不切换连接。此处与 JSON 导出仅说明当前连接，不代表历史消息实际使用的接口。</p>
  </details>;
}
