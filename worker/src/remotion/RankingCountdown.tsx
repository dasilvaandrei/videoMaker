// The countdown composition every ranking video goes through: a brief
// spoken-hook intro (see IntroHook — reintroduced specifically to carry
// the ElevenLabs intro voiceover; the video used to start immediately on
// song #5 with no intro scene at all, before VO came back), then the
// persistent, multi-color title header for the rest of the video, with a
// "scoreboard" sidebar (see ScoreboardSidebar) that fills in with each
// song's title as it's revealed and keeps every prior one visible — by
// the final segment the whole board is lit up. Visual language (gradient
// scrim, Anton/Inter fonts, freeze-on-last-frame for a clean
// auto-thumbnail) carried over from the old HighlightClip.tsx, which
// this composition replaces now that a "render" means 5 clips stitched
// together, not one.

import {
  AbsoluteFill,
  Audio,
  Freeze,
  Img,
  OffthreadVideo,
  Sequence,
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
  disclaimer?: string | null;
  // Short "ding" sound played at the start of every segment (the
  // scoreboard's rank-advance pattern interrupt). Optional so the
  // composition still works without it (e.g. Studio preview).
  sfxSrc?: string;
  // Bold hook text shown during the intro (e.g. "THE NUMBERS DON'T LIE"),
  // spoken by introVoSrc — see generate-intro-vo.ts for where both come
  // from. null/undefined skips the intro scene entirely (e.g. an older
  // ranking generated before this feature, or a Studio preview with no
  // VO wired up).
  introText?: string | null;
  introVoSrc?: string | null;
  introDurationInSeconds?: number | null;
  // Split-screen intro visuals (the "retention hack" — a recognizable
  // artist photo up top, kinetic B-roll below, so the eye has something
  // to lock onto while the VO plays instead of a static black screen).
  // Both fall back to a plain dark half rather than breaking the render
  // if unresolved — see generate-intro-vo.ts / resolve-bg-loops.ts.
  introAvatarUrl?: string | null;
  introBgLoopSrc?: string | null;
  // Ordered 5 -> 1, i.e. playback order (the reveal builds to #1).
  segments: RankingSegmentData[];
  // Affiliate sponsor segment (see config/sponsors.ts), inserted after
  // song #4. null/undefined skips it entirely — no sponsor active yet,
  // or this ranking's rotation didn't pick one.
  sponsorName?: string | null;
  sponsorAffiliateUrl?: string | null;
  sponsorVoSrc?: string | null;
  sponsorVoDurationSeconds?: number | null;
  // Cycles through during the segment (see SponsorSegment) rather than
  // holding on one static image the whole time.
  sponsorAssetUrls?: string[];
  sponsorAssetType?: "video" | "image" | null;
  sponsorBgLoopSrc?: string | null;
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

// Small trailing buffer after the VO line finishes, before cutting to
// song #5 — keeps the cut from feeling like it's stepping on the last
// word.
export const INTRO_BUFFER_SECONDS = 0.4;
// Floor for the intro's on-screen time even if a VO duration is missing
// (shouldn't happen for a real render — generate-intro-vo.ts always sets
// one — but keeps Studio previews sane without it).
const INTRO_FALLBACK_SECONDS = 2.5;

export function introDurationInSeconds(vo?: number | null): number {
  return (vo ?? INTRO_FALLBACK_SECONDS - INTRO_BUFFER_SECONDS) + INTRO_BUFFER_SECONDS;
}

// Slightly more trailing room than the intro's buffer — the sponsor
// segment introduces an entirely new visual mid-video (unlike the
// intro, which is the first thing seen), so it gets a beat longer to
// register before cutting to song #3.
export const SPONSOR_BUFFER_SECONDS = 0.6;

export function sponsorDurationInSeconds(voSeconds: number): number {
  return voSeconds + SPONSOR_BUFFER_SECONDS;
}

// Spoken-hook intro (see generate-intro-vo.ts) — the "split-screen
// retention hack": a recognizable artist photo up top (psychological eye
// contact if it's a face shot), kinetic "satisfying" B-roll below (the
// motion keeps the eye locked on screen while the VO plays), with the
// hook text banner straddling the seam between them. Each half is a
// plain absolutely-positioned div using exactly two of
// top/bottom/height, never all three — mixing e.g. `top` with
// AbsoluteFill's default `height: 100%` once already pushed a whole
// block invisibly off-canvas, so this composition avoids that pattern
// everywhere now.
const IntroHook: React.FC<{
  artistName: string;
  sourceBadge: string;
  introText: string;
  introVoSrc?: string | null;
  introAvatarUrl?: string | null;
  introBgLoopSrc?: string | null;
}> = ({ artistName, sourceBadge, introText, introVoSrc, introAvatarUrl, introBgLoopSrc }) => {
  const frame = useCurrentFrame();
  const { fps, width } = useVideoConfig();

  const scale = spring({ frame, fps, config: { damping: 10, stiffness: 160, mass: 0.6 } });
  const opacity = interpolate(frame, [0, 5], [0, 1], { extrapolateRight: "clamp" });

  return (
    <AbsoluteFill style={{ backgroundColor: "#0a0a0a" }}>
      {introVoSrc && <Audio src={introVoSrc} />}

      {/* Top half — artist photo, or a plain dark gradient if none resolved. */}
      <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: "50%", overflow: "hidden" }}>
        {introAvatarUrl ? (
          <Img src={introAvatarUrl} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
        ) : (
          <AbsoluteFill style={{ background: "linear-gradient(160deg, #1a1a1a 0%, #050505 100%)" }} />
        )}
        {/* Scrim so the header title stays legible over a bright photo. */}
        <AbsoluteFill
          style={{ background: "linear-gradient(to bottom, rgba(0,0,0,0.75) 0%, rgba(0,0,0,0.1) 55%, rgba(0,0,0,0.55) 100%)" }}
        />
      </div>

      {/* Bottom half — kinetic B-roll loop, or a plain dark gradient if none resolved. Muted: its own audio never competes with the VO. */}
      <div style={{ position: "absolute", top: "50%", left: 0, right: 0, bottom: 0, overflow: "hidden" }}>
        {introBgLoopSrc ? (
          <OffthreadVideo src={introBgLoopSrc} muted style={{ width: "100%", height: "100%", objectFit: "cover" }} />
        ) : (
          <AbsoluteFill style={{ background: "linear-gradient(200deg, #1a1a1a 0%, #050505 100%)" }} />
        )}
      </div>

      <Header artistName={artistName} sourceBadge={sourceBadge} disclaimer={null} />

      {/* Hook text banner, straddling the seam between the two halves so
          it reads clearly regardless of what's behind it on either side. */}
      <div
        style={{
          position: "absolute",
          top: "42%",
          left: 0,
          right: 0,
          height: "16%",
          display: "flex",
          justifyContent: "center",
          alignItems: "center",
          backgroundColor: "rgba(0,0,0,0.6)",
        }}
      >
        <div
          style={{
            transform: `scale(${scale})`,
            opacity,
            fontFamily: rankFontFamily,
            fontSize: width * 0.068,
            color: "white",
            WebkitTextStroke: "3px black",
            textAlign: "center",
            lineHeight: 1.05,
            padding: `0 ${width * 0.06}px`,
          }}
        >
          {introText}
        </div>
      </div>
    </AbsoluteFill>
  );
};

