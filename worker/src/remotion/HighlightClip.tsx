// The one composition every rendered clip goes through, regardless of
// aspect ratio: full-bleed source footage, a bold hook line up top (the
// thing that has to stop a scroll in <1s), and a caption + hashtag block
// pinned to the bottom third — burned-in text rather than a straight
// re-cut, per the campaign's own content rules and because it's simply
// better-performing short-form content.

import { AbsoluteFill, Freeze, OffthreadVideo, useCurrentFrame, useVideoConfig } from "remotion";
import { loadFont as loadHookFont } from "@remotion/google-fonts/Anton";
import { loadFont as loadBodyFont } from "@remotion/google-fonts/Inter";

const { fontFamily: hookFontFamily } = loadHookFont();
const { fontFamily: bodyFontFamily } = loadBodyFont("normal", {
  weights: ["400", "700"],
  subsets: ["latin"],
});

export type HighlightClipProps = {
  videoSrc: string;
  hookText: string;
  caption: string;
  hashtags: string[];
  // Marks where the real clip ends and the trailing freeze-frame (see
  // FREEZE_FRAMES in Root.tsx) begins — the composition's total duration
  // is longer than this by that fixed freeze padding.
  durationInSeconds: number;
};

// Simple length-based clamp instead of pulling in @remotion/layout-utils —
// card names are short and predictable enough that measuring real glyph
// widths would be solving a problem we don't have yet.
function hookFontSize(text: string, base: number): number {
  const over = Math.max(0, text.length - 18);
  return Math.max(base * 0.55, base - over * 1.6);
}

export const HighlightClip: React.FC<HighlightClipProps> = ({
  videoSrc,
  hookText,
  caption,
  hashtags,
  durationInSeconds,
}) => {
  const { width, height, fps } = useVideoConfig();
  const frame = useCurrentFrame();
  const isVertical = height > width;
  const baseHookSize = isVertical ? 76 : 54;

  // Real clip plays normally up to this frame; past it we hold on the
  // last real frame (the trailing FREEZE_FRAMES padding from Root.tsx's
  // calculateMetadata) rather than showing a black/undefined frame.
  const mainDurationInFrames = Math.round(durationInSeconds * fps);

  return (
    <AbsoluteFill style={{ backgroundColor: "black" }}>
      <Freeze frame={mainDurationInFrames - 1} active={frame >= mainDurationInFrames}>
        <OffthreadVideo
          src={videoSrc}
          style={{ width: "100%", height: "100%", objectFit: "cover" }}
        />
      </Freeze>

      {/* Scrim so white text stays readable over bright footage */}
      <AbsoluteFill
        style={{
          background:
            "linear-gradient(to bottom, rgba(0,0,0,0.6) 0%, rgba(0,0,0,0) 20%, rgba(0,0,0,0) 68%, rgba(0,0,0,0.75) 100%)",
        }}
      />

      <div
        style={{
          position: "absolute",
          top: isVertical ? 90 : 48,
          left: 40,
          right: 40,
          textAlign: "center",
        }}
      >
        <span
          style={{
            fontFamily: hookFontFamily,
            fontSize: hookFontSize(hookText, baseHookSize),
            color: "white",
            textTransform: "uppercase",
            WebkitTextStroke: "3px black",
            lineHeight: 1.05,
          }}
        >
          {hookText}
        </span>
      </div>

      <div
        style={{
          position: "absolute",
          left: 40,
          right: 40,
          bottom: isVertical ? 140 : 64,
          textAlign: "center",
        }}
      >
        <div
          style={{
            fontFamily: bodyFontFamily,
            fontWeight: 700,
            fontSize: isVertical ? 40 : 30,
            color: "white",
            textShadow: "0 2px 6px rgba(0,0,0,0.9)",
            marginBottom: 14,
          }}
        >
          {caption}
        </div>
        {hashtags.length > 0 && (
          <div
            style={{
              fontFamily: bodyFontFamily,
              fontWeight: 400,
              fontSize: isVertical ? 28 : 22,
              color: "#9fd8ff",
            }}
          >
            {hashtags.map((h) => `#${h.replace(/^#/, "")}`).join(" ")}
          </div>
        )}
      </div>
    </AbsoluteFill>
  );
};
