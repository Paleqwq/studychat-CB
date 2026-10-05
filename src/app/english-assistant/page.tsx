import { runtimeMode } from "@/lib/server/env";
import { ParticipantChat } from "@/components/participant-chat";
import { SetupNotice } from "@/components/shared";
import { englishPublicSettings } from "@/lib/english-assistant";

export const dynamic = "force-dynamic";

export default async function EnglishAssistantPage() {
  const mode = runtimeMode();
  if (mode === "setup") return <SetupNotice/>;
  return <ParticipantChat key="english" mode={mode} assistantMode="english"
    requireCode={Boolean(process.env.ENGLISH_ASSISTANT_ACCESS_CODE)}
    initialSettings={englishPublicSettings()}/>;
}
