// Registers one composition per aspect ratio the platforms need — 9:16
// (TikTok/Reels/Shorts, the primary target for Backyard Breaks), 1:1, and
// 16:9 — all backed by the same HighlightClip component. Duration comes
// straight from the clip's already-known start/end_seconds (no re-probing
// the video here, calculateMetadata below just does the seconds->frames
// math) since that's cheaper and this runs inside Remotion's bundled
// render context, not our Node worker process.

import type { CalculateMetadataFunction } from "remotion";
import { Composition, Folder } from "remotion";
import { HighlightClip, type HighlightClipProps } from "./HighlightClip.js";

const FPS = 30;

type Props = HighlightClipProps;

const calculateMetadata: CalculateMetadataFunction<Props> = async ({ props }) => {
  return {
    durationInFrames: Math.max(1, Math.round(props.durationInSeconds * FPS)),
  };
};

const defaultProps: Props = {
  videoSrc: "",
  hookText: "Hook text",
  caption: "Caption goes here",
  hashtags: ["backyardbreaks"],
  durationInSeconds: 5,
};

export const RemotionRoot: React.FC = () => {
  return (
    <Folder name="HighlightClip">
      <Composition
        id="HighlightClip-9x16"
        component={HighlightClip}
        fps={FPS}
        width={1080}
        height={1920}
        durationInFrames={FPS * 5}
        defaultProps={defaultProps}
        calculateMetadata={calculateMetadata}
      />
      <Composition
        id="HighlightClip-1x1"
        component={HighlightClip}
        fps={FPS}
        width={1080}
        height={1080}
        durationInFrames={FPS * 5}
        defaultProps={defaultProps}
        calculateMetadata={calculateMetadata}
      />
      <Composition
        id="HighlightClip-16x9"
        component={HighlightClip}
        fps={FPS}
        width={1920}
        height={1080}
        durationInFrames={FPS * 5}
        defaultProps={defaultProps}
        calculateMetadata={calculateMetadata}
      />
    </Folder>
  );
};
