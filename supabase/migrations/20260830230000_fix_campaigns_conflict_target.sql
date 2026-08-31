-- discover-campaigns.ts upserts on (campaign_platform_id, external_ref), but
-- Supabase's upsert generates a plain `ON CONFLICT (col, col) DO UPDATE`
-- with no WHERE clause, which can't match a partial unique index. A plain
-- (non-partial) unique index works fine here anyway — Postgres already
-- treats NULLs as distinct from each other in unique indexes, so the
-- `where external_ref is not null` predicate wasn't buying anything.

drop index if exists campaigns_external_ref_idx;
create unique index campaigns_external_ref_idx on campaigns(campaign_platform_id, external_ref);
