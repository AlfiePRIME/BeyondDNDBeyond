import { redirect } from "next/navigation";

// The campaigns list and create/join forms now live on Home (src/app/page.tsx).
export default function CampaignsPage() {
  redirect("/");
}
