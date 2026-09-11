import { createClient } from "@/lib/supabase/server";
import { ReviewCard } from "./ReviewCard";

const MEDIA_BUCKET = "media";
const SIGNED_URL_TTL_SECONDS = 60 * 60;

interface LineupEntry {
  rank: number;
  song_title: string;
  metric_label: string | null;
  note: string | null;
}

interface PendingReview {
  ranking_video_id: string;
  ranking_id: string;
  aspect_ratio: "9:16" | "1:1" | "16:9";
  storage_path: string | null;
  title: string | null;
  caption: string | null;
  hashtags: string[] | null;
  source: string;
  period_label: string;
  artist_name: string;
  lineup: LineupEntry[] | null;
}

export default async function ReviewPage() {
  const supabase = await createClient();

  const { data: pending, error } = await supabase
    .from("pending_reviews")
    .select(
      "ranking_video_id, ranking_id, aspect_ratio, storage_path, title, caption, hashtags, source, period_label, artist_name, lineup"
    )
    .order("created_at", { ascending: true })
    .returns<PendingReview[]>();

  if (error) {
    return <p className="text-red-400">Failed to load pending reviews: {error.message}</p>;
  }

  const rows = pending ?? [];

  const withUrls = await Promise.all(
    rows.map(async (row) => {
      if (!row.storage_path) return { ...row, videoUrl: null };
      const { data } = await supabase.storage
        .from(MEDIA_BUCKET)
        .createSignedUrl(row.storage_path, SIGNED_URL_TTL_SECONDS);
      return { ...row, videoUrl: data?.signedUrl ?? null };
    })
  );

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">Review queue</h1>
        <p className="text-sm text-neutral-400">
          {rows.length} video{rows.length === 1 ? "" : "s"} awaiting a decision
        </p>
      </div>

      {rows.length === 0 && (
        <p className="text-neutral-500">Nothing to review right now.</p>
      )}

      <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
        {withUrls.map((row) => (
          <ReviewCard key={row.ranking_video_id} video={row} />
        ))}
      </div>
    </div>
  );
}
