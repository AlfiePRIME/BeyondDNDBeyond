import { requireUuid } from "@/app/lib/route-ids";

export default async function Layout({ children, params }: LayoutProps<"/campaigns/[id]/maps/[mapId]">) {
  const { mapId } = await params;
  requireUuid(mapId);
  return children;
}
