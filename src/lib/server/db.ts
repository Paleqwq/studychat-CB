import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { PostgrestClient } from "@supabase/postgrest-js";
import { dataBackend, publicCloudBaseConfig, cloudBaseGateway } from "@/lib/backend";
import { serverEnv } from "./env";
import { verifyCloudBaseToken } from "./cloudbase-auth";

export type AppUser = { id: string; is_anonymous?: boolean; email?: string };
export type AppDatabase = Pick<SupabaseClient, "from" | "rpc"> & {
  auth: { getUser(token: string): Promise<{ data: { user: AppUser | null }; error: unknown | null }> };
};

let instance: AppDatabase | undefined;
export function db(): AppDatabase {
  if (instance) return instance;
  if (dataBackend() === "cloudbase") {
    const config = publicCloudBaseConfig();
    const rest = new PostgrestClient(`${cloudBaseGateway(config)}/v1/rdb/rest`, {
      schema: "public",
      headers: { Authorization: `Bearer ${serverEnv("CLOUDBASE_API_KEY")}` },
      fetch: (input, init) => fetch(input, {
        ...init, redirect: "error", cache: "no-store",
        signal: init?.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000)
      })
    });
    instance = {
      from: rest.from.bind(rest) as AppDatabase["from"],
      rpc: rest.rpc.bind(rest) as AppDatabase["rpc"],
      auth: { async getUser(token) {
        const identity = await verifyCloudBaseToken(token, config);
        const { data, error } = await rest.rpc("get_or_create_app_user", { p_subject: identity.subject });
        if (error || !data || typeof data.id !== "string" ||
            !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(data.id) ||
            data.cloudbase_subject !== identity.subject) {
          // HTTP auth catches this as an unavailable service, never an expired
          // login. Do not include database responses or credentials in errors.
          throw new Error("CloudBase 身份映射暂不可用。");
        }
        return { data: { user: { id: data.id, is_anonymous: identity.isAnonymous, email: identity.email } }, error: null };
      } }
    };
    return instance;
  }
  instance = createClient(serverEnv("NEXT_PUBLIC_SUPABASE_URL"), serverEnv("SUPABASE_SECRET_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false }
  });
  return instance;
}
