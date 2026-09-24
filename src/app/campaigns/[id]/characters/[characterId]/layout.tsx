import { requireUuid } from "@/app/lib/route-ids";

export default async function Layout({ children, params }: LayoutProps<"/campaigns/[id]/characters/[characterId]">) {
  const { characterId } = await params;
  requireUuid(characterId);
  return children;
}
