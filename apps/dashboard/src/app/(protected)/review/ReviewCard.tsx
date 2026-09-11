"use client";

import { useState, useTransition } from "react";
import { approveClip, editAndApproveClip, rejectClip } from "./actions";

interface LineupEntry {
  rank: number;
  song_title: string;
  metric_label: string | null;
  note: string | null;
}

interface ReviewVideo {
  ranking_video_id: string;
  aspect_ratio: "9:16" | "1:1" | "16:9";
  title: string | null;
  caption: string | null;
  hashtags: string[] | null;
  source: string;
  artist_name: string;
  lineup: LineupEntry[] | null;
  videoUrl: string | null;
}

const SOURCE_LABEL: Record<string, string> = {
  lastfm: "Last.fm",
  youtube: "YouTube",
  personal: "My picks",
};

export function ReviewCard({ video }: { video: ReviewVideo }) {
  const [isPending, startTransition] = useTransition();
  const [mode, setMode] = useState<"view" | "edit" | "reject">("view");
  const [caption, setCaption] = useState(video.caption ?? "");
  const [hashtags, setHashtags] = useState((video.hashtags ?? []).join(" "));
  const [rejectNotes, setRejectNotes] = useState("");
  const [done, setDone] = useState(false);

  if (done) {
    return (
      <div className="flex items-center justify-center rounded-lg border border-neutral-800 bg-neutral-900 p-6 text-sm text-neutral-500">
        Decision recorded.
      </div>
    );
  }

  return (
    <div className="flex flex-col overflow-hidden rounded-lg border border-neutral-800 bg-neutral-900">
      {video.videoUrl ? (
        <video
          src={video.videoUrl}
          controls
          preload="metadata"
          className="aspect-[9/16] w-full bg-black object-contain"
        />
      ) : (
        <div className="flex aspect-[9/16] w-full items-center justify-center bg-black text-sm text-neutral-600">
          No preview available
        </div>
      )}

      <div className="space-y-2 p-4 text-sm">
        <div className="flex items-center justify-between text-xs text-neutral-500">
          <span>{video.artist_name}</span>
          <span>{SOURCE_LABEL[video.source] ?? video.source}</span>
        </div>

        <p className="font-medium text-neutral-100">{video.title}</p>

        <ol className="space-y-1 text-xs text-neutral-400">
          {(video.lineup ?? [])
            .slice()
            .sort((a, b) => a.rank - b.rank)
            .map((entry) => (
              <li key={entry.rank} className="flex justify-between gap-2">
                <span>
                  #{entry.rank} {entry.song_title}
                </span>
                <span className="text-neutral-500">{entry.metric_label ?? entry.note ?? ""}</span>
              </li>
            ))}
        </ol>

        {mode === "edit" ? (
          <div className="space-y-2">
            <textarea
              value={caption}
              onChange={(e) => setCaption(e.target.value)}
              rows={2}
              className="w-full rounded border border-neutral-700 bg-neutral-950 p-2 text-neutral-100"
            />
            <input
              value={hashtags}
              onChange={(e) => setHashtags(e.target.value)}
              className="w-full rounded border border-neutral-700 bg-neutral-950 p-2 text-neutral-100"
              placeholder="space-separated hashtags"
            />
          </div>
        ) : (
          <p className="text-neutral-400">{video.caption}</p>
        )}

        {mode === "reject" && (
          <textarea
            value={rejectNotes}
            onChange={(e) => setRejectNotes(e.target.value)}
            rows={2}
            placeholder="Why is this being rejected? (optional)"
            className="w-full rounded border border-neutral-700 bg-neutral-950 p-2 text-neutral-100"
          />
        )}

        <div className="flex flex-wrap gap-2 pt-2">
          {mode === "view" && (
            <>
              <button
                disabled={isPending}
                onClick={() =>
                  startTransition(async () => {
                    await approveClip(video.ranking_video_id);
                    setDone(true);
                  })
                }
                className="rounded bg-emerald-600 px-3 py-1.5 font-medium text-white disabled:opacity-50"
              >
                Approve
              </button>
              <button
                disabled={isPending}
                onClick={() => setMode("edit")}
                className="rounded border border-neutral-700 px-3 py-1.5 text-neutral-200 disabled:opacity-50"
              >
                Edit
              </button>
              <button
                disabled={isPending}
                onClick={() => setMode("reject")}
                className="rounded border border-red-900 px-3 py-1.5 text-red-400 disabled:opacity-50"
              >
                Reject
              </button>
            </>
          )}

          {mode === "edit" && (
            <>
              <button
                disabled={isPending}
                onClick={() =>
                  startTransition(async () => {
                    const parsedHashtags = hashtags
                      .split(/\s+/)
                      .map((h) => h.replace(/^#/, "").trim())
                      .filter(Boolean);
                    await editAndApproveClip(video.ranking_video_id, caption, parsedHashtags);
                    setDone(true);
                  })
                }
                className="rounded bg-emerald-600 px-3 py-1.5 font-medium text-white disabled:opacity-50"
              >
                Save & approve
              </button>
              <button
                disabled={isPending}
                onClick={() => setMode("view")}
                className="rounded border border-neutral-700 px-3 py-1.5 text-neutral-200 disabled:opacity-50"
              >
                Cancel
              </button>
            </>
          )}

          {mode === "reject" && (
            <>
              <button
                disabled={isPending}
                onClick={() =>
                  startTransition(async () => {
                    await rejectClip(video.ranking_video_id, rejectNotes);
                    setDone(true);
                  })
                }
                className="rounded bg-red-700 px-3 py-1.5 font-medium text-white disabled:opacity-50"
              >
                Confirm reject
              </button>
              <button
                disabled={isPending}
                onClick={() => setMode("view")}
                className="rounded border border-neutral-700 px-3 py-1.5 text-neutral-200 disabled:opacity-50"
              >
                Cancel
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
