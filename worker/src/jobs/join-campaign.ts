// Manual step: run this after YOU have actually joined a campaign on
// Whop/Ssemble's own site (no write API exists for that) and it has given
// you a link to the source content. This records the join, creates the
// creator as a `partners` row if needed, and writes the `rights_agreements`
// row — this one is a real, explicit license granted by the campaign's own
// terms, not the synthetic Twitch-ToS-based row the earlier approach needed.
//
// Usage: npm run join-campaign -- <campaign_id> <source_content_url>

import { supabase } from "../lib/supabase.js";

async function ensureCreatorPartner(name: string): Promise<string> {
  const { data: existing, error: selectError } = await supabase
    .from("partners")
    .select("id")
    .eq("name", name)
    .eq("partner_type", "creator")
    .maybeSingle();
  if (selectError) throw selectError;
  if (existing) return existing.id;

  const { data: inserted, error: insertError } = await supabase
    .from("partners")
    .insert({ name, partner_type: "creator" })
    .select("id")
    .single();
  if (insertError) throw insertError;
  return inserted.id;
}

async function joinCampaign(campaignId: string, sourceContentUrl: string) {
  const { data: campaign, error: campaignError } = await supabase
    .from("campaigns")
    .select("id, title, brand, raw")
    .eq("id", campaignId)
    .single();
  if (campaignError) throw campaignError;

  const partnerId = await ensureCreatorPartner(campaign.brand ?? campaign.title);

  const { error: rightsError } = await supabase.from("rights_agreements").insert({
    partner_id: partnerId,
    scope: `clip_reward_campaign: ${campaign.title}`,
    document_url: (campaign.raw as { campaignUrl?: string } | null)?.campaignUrl ?? null,
    status: "active",
  });
  if (rightsError) throw rightsError;

  const { error: updateError } = await supabase
    .from("campaigns")
    .update({
      status: "joined",
      joined_at: new Date().toISOString(),
      source_content_url: sourceContentUrl,
      partner_id: partnerId,
    })
    .eq("id", campaignId);
  if (updateError) throw updateError;

  console.log(`joined campaign "${campaign.title}" (partner ${partnerId})`);
}

const [, , campaignId, sourceContentUrl] = process.argv;
if (!campaignId || !sourceContentUrl) {
  console.error("usage: npm run join-campaign -- <campaign_id> <source_content_url>");
  process.exit(1);
}

joinCampaign(campaignId, sourceContentUrl)
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
