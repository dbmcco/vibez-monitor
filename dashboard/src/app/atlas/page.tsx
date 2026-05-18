import AtlasClient from "./AtlasClient";
import { readAtlasArtifact } from "@/lib/atlas-artifact";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default function AtlasPage() {
  const artifact = readAtlasArtifact(48);
  return (
    <AtlasClient
      initialAtlas={artifact?.atlas || null}
      initialEditorialReport={artifact?.editorial_report || null}
    />
  );
}
