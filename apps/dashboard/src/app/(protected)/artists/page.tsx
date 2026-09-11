import { createClient } from "@/lib/supabase/server";

interface SourceStats {
  source: string;
  reviewed_count: number;
  rejection_rate: number;
  edit_rate: number;
  approval_rate: number;
}

interface Artist {
  id: string;
  name: string;
}

interface RankingRow {
  artist_id: string;
  source: string;
  period_label: string;
  status: string;
  created_at: string;
}

function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}

const SOURCES = ["lastfm", "youtube", "personal"] as const;

export default async function ArtistsPage() {
  const supabase = await createClient();

  const [
    { data: stats, error: statsError },
    { data: artists, error: artistsError },
    { data: rankings, error: rankingsError },
  ] = await Promise.all([
    supabase.from("ranking_review_stats").select("*").returns<SourceStats[]>(),
    supabase.from("artists").select("id, name").order("name").returns<Artist[]>(),
    supabase
      .from("rankings")
      .select("artist_id, source, period_label, status, created_at")
      .order("created_at", { ascending: false })
      .returns<RankingRow[]>(),
  ]);

  if (statsError || artistsError || rankingsError) {
    return (
      <p className="text-red-400">
        Failed to load artist stats: {statsError?.message ?? artistsError?.message ?? rankingsError?.message}
      </p>
    );
  }

  const statsBySource = new Map((stats ?? []).map((s) => [s.source, s]));

  // rankings is already newest-first, so the first match per (artist,
  // source) key encountered is the latest one.
  const latestByKey = new Map<string, RankingRow>();
  for (const r of rankings ?? []) {
    const key = `${r.artist_id}::${r.source}`;
    if (!latestByKey.has(key)) latestByKey.set(key, r);
  }

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-xl font-semibold">Artists</h1>
        <p className="text-sm text-neutral-400">
          Tracked roster (worker/src/config/artists.json) and the latest ranking generated per source
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
            </tr>
          </thead>
          <tbody>
            {SOURCES.map((source) => {
              const row = statsBySource.get(source);
              return (
                <tr key={source} className="border-t border-neutral-800">
                  <td className="px-4 py-2 capitalize">{source}</td>
                  <td className="px-4 py-2">{row?.reviewed_count ?? 0}</td>
                  <td className="px-4 py-2">{row ? pct(row.approval_rate) : "—"}</td>
                  <td className="px-4 py-2">{row ? pct(row.rejection_rate) : "—"}</td>
                  <td className="px-4 py-2">{row ? pct(row.edit_rate) : "—"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="overflow-hidden rounded-lg border border-neutral-800">
        <table className="w-full text-left text-sm">
          <thead className="bg-neutral-900 text-neutral-400">
            <tr>
              <th className="px-4 py-2 font-medium">Artist</th>
              <th className="px-4 py-2 font-medium">Latest Last.fm ranking</th>
              <th className="px-4 py-2 font-medium">Latest YouTube ranking</th>
              <th className="px-4 py-2 font-medium">Latest personal ranking</th>
            </tr>
          </thead>
          <tbody>
            {(artists ?? []).map((artist) => (
              <tr key={artist.id} className="border-t border-neutral-800">
                <td className="px-4 py-2">{artist.name}</td>
                {SOURCES.map((source) => {
                  const latest = latestByKey.get(`${artist.id}::${source}`);
                  return (
                    <td key={source} className="px-4 py-2 text-neutral-400">
                      {latest ? `${latest.period_label} (${latest.status})` : "—"}
                    </td>
                  );
                })}
              </tr>
            ))}
            {(artists ?? []).length === 0 && (
              <tr>
                <td colSpan={4} className="px-4 py-6 text-center text-neutral-500">
                  No artists tracked yet — edit worker/src/config/artists.json.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
