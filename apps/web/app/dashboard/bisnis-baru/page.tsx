import { BUSINESS_TEMPLATES, FEATURE_INFO, FEATURE_KEYS } from "@jadwalin/core";
import Link from "next/link";
import { BusinessPicker, type TemplateCard } from "@/components/business-picker";
import { createBusinessAction } from "@/lib/actions";
import { requireUser } from "@/lib/server";

export const dynamic = "force-dynamic";

export default async function NewBusinessPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  await requireUser();
  const { error } = await searchParams;
  const templates: TemplateCard[] = BUSINESS_TEMPLATES.map((t) => ({
    id: t.id,
    name: t.name,
    group: t.group,
    tagline: t.tagline,
    example: t.example,
    meetingTypes: t.meetingTypes.map((m) => ({ title: m.title, durationMin: m.durationMin, depositIdr: m.depositIdr ?? 0, locationKind: m.locationKind, slotStepMin: m.slotStepMin ?? 0 })),
    availability: t.availability,
    nextSteps: t.nextSteps,
    features: t.features,
    featureWhy: t.featureWhy,
    nameLabel: t.nameLabel,
    kind: t.kind,
    products: t.products,
    personal: t.personal,
  }));
  const featureInfo = FEATURE_KEYS.map((key) => ({ key, ...FEATURE_INFO[key] }));
  return (
    <>
      <p><Link href="/dashboard">← Dashboard</Link></p>
      <h1>Buat halaman usaha</h1>
      <BusinessPicker templates={templates} featureInfo={featureInfo} action={createBusinessAction} error={error} />
    </>
  );
}
