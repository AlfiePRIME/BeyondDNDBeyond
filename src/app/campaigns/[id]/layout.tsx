import { requireUuid } from "@/app/lib/route-ids";

export default async function Layout({ children, params }: LayoutProps<"/campaigns/[id]">) {
  const { id } = await params;
  requireUuid(id);
  return children;
}
