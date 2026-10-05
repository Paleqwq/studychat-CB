import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { ConversationConnectionDetails } from "@/components/conversation-connection-info";
import { describeConversationConnection } from "@/lib/conversation-connection";
import { defaultSettings } from "@/lib/types";
import { defaultExperiment } from "@/lib/experiment";

const publication = { settings: defaultExperiment(), revision: 9, created_at: "2026-10-02T09:00:00Z" };
const original = { ...defaultSettings, model: "original-model" };
describe("admin connection management explanations", () => {
  it("shows the current published version, protocol, endpoint and original model", () => {
    const html = renderToStaticMarkup(createElement(ConversationConnectionDetails, {
      connection: describeConversationConnection(original, "chatgpt", publication), model: original.model
    }));
    expect(html).toContain("实验 v9"); expect(html).toContain("original-model");
    expect(html).toContain("https://api.openai.com/v1/chat/completions");
    expect(html).toContain("原模型 ID、提示词、分组、生成参数和历史消息不变");
    expect(html).toContain("不代表历史消息实际使用的接口");
    expect(html).toContain("正在生成的回复不切换连接");
  });
  it("distinguishes legacy connections and unavailable published connections", () => {
    const legacy = renderToStaticMarkup(createElement(ConversationConnectionDetails, {
      connection: describeConversationConnection(original, null, publication), model: original.model
    }));
    expect(legacy).toContain("历史未分组会话"); expect(legacy).not.toContain("使用最新发布的连接");
    const unavailable = renderToStaticMarkup(createElement(ConversationConnectionDetails, {
      connection: describeConversationConnection(original, "chatgpt", null), model: original.model
    }));
    expect(unavailable).toContain('role="status"'); expect(unavailable).toContain("当前未发布完整连接");
  });
  it("escapes connection/model text and explains that publishing affects old conversations", () => {
    const html = renderToStaticMarkup(createElement(ConversationConnectionDetails, {
      connection: describeConversationConnection(original, "chatgpt", publication), model: "<script>bad()</script>"
    }));
    expect(html).not.toContain("<script>"); expect(html).toContain("&lt;script&gt;");
    const admin = readFileSync(new URL("../src/components/admin-panel.tsx", import.meta.url), "utf8");
    expect(admin).toContain("已分组旧会话下次请求");
    expect(admin).toContain("登记配置 v"); expect(admin).toContain("读取详情时的当前连接");
    expect(admin).not.toContain("已有学号的分组与配置保持不变");
  });
});
