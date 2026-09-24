import { requireUuid } from "@/app/lib/route-ids";

export default async function Layout({ children, params }: LayoutProps<"/campaigns/[id]/lore/[pageId]">) {
  const { pageId } = await params;
  requireUuid(pageId);
  return children;
}
