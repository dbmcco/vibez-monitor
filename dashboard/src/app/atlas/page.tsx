import AtlasClient from "./AtlasClient";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default function AtlasPage() {
  return <AtlasClient />;
}
