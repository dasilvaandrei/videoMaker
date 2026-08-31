"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";

async function currentUserId(): Promise<string> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("not authenticated");
  return user.id;
}

export async function approveClip(clipRenderId: string) {
  const supabase = await createClient();
  const reviewerId = await currentUserId();

  const { error } = await supabase.from("review_decisions").insert({
    clip_render_id: clipRenderId,
    reviewer_id: reviewerId,
    decision: "approved",
  });
  if (error) throw error;

  revalidatePath("/review");
}

export async function rejectClip(clipRenderId: string, notes: string) {
  const supabase = await createClient();
  const reviewerId = await currentUserId();

  const { error } = await supabase.from("review_decisions").insert({
    clip_render_id: clipRenderId,
    reviewer_id: reviewerId,
    decision: "rejected",
    notes: notes || null,
  });
  if (error) throw error;

  revalidatePath("/review");
}

// Records a substantive edit rather than a clean approval — this is what
// source_review_stats.edit_rate measures for autonomy graduation (plan §3).
// Still satisfies the posts-gate trigger (both 'approved' and 'edited' do)
// since the human is still saying "post this," just as-edited.
export async function editAndApproveClip(
  clipRenderId: string,
  editedCaption: string,
  editedHashtags: string[]
) {
  const supabase = await createClient();
  const reviewerId = await currentUserId();

  const { error } = await supabase.from("review_decisions").insert({
    clip_render_id: clipRenderId,
    reviewer_id: reviewerId,
    decision: "edited",
    edited_caption: editedCaption,
    edited_hashtags: editedHashtags,
  });
  if (error) throw error;

  revalidatePath("/review");
}
