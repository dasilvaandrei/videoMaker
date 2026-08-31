import { createClient } from "@/lib/supabase/server";

interface SourceStats {
  partner_id: string;
  reviewed_count: number;
  rejection_rate: number;
  edit_rate: number;
  approval_rate: number;
}

interface Partner {
  id: string;
  name: string;
}

function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}

export default async function SourcesPage() {
  const supabase = await createClient();

  const [{ data: stats, error: statsError }, { data: partners, error: partnersError }] =
    await Promise.all([
      supabase.from("source_review_stats").select("*").returns<SourceStats[]>(),
      supabase.from("partners").select("id, name").returns<Partner[]>(),
    ]);

  if (statsError || partnersError) {
    return (
      <p className="text-red-400">
        Failed to load source stats: {statsError?.message ?? partnersError?.message}
      </p>
    );
  }

  const partnerName = new Map((partners ?? []).map((p) => [p.id, p.name]));

  // Graduation thresholds from the plan (§3): rejection_rate < 10% and
  // edit_rate < 20% over a trailing 30 reviewed renders. Not wired to
  // automatic graduation yet (Phase 8) — this page is the human-visible
  // signal of a source approaching that bar.
  const GRADUATION_MIN_REVIEWED = 30;
  const GRADUATION_MAX_REJECTION = 0.1;
  const GRADUATION_MAX_EDIT = 0.2;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">Sources</h1>
        <p className="text-sm text-neutral-400">
          Rolling review quality over the trailing 30 decisions per source
        </p>
      </div>

      <div className="overflow-hidden rounded-lg border border-neutral-800">
        <table className="w-full text-left text-sm">
          <thead className="bg-neutral-900 text-neutral-400">
            <tr>
              <th className="px-4 py-2 font-medium">Source</th>
              <th className="px-4 py-2 font-medium">Reviewed</th>
              <th className="px-4 py-2 font-medium">Approval rate</th>
              <th className="px-4 py-2 font-medium">Rejection rate</th>
              <th className="px-4 py-2 font-medium">Edit rate</th>
              <th className="px-4 py-2 font-medium">Eligible for autonomy</th>
            </tr>
          </thead>
          <tbody>
            {(stats ?? []).map((row) => {
              const eligible =
                row.reviewed_count >= GRADUATION_MIN_REVIEWED &&
                row.rejection_rate < GRADUATION_MAX_REJECTION &&
                row.edit_rate < GRADUATION_MAX_EDIT;

              return (
                <tr key={row.partner_id} className="border-t border-neutral-800">
                  <td className="px-4 py-2">{partnerName.get(row.partner_id) ?? row.partner_id}</td>
                  <td className="px-4 py-2">{row.reviewed_count}</td>
                  <td className="px-4 py-2">{pct(row.approval_rate)}</td>
                  <td className="px-4 py-2">{pct(row.rejection_rate)}</td>
                  <td className="px-4 py-2">{pct(row.edit_rate)}</td>
                  <td className="px-4 py-2">
                    {eligible ? (
                      <span className="text-emerald-400">yes</span>
                    ) : (
                      <span className="text-neutral-600">not yet</span>
                    )}
                  </td>
                </tr>
              );
            })}
            {(stats ?? []).length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-6 text-center text-neutral-500">
                  No reviewed clips yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
