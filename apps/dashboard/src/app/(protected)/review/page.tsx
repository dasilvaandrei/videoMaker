import { createClient } from "@/lib/supabase/server";
import { ReviewCard } from "./ReviewCard";

const MEDIA_BUCKET = "media";
const SIGNED_URL_TTL_SECONDS = 60 * 60;

interface PendingReview {
  clip_render_id: string;
  aspect_ratio: "9:16" | "1:1" | "16:9";
  storage_path: string | null;
  hook_text: string | null;
  caption: string | null;
  hashtags: string[] | null;
  predicted_virality_score: number | null;
  moment_type: string | null;
  start_seconds: number;
  end_seconds: number;
}

export default async function ReviewPage() {
  const supabase = await createClient();

  const { data: pending, error } = await supabase
    .from("pending_reviews")
    .select(
      "clip_render_id, aspect_ratio, storage_path, hook_text, caption, hashtags, predicted_virality_score, moment_type, start_seconds, end_seconds"
    )
    .order("predicted_virality_score", { ascending: false, nullsFirst: false })
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
          {rows.length} clip{rows.length === 1 ? "" : "s"} awaiting a decision
        </p>
      </div>

      {rows.length === 0 && (
        <p className="text-neutral-500">Nothing to review right now.</p>
      )}

      <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
        {withUrls.map((row) => (
          <ReviewCard key={row.clip_render_id} clip={row} />
        ))}
      </div>
    </div>
  );
}
