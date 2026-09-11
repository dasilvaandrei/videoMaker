// YouTube channel icon (upload at 800x800 — displays cropped to a
// circle everywhere). Typographic mark reusing the same Anton font and
// gold/cyan glow treatment as the #1 reveal in RankingCountdown.tsx, so
// the icon reads as "this channel" wherever it shows up next to a video.

import { AbsoluteFill, useVideoConfig } from "remotion";
import { loadFont as loadRankFont } from "@remotion/google-fonts/Anton";

const { fontFamily: rankFontFamily } = loadRankFont();

export const ChannelIcon: React.FC = () => {
  const { width } = useVideoConfig();

  return (
    <AbsoluteFill
      style={{
        backgroundColor: "black",
        justifyContent: "center",
        alignItems: "center",
      }}
    >
      <div
        style={{
          fontFamily: rankFontFamily,
          fontSize: width * 0.42,
          color: "#FFD700",
          WebkitTextStroke: `${width * 0.012}px black`,
          textShadow: `0 0 ${width * 0.05}px #00e5ff, 0 0 ${width * 0.1}px #00e5ff`,
          lineHeight: 1,
        }}
      >
        TOP5
      </div>
    </AbsoluteFill>
  );
};
