/** Public backend configuration only. Never add server credentials to this module. */
export type DataBackend = "supabase" | "cloudbase";
export type PublicCloudBaseConfig = { envId: string; region: string; publishableKey: string };

export function dataBackend(): DataBackend {
  const value = process.env.NEXT_PUBLIC_DATA_BACKEND || "supabase";
  if (value !== "supabase" && value !== "cloudbase") throw new Error("后端类型配置无效，请检查 NEXT_PUBLIC_DATA_BACKEND。");
  return value;
}

export function publicCloudBaseConfig(): PublicCloudBaseConfig {
  // Literal reads are required for Next.js to inline public build variables.
  const envId = process.env.NEXT_PUBLIC_CLOUDBASE_ENV_ID || "";
  const region = process.env.NEXT_PUBLIC_CLOUDBASE_REGION || "ap-shanghai";
  const publishableKey = process.env.NEXT_PUBLIC_CLOUDBASE_PUBLISHABLE_KEY || "";
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(envId) ||
      !/^[a-z]{2}-[a-z]+(?:-[a-z0-9]+)*$/.test(region) || !publishableKey.trim()) {
    throw new Error("CloudBase 尚未配置，请检查环境 ID、地域和公开密钥。");
  }
  return { envId, region, publishableKey };
}

export function cloudBaseGateway(config: PublicCloudBaseConfig): string {
  // The China-site gateway is derived from a validated environment ID. Arbitrary
  // endpoints must never receive an access token or a service-role API key.
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(config.envId)) throw new Error("CloudBase 环境 ID 无效。");
  return `https://${config.envId}.api.tcloudbasegateway.com`;
}