// Affiliate sponsor segment (see config/sponsors.ts) — same split-screen
// language as IntroHook (recognizable content up top, kinetic B-roll
// below) so it reads as a continuation of the video's visual style
// rather than a jarring ad interruption. "AD" badge is a legal
// requirement (FTC disclosure for affiliate content), not optional
// polish — see generate-ranking-render-metadata.ts's caption disclosure
// for the other half of that.
// How long each asset holds before crossfading to the next — a plain
// static image the whole segment felt flat, so multiple creative assets
// (see config/sponsors.ts's assetStoragePaths) cycle through instead.
const SPONSOR_CYCLE_SECONDS = 2.2;
const SPONSOR_CROSSFADE_SECONDS = 0.35;

const SponsorSegment: React.FC<{
  sponsorName: string;
  sponsorVoSrc: string;
  sponsorAssetUrls?: string[];
  sponsorAssetType?: "video" | "image" | null;
  sponsorBgLoopSrc?: string | null;
}> = ({ sponsorName, sponsorVoSrc, sponsorAssetUrls, sponsorAssetType, sponsorBgLoopSrc }) => {
  const frame = useCurrentFrame();
  const { fps, width } = useVideoConfig();

  const scale = spring({ frame, fps, config: { damping: 10, stiffness: 160, mass: 0.6 } });
  const opacity = interpolate(frame, [0, 5], [0, 1], { extrapolateRight: "clamp" });

  const assets = sponsorAssetUrls ?? [];
  const cycleFrames = Math.round(SPONSOR_CYCLE_SECONDS * fps);
  const crossfadeFrames = Math.round(SPONSOR_CROSSFADE_SECONDS * fps);
  const currentIndex = assets.length > 0 ? Math.floor(frame / cycleFrames) % assets.length : 0;
  const nextIndex = assets.length > 0 ? (currentIndex + 1) % assets.length : 0;
  const frameInCycle = frame % cycleFrames;
  const crossfade = interpolate(frameInCycle, [cycleFrames - crossfadeFrames, cycleFrames], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  const renderAsset = (url: string, assetOpacity: number) =>
    sponsorAssetType === "video" ? (
      <OffthreadVideo
        src={url}
        muted
        style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover", opacity: assetOpacity }}
      />
    ) : (
      <Img
        src={url}
        style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover", opacity: assetOpacity }}
      />
    );

  return (
    <AbsoluteFill style={{ backgroundColor: "#0a0a0a" }}>
      <Audio src={sponsorVoSrc} />

      {/* Top half — the sponsor's creative assets, crossfading between
          them (a single static image the whole segment felt flat). */}
      <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: "50%", overflow: "hidden" }}>
        {assets.length > 0 ? (
          <>
            {renderAsset(assets[currentIndex], 1 - crossfade)}
            {assets.length > 1 && crossfade > 0 && renderAsset(assets[nextIndex], crossfade)}
          </>
        ) : (
          <AbsoluteFill style={{ background: "linear-gradient(160deg, #1a1a1a 0%, #050505 100%)" }} />
        )}
        <AbsoluteFill
          style={{ background: "linear-gradient(to bottom, rgba(0,0,0,0.75) 0%, rgba(0,0,0,0.1) 55%, rgba(0,0,0,0.55) 100%)" }}
        />
      </div>

      {/* Bottom half — kinetic B-roll, same pool as the intro's. */}
      <div style={{ position: "absolute", top: "50%", left: 0, right: 0, bottom: 0, overflow: "hidden" }}>
        {sponsorBgLoopSrc ? (
          <OffthreadVideo src={sponsorBgLoopSrc} muted style={{ width: "100%", height: "100%", objectFit: "cover" }} />
        ) : (
          <AbsoluteFill style={{ background: "linear-gradient(200deg, #1a1a1a 0%, #050505 100%)" }} />
        )}
      </div>

      {/* FTC disclosure — always visible, not tied to the pop-in animation. */}
      <div
        style={{
          position: "absolute",
          top: width * 0.04,
          left: width * 0.04,
          backgroundColor: "rgba(0,0,0,0.7)",
          border: "2px solid white",
          borderRadius: 6,
          padding: `${width * 0.012}px ${width * 0.025}px`,
          fontFamily: bodyFontFamily,
          fontWeight: 700,
          fontSize: width * 0.028,
          color: "white",
          letterSpacing: 1,
        }}
      >
        AD
      </div>

      {/* Sponsor name + CTA banner, straddling the seam like IntroHook's hook text. */}
      <div
        style={{
          position: "absolute",
          top: "42%",
          left: 0,
          right: 0,
          height: "16%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          alignItems: "center",
          backgroundColor: "rgba(0,0,0,0.6)",
        }}
      >
        <div
          style={{
            transform: `scale(${scale})`,
            opacity,
            fontFamily: rankFontFamily,
            fontSize: width * 0.06,
            color: "white",
            WebkitTextStroke: "3px black",
            textAlign: "center",
            lineHeight: 1.05,
          }}
        >
          {sponsorName}
        </div>
        <div
          style={{
            opacity,
            fontFamily: bodyFontFamily,
            fontWeight: 700,
            fontSize: width * 0.032,
            color: "#39FF14",
            marginTop: 4,
            textShadow: "0 2px 6px rgba(0,0,0,0.9)",
          }}
        >
          LINK IN BIO 👆
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
const Header: React.FC<{ artistName: string; sourceBadge: string; disclaimer?: string | null }> = ({
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
    disclaimer?: string | null;
    holdLastFrame: boolean;
    allSegments: RankingSegmentData[];
    // Rank 5 only — its audio is already playing via the continuous
    // cross-fade Audio element at the RankingCountdown level (see
    // FIRST_SONG_CONTINUOUS_AUDIO below), so its own embedded video
    // audio is muted here to avoid doubling up.
    muted?: boolean;
  }
> = ({
  videoSrc,
  rank,
  durationInSeconds,
  sfxSrc,
  artistName,
  sourceBadge,
  disclaimer,
  holdLastFrame,
  allSegments,
  muted,
}) => {
  const { fps } = useVideoConfig();
  const frame = useCurrentFrame();
  const clipDurationInFrames = Math.round(durationInSeconds * fps);

  const video = (
    <OffthreadVideo src={videoSrc} muted={muted} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
  );

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
  introText,
  introVoSrc,
  introDurationInSeconds: introVoSeconds,
  introAvatarUrl,
  introBgLoopSrc,
  segments,
  sponsorName,
  sponsorVoSrc,
  sponsorVoDurationSeconds,
  sponsorAssetUrls,
  sponsorAssetType,
  sponsorBgLoopSrc,
}) => {
  const { fps } = useVideoConfig();

  // Rank 5 (index 0) gets its audio from the continuous cross-fade Audio
  // element below instead of its own embedded video audio, so the song
  // doesn't audibly restart from 0:00 the moment the intro ends — only
  // when there's actually an intro for it to continue from.
  const firstSongMuted = Boolean(introText);

  const songSequences = segments.map((segment, index) => {
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
          muted={index === 0 ? firstSongMuted : undefined}
        />
      </Series.Sequence>
    );
  });

  // Inserted after song #4 (index 2, i.e. after segments[0]=#5 and
  // segments[1]=#4, before segments[2]=#3) — early enough to catch
  // viewers before the drop-off point, without interrupting the #3->#1
  // climax. render-ranking-videos.ts is responsible for shrinking #3's
  // own duration to compensate, keeping the total in TikTok's 61-65s
  // target even with this segment included.
  if (sponsorName && sponsorVoSrc) {
    const sponsorFrames = Math.round(sponsorDurationInSeconds(sponsorVoDurationSeconds ?? 0) * fps);
    songSequences.splice(
      2,
      0,
      <Series.Sequence key="sponsor" durationInFrames={sponsorFrames}>
        <SponsorSegment
          sponsorName={sponsorName}
          sponsorVoSrc={sponsorVoSrc}
          sponsorAssetUrls={sponsorAssetUrls}
          sponsorAssetType={sponsorAssetType}
          sponsorBgLoopSrc={sponsorBgLoopSrc}
        />
      </Series.Sequence>
    );
  }

  const introFrames = introText ? Math.round(introDurationInSeconds(introVoSeconds) * fps) : 0;
  const firstSongFrames = segments.length > 0 ? Math.round(segmentDurationInSeconds(segments[0]) * fps) : 0;
  // Half-second swell into full volume, timed to land right as the
  // countdown visually starts on #5 — feels like the song "arriving"
  // rather than an abrupt jump the instant the scene cuts.
  const volumeRampFrames = Math.round(0.5 * fps);

  return (
    <AbsoluteFill>
      {/* One continuous Audio spanning the intro + song #5, instead of
          each scene playing its own copy from 0:00 — quiet under the
          spoken hook, swelling to full right as #5 begins, so the song
          feels like it's been playing the whole time rather than
          restarting. Sits outside the Series (which resets each child's
          local frame count to 0, incompatible with one audio element
          spanning two of its sequences) as a plain Sequence overlay;
          renders no pixels, so it doesn't interfere with the Series'
          visuals underneath. */}
      {introText && segments.length > 0 && (
        <Sequence from={0} durationInFrames={introFrames + firstSongFrames} layout="none">
          <Audio
            src={segments[0].videoSrc}
            volume={(f) =>
              interpolate(f, [0, introFrames - volumeRampFrames, introFrames], [0.15, 0.15, 1], {
                extrapolateLeft: "clamp",
                extrapolateRight: "clamp",
              })
            }
          />
        </Sequence>
      )}
      <Series>
        {introText && (
          <Series.Sequence durationInFrames={introFrames}>
            <IntroHook
              artistName={artistName}
              sourceBadge={sourceBadge}
              introText={introText}
              introVoSrc={introVoSrc}
              introAvatarUrl={introAvatarUrl}
              introBgLoopSrc={introBgLoopSrc}
            />
          </Series.Sequence>
        )}
        {songSequences}
      </Series>
    </AbsoluteFill>
  );
};
