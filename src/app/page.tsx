import { runtimeMode } from "@/lib/server/env";
import { ParticipantChat } from "@/components/participant-chat";
import { SetupNotice } from "@/components/shared";
import { currentExperiment } from "@/lib/server/settings";
import { defaultSettings } from "@/lib/types";
import { participantSettings } from "@/lib/participant-presentation";
export const dynamic = "force-dynamic";
export default async function Page() {
  const mode = runtimeMode();
  if (mode === "setup") return <SetupNotice/>;
  // Public presentation only. Never pass experimental factors or prompts to the client.
  const current = mode === "live" ? await currentExperiment().catch(() => null) : null;
  return <ParticipantChat mode={mode} requireCode={Boolean(process.env.STUDY_ACCESS_CODE)}
    initialSettings={participantSettings(current?.config?.settings ?? defaultSettings)}/>;
}
