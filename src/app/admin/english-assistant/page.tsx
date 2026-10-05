import { EnglishAdminPanel } from "@/components/english-admin-panel";
import { SetupNotice } from "@/components/shared";
import { runtimeMode } from "@/lib/server/env";

export const dynamic = "force-dynamic";

export default function EnglishAssistantAdminPage() {
  const mode = runtimeMode();
  if (mode === "setup") return <SetupNotice admin/>;
  return <EnglishAdminPanel mode={mode}/>;
}
