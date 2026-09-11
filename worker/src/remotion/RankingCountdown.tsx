// The countdown composition every ranking video goes through: starts
// immediately on song #5 (no separate intro scene) under a persistent,
// multi-color title header, with a "scoreboard" sidebar (see
// ScoreboardSidebar) that fills in with each song's title as it's
// revealed and keeps every prior one visible — by the final segment the
// whole board is lit up. Visual language (gradient scrim, Anton/Inter
// fonts, freeze-on-last-frame for a clean auto-thumbnail) carried over
// from the old HighlightClip.tsx, which this composition replaces now
// that a "render" means 5 clips stitched together, not one.

import {
  AbsoluteFill,
  Audio,
  Freeze,
  OffthreadVideo,
  Series,
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { loadFont as loadRankFont } from "@remotion/google-fonts/Anton";
import { loadFont as loadBodyFont } from "@remotion/google-fonts/Inter";

const { fontFamily: rankFontFamily } = loadRankFont();
const { fontFamily: bodyFontFamily } = loadBodyFont("normal", {
  weights: ["400", "700"],
  subsets: ["latin"],
});

export interface RankingSegmentData {
  videoSrc: string;
  rank: number;
  songTitle: string;
  metricLabel: string | null;
  // Real length of the licensed song clip — this drives the segment's
  // on-screen time directly (see resolve-song-clips.ts for why it's set
  // where it is: long enough to actually hear the song, short enough to
  // stay a reasonable countdown-video length).
  durationInSeconds: number;
}

export type RankingCountdownProps = {
  artistName: string;
  sourceBadge: string;
  // Small print shown under the header — the "primary artist credit
  // only, no features" caveat on automated (Last.fm/YouTube) rankings,
  // since those sources rank by the artist's *own* catalog and silently
  // miss their biggest feature/collab hits (e.g. a Bzrp Music Session
  // credited to the producer, not the featured vocalist). Personal
  // rankings have no need for this.
  disclaimer?: string;
  // Short "ding" sound played at the start of every segment (the
  // scoreboard's rank-advance pattern interrupt). Optional so the
  // composition still works without it (e.g. Studio preview).
  sfxSrc?: string;
  // Ordered 5 -> 1, i.e. playback order (the reveal builds to #1).
  segments: RankingSegmentData[];
};

export function segmentDurationInSeconds(segment: RankingSegmentData): number {
  return segment.durationInSeconds;
}

// Interstitial between #2 and #1 — the suspense beat right before the
// reveal is exactly when a viewer is most locked in, so it's the best
// place in the video to ask for a follow without costing retention.
//
// This overlays on top of #2's own clip for its last FOLLOW_POPUP_SECONDS
// rather than cutting to a separate silent scene — render-ranking-videos.ts
// already downloads more of #2's clip than it normally displays (the
// shared 9.5s download vs. the usual 7.5s on-screen length), specifically
// so this extra stretch has real, already-licensed audio to keep playing
// under the popup instead of dead silence.
export const FOLLOW_POPUP_SECONDS = 1.6;

const FollowPopup: React.FC<{ frame: number }> = ({ frame }) => {
  const { fps, width } = useVideoConfig();

  const scale = spring({
    frame,
    fps,
    config: { damping: 9, stiffness: 140, mass: 0.6 },
  });
  const opacity = interpolate(frame, [0, 6], [0, 1], { extrapolateRight: "clamp" });

  return (
    <AbsoluteFill style={{ backgroundColor: "black", justifyContent: "center", alignItems: "center" }}>
      <div style={{ transform: `scale(${scale})`, opacity, textAlign: "center" }}>
        <div
          style={{
            fontFamily: rankFontFamily,
            fontSize: width * 0.15,
            color: "#FF3B30",
            WebkitTextStroke: "5px black",
            textTransform: "uppercase",
            lineHeight: 1,
          }}
        >
          Follow
        </div>
        <div
          style={{
            fontFamily: rankFontFamily,
            fontSize: width * 0.09,
            color: "white",
            WebkitTextStroke: "4px black",
            textTransform: "uppercase",
            marginTop: width * 0.02,
          }}
        >
          for more 👉
        </div>
      </div>
    </AbsoluteFill>
  );
};

// Cycled per word across the header title — "make it pop" rather than a
// flat white/uppercase treatment.
const HEADER_COLORS = ["#FF3B30", "#34C759", "#FFCC00", "#2E9BFF"];

// Persistent header, shown for the whole video (not a separate intro
// scene) — the video starts immediately on song #5.
const Header: React.FC<{ artistName: string; sourceBadge: string; disclaimer?: string }> = ({
  artistName,
  sourceBadge,
  disclaimer,
}) => {
  const { width, height } = useVideoConfig();
  const titleText = sourceBadge ? `${sourceBadge} ${artistName} — Top 5 Songs` : `${artistName} — Top 5 Songs`;
  const words = titleText.split(" ");

  return (
    <div
      style={{
        position: "absolute",
        top: height * 0.135,
        left: width * 0.05,
        right: width * 0.05,
        textAlign: "center",
      }}
    >
      <div
        style={{
          fontFamily: rankFontFamily,
          fontSize: width * 0.062,
          textTransform: "uppercase",
          WebkitTextStroke: "3px black",
          lineHeight: 1.05,
        }}
      >
        {words.map((word, i) => (
          <span key={i} style={{ color: HEADER_COLORS[i % HEADER_COLORS.length] }}>
            {word}
            {i < words.length - 1 ? " " : ""}
          </span>
        ))}
      </div>
      {disclaimer && (
        <div
          style={{
            fontFamily: bodyFontFamily,
            fontWeight: 400,
            fontSize: width * 0.026,
            color: "#c9c9c9",
            marginTop: 6,
            textShadow: "0 1px 4px rgba(0,0,0,0.9)",
          }}
        >
          {disclaimer}
        </div>
      )}
    </div>
  );
};

// Bottom of the stack is #5 (where the video starts) and it climbs to #1
// at the top — a "leveling up" progress ladder rather than a plain
// descending list.
const RANKS_TOP_TO_BOTTOM = [1, 2, 3, 4, 5];

// Gamified progress sidebar. Every rank is always visible; a rank's song
// title appears next to its number the moment that song comes on, and
// stays there (not just the currently-active one) — so by the #1
// segment the whole board is filled in. Because each segment
// independently renders this against its own `rank` (and the full
// segments array, to look up already-revealed titles), the state
// transitions happen as an instant snap the moment Series swaps to the
// next segment — the "pattern interrupt" effect — with no
// animation/interpolation needed.
const ScoreboardSidebar: React.FC<{ activeRank: number; segments: RankingSegmentData[] }> = ({
  activeRank,
  segments,
}) => {
  const { width, height } = useVideoConfig();
  const byRank = new Map(segments.map((s) => [s.rank, s]));

  return (
    <div
      style={{
        position: "absolute",
        left: width * 0.05,
        right: width * 0.05,
        top: height * 0.3,
        display: "flex",
        flexDirection: "column",
        gap: height * 0.02,
      }}
    >
      {RANKS_TOP_TO_BOTTOM.map((n) => {
        const isCompleted = n > activeRank;
        const isActive = n === activeRank;
        const isFinal = isActive && n === 1;
        const isRevealed = n >= activeRank;
        const segment = byRank.get(n);

        let color = "rgba(255, 255, 255, 0.3)"; // upcoming
        let glow = "none";
        if (isCompleted) {
          color = "#4a4a4a";
        } else if (isFinal) {
          color = "#FFD700";
          glow = "0 0 26px #FFD700, 0 0 52px #FFD700";
        } else if (isActive) {
          color = "#00e5ff";
          glow = "0 0 22px #00e5ff, 0 0 44px #00e5ff";
        }

        return (
          <div key={n} style={{ display: "flex", alignItems: "center", gap: width * 0.03 }}>
            <span
              style={{
                fontFamily: rankFontFamily,
                fontSize: width * 0.1,
                color,
                WebkitTextStroke: "2.5px black",
                textShadow: glow,
                textDecoration: isCompleted ? "line-through" : "none",
                lineHeight: 1.1,
                flexShrink: 0,
                minWidth: width * 0.14,
              }}
            >
              {n}
            </span>
            {isRevealed && segment && (
              <div style={{ minWidth: 0 }}>
                <div
                  style={{
                    fontFamily: bodyFontFamily,
                    fontWeight: 700,
                    fontSize: width * 0.034,
                    color: isCompleted ? "#9a9a9a" : "white",
                    textShadow: "0 2px 6px rgba(0,0,0,0.9)",
                    lineHeight: 1.15,
                  }}
                >
                  {segment.songTitle}
                </div>
                {segment.metricLabel && (
                  <div
                    style={{
                      fontFamily: bodyFontFamily,
                      fontWeight: 400,
                      fontSize: width * 0.02,
                      color: isCompleted ? "#777" : "#39FF14",
                      marginTop: 2,
                    }}
                  >
                    {segment.metricLabel}
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
};

const RankingSegment: React.FC<
  RankingSegmentData & {
    sfxSrc?: string;
    artistName: string;
    sourceBadge: string;
    disclaimer?: string;
    holdLastFrame: boolean;
    allSegments: RankingSegmentData[];
  }
> = ({ videoSrc, rank, durationInSeconds, sfxSrc, artistName, sourceBadge, disclaimer, holdLastFrame, allSegments }) => {
  const { fps } = useVideoConfig();
  const frame = useCurrentFrame();
  const clipDurationInFrames = Math.round(durationInSeconds * fps);

  const video = <OffthreadVideo src={videoSrc} style={{ width: "100%", height: "100%", objectFit: "cover" }} />;

  // #2's segment runs a bit longer than usual specifically to host the
  // follow-popup overlay on top of its own still-playing clip (see
  // FOLLOW_POPUP_SECONDS's comment) — no separate silent scene, no cut.
  const followPopupFrames = Math.round(FOLLOW_POPUP_SECONDS * fps);
  const popupLocalFrame = frame - (clipDurationInFrames - followPopupFrames);
  const showFollowPopup = rank === 2 && popupLocalFrame >= 0;

  return (
    <AbsoluteFill style={{ backgroundColor: "black" }}>
      {holdLastFrame ? (
        <Freeze frame={clipDurationInFrames - 1} active={frame >= clipDurationInFrames}>
          {video}
        </Freeze>
      ) : (
        video
      )}
      {sfxSrc && <Audio src={sfxSrc} />}

      {/* Scrim so white text stays readable over bright footage */}
      <AbsoluteFill
        style={{
          background:
            "linear-gradient(to bottom, rgba(0,0,0,0.7) 0%, rgba(0,0,0,0.15) 30%, rgba(0,0,0,0.15) 70%, rgba(0,0,0,0.75) 100%)",
        }}
      />

      <Header artistName={artistName} sourceBadge={sourceBadge} disclaimer={disclaimer} />
      <ScoreboardSidebar activeRank={rank} segments={allSegments} />

      {showFollowPopup && <FollowPopup frame={popupLocalFrame} />}
    </AbsoluteFill>
  );
};

export const RankingCountdown: React.FC<RankingCountdownProps> = ({
  artistName,
  sourceBadge,
  disclaimer,
  sfxSrc,
  segments,
}) => {
  const { fps } = useVideoConfig();

  return (
    <Series>
      {segments.map((segment, index) => {
        const isLast = index === segments.length - 1;
        const durationInFrames = Math.round(segmentDurationInSeconds(segment) * fps) + (isLast ? 15 : 0);
        return (
          <Series.Sequence key={segment.rank} durationInFrames={durationInFrames}>
            <RankingSegment
              {...segment}
              sfxSrc={sfxSrc}
              artistName={artistName}
              sourceBadge={sourceBadge}
              disclaimer={disclaimer}
              holdLastFrame={isLast}
              allSegments={segments}
            />
          </Series.Sequence>
        );
      })}
    </Series>
  );
};
