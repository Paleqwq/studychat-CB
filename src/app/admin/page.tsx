import { runtimeMode } from "@/lib/server/env";
import { AdminPanel } from "@/components/admin-panel";
import { SetupNotice } from "@/components/shared";
export const dynamic = "force-dynamic";
export default function AdminPage() {
  const mode = runtimeMode();
  if (mode === "setup") return <SetupNotice admin/>;
  return <AdminPanel mode={mode}/>;
}
