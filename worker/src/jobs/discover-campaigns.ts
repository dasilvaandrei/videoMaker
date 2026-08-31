import { supabase } from "../lib/supabase.js";
import { runActorSync } from "../lib/apify.js";

// Third-party (not Whop's own) actor that scrapes Whop's public Content
// Rewards directory — there's no official API for this. Pay-per-result
// pricing. Verified working against live data at build time; the
// alternative `tactful_anvil~whop-content-rewards-scraper` actor was tried
// first and is currently broken (site-structure drift on contentrewards.com
// — got real 200 responses but parsed 0 campaigns), so this one is the
// default. Override via env if either changes.
const ACTOR_ID = process.env.APIFY_WHOP_ACTOR_ID || "fayoussef~whop-clipping-campaigns-scraper";

// Field names confirmed against a real actor run (see git history for the
// raw sample). Everything is also kept in `raw` regardless.
interface WhopCampaignRow {
  id: string;
  title: string;
  brand?: string;
  campaignUrl: string;
  description?: string;
  rewardPerThousandUsd?: number;
  totalBudgetUsd?: number;
  budgetSpentUsd?: number;
  budgetLeftUsd?: number;
  socialPlatforms?: string[];
  requiresApplication?: boolean;
  [key: string]: unknown;
}

async function getCampaignPlatformId(name: "whop" | "ssemble"): Promise<string> {
  const { data, error } = await supabase.from("campaign_platforms").select("id").eq("name", name).single();
  if (error) throw error;
  return data.id;
}

export async function discoverCampaigns() {
  const campaignPlatformId = await getCampaignPlatformId("whop");

  const rows = await runActorSync<WhopCampaignRow>(ACTOR_ID, {});

  console.log(`discovered ${rows.length} live Whop campaigns`);

  for (const row of rows) {
    if (!row.id) {
      console.warn("skip campaign row with no id", row);
      continue;
    }

    // Upsert only touches the columns listed below, so a campaign a human
    // already joined (status/joined_at/source_content_url set) keeps that
    // local state across re-runs — this just refreshes the live listing data.
    const { error } = await supabase.from("campaigns").upsert(
      {
        campaign_platform_id: campaignPlatformId,
        external_ref: row.id,
        title: row.title ?? "untitled campaign",
        brand: row.brand,
        campaign_type: "clipping",
        description: row.description,
        rate_per_1k_views_usd: row.rewardPerThousandUsd,
        budget_usd: row.totalBudgetUsd,
        budget_spent_usd: row.budgetSpentUsd,
        budget_remaining_usd: row.budgetLeftUsd,
        allowed_platforms: row.socialPlatforms ?? [],
        requires_application: row.requiresApplication ?? false,
        raw: row,
      },
      { onConflict: "campaign_platform_id,external_ref" }
    );
    if (error) throw error;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  discoverCampaigns()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
