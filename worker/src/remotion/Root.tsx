// Registers one composition per aspect ratio the platforms need — 9:16
// (TikTok/Reels/Shorts, the primary target), 1:1, and 16:9 — all backed
// by the same RankingCountdown component. Duration is just the 5
// segments' clip lengths (the video starts immediately on song #5, no
// separate intro scene), plus a bit of extra trailing freeze on the
// final (#1) segment only, for a clean YouTube auto-thumbnail.

import type { CalculateMetadataFunction } from "remotion";
import { Composition, Folder } from "remotion";
import {
  RankingCountdown,
  segmentDurationInSeconds,
  introDurationInSeconds,
  type RankingCountdownProps,
} from "./RankingCountdown.js";
import { ChannelIcon } from "./ChannelIcon.js";
import { ChannelBanner } from "./ChannelBanner.js";

const FPS = 30;

// Extra hold on the last frame after the final clip ends. YouTube Shorts
// auto-picks its thumbnail from the video itself (no custom-thumbnail
// upload path via the Data API) — a deliberate freeze on a strong #1
// frame means whatever it grabs near the end looks intentional, not
// mid-motion blur. See RankingCountdown.tsx for where the freeze is
// applied.
const FREEZE_FRAMES = 15;

type Props = RankingCountdownProps;

// Note: rank 2's segment.durationInSeconds already includes
// FOLLOW_POPUP_SECONDS (set by render-ranking-videos.ts) — the popup
// overlays on top of #2's own extended clip rather than adding a
// separate scene, so no extra accounting is needed here.
const calculateMetadata: CalculateMetadataFunction<Props> = async ({ props }) => {
  const segmentFrames = props.segments.reduce((sum, segment, index) => {
    const isLast = index === props.segments.length - 1;
    return sum + Math.round(segmentDurationInSeconds(segment) * FPS) + (isLast ? FREEZE_FRAMES : 0);
  }, 0);
  const introFrames = props.introText ? Math.round(introDurationInSeconds(props.introDurationInSeconds) * FPS) : 0;
  return {
    durationInFrames: Math.max(1, introFrames + segmentFrames),
  };
};

const defaultProps: Props = {
  artistName: "Artist Name",
  sourceBadge: "LAST.FM",
  // Kept in sync with generate-ranking-render-metadata.ts's FEATURE_DISCLAIMER
  // — this used to say something different ("...— features not included")
  // and, because render-ranking-videos.ts was passing `undefined` (dropped
  // during JSON serialization, which makes Remotion fall back to this
  // exact default) instead of `null` for personal rankings, that stale
  // text was leaking onto real personal-ranking videos. Fixed at the
  // source now, but keeping this accurate too so a Studio preview never
  // shows something the real pipeline wouldn't.
  disclaimer: "Primary artist credit only",
  introText: "THE NUMBERS DON'T LIE 📊",
  introVoSrc: null,
  introDurationInSeconds: null,
  introAvatarUrl: null,
  introBgLoopSrc: null,
  segments: [5, 4, 3, 2, 1].map((rank) => ({
    videoSrc: "",
    rank,
    songTitle: `Song #${rank}`,
    metricLabel: null,
    durationInSeconds: 7.5,
  })),
};

export const RemotionRoot: React.FC = () => {
  return (
    <Folder name="RankingCountdown">
      <Composition
        id="RankingCountdown-9x16"
        component={RankingCountdown}
        fps={FPS}
        width={1080}
        height={1920}
        durationInFrames={FPS * 30}
        defaultProps={defaultProps}
        calculateMetadata={calculateMetadata}
      />
      <Composition
        id="RankingCountdown-1x1"
        component={RankingCountdown}
        fps={FPS}
        width={1080}
        height={1080}
        durationInFrames={FPS * 30}
        defaultProps={defaultProps}
        calculateMetadata={calculateMetadata}
      />
      <Composition
        id="RankingCountdown-16x9"
        component={RankingCountdown}
        fps={FPS}
        width={1920}
        height={1080}
        durationInFrames={FPS * 30}
        defaultProps={defaultProps}
        calculateMetadata={calculateMetadata}
      />
      <Composition
        id="ChannelIcon"
        component={ChannelIcon}
        fps={FPS}
        width={800}
        height={800}
        durationInFrames={1}
      />
      <Composition
        id="ChannelBanner"
        component={ChannelBanner}
        fps={FPS}
        width={2560}
        height={1440}
        durationInFrames={1}
      />
    </Folder>
  );
};
