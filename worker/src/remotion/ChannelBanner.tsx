// YouTube channel banner (upload at 2560x1440 — YouTube crops
// differently on desktop/tablet/mobile/TV, so only the center "safe
// area," roughly 1546x423, is guaranteed visible everywhere). All real
// content stays inside that safe zone; the rest is just background.
//
// Reuses RankingCountdown.tsx's header treatment — the same per-word
// color cycling used on every video's on-screen title — so the channel
// page and the videos read as the same brand.

import { AbsoluteFill, useVideoConfig } from "remotion";
import { loadFont as loadRankFont } from "@remotion/google-fonts/Anton";
import { loadFont as loadBodyFont } from "@remotion/google-fonts/Inter";

const { fontFamily: rankFontFamily } = loadRankFont();
const { fontFamily: bodyFontFamily } = loadBodyFont("normal", {
  weights: ["400", "700"],
  subsets: ["latin"],
});

const HEADER_COLORS = ["#FF3B30", "#34C759", "#FFCC00", "#2E9BFF"];

export const ChannelBanner: React.FC = () => {
  const { width, height } = useVideoConfig();
  const words = "Top 5 Songs".split(" ");

  return (
    <AbsoluteFill style={{ backgroundColor: "black", justifyContent: "center", alignItems: "center" }}>
      {/* Safe-area guide box — only matters while eyeballing the render;
          harmless left in since it's the same color as the background. */}
      <div
        style={{
          position: "absolute",
          width: width * 0.604,
          height: height * 0.294,
          textAlign: "center",
        }}
      >
        <div
          style={{
            fontFamily: rankFontFamily,
            fontSize: height * 0.16,
            textTransform: "uppercase",
            WebkitTextStroke: `${height * 0.006}px black`,
            lineHeight: 1,
          }}
        >
          {words.map((word, i) => (
            <span key={i} style={{ color: HEADER_COLORS[i % HEADER_COLORS.length] }}>
              {word}
              {i < words.length - 1 ? " " : ""}
            </span>
          ))}
        </div>
        <div
          style={{
            fontFamily: bodyFontFamily,
            fontWeight: 700,
            fontSize: height * 0.045,
            color: "#9fd8ff",
            marginTop: height * 0.02,
            letterSpacing: 2,
          }}
        >
          NEW RANKINGS EVERY DAY 🔥
        </div>
      </div>
    </AbsoluteFill>
  );
};
