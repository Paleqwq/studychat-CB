import "server-only";
import type { RuntimeMode } from "@/lib/types";
import { dataBackend, publicCloudBaseConfig } from "@/lib/backend";

export function runtimeMode(): RuntimeMode {
  if (process.env.DEMO_MODE === "true" && process.env.NODE_ENV === "development" && !process.env.VERCEL) return "demo";
  try {
    if (dataBackend() === "cloudbase") {
      publicCloudBaseConfig();
      return process.env.CLOUDBASE_API_KEY && process.env.CONFIG_ENCRYPTION_KEY ? "live" : "setup";
    }
  } catch { return "setup"; }
  if (process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY &&
      process.env.SUPABASE_SECRET_KEY && process.env.CONFIG_ENCRYPTION_KEY) return "live";
  return "setup";
}

export function serverEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error("缺少服务端环境配置：" + name);
  return value;
}

export function databaseUpgradeMessage(legacyInstruction: string): string {
  return dataBackend() === "cloudbase"
    ? "CloudBase 业务数据库结构不完整，请联系管理员按部署指南核验已安装的 SQL；已有数据时勿重跑初始化脚本。"
    : legacyInstruction;
}
