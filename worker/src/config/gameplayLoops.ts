// GTA 5 gameplay shown on the bottom half of every ranking video, for the
// whole video. Shared by resolve-bg-loops.ts (which cuts, compresses and
// uploads these) and render-ranking-videos.ts (which picks one at random
// per video), so the two can't drift apart.
//
// Every source is licensed Creative Commons on YouTube and comes from a
// channel that labels its uploads free to use. Real GTA 6 gameplay
// doesn't exist yet; Rockstar's trailers are copyrighted, so they aren't
// used here.
//
// Each window is long enough to cover a whole ~60s video plus the intro;
// RankingCountdown still loops it if a video ever runs longer.

export const GAMEPLAY_LOOP_SECONDS = 75;

// The first entry is the original loop's filename, so it already exists in
// Storage before resolve-bg-loops.ts has been re-run to cut the rest —
// render-ranking-videos.ts falls back to it if a newer one is missing.
export const GAMEPLAY_LOOPS: { path: string; videoId: string; startSeconds: number }[] = [
  // "GTA 5 Gameplay No Copyright 1 HOUR (Mega Ramp)" — OrbitalNCG
  { path: "bg-loops/gta5-megaramp.mp4", videoId: "74voi0vlxHE", startSeconds: 360 },
  // "Lamborghini Urus Police Chase | GTA 5 No Copyright Gameplay" — Dope Gameplays
  { path: "bg-loops/gta5-police-chase.mp4", videoId: "qAJvBs7MW8w", startSeconds: 300 },
  // "Gta 5 Parkour Race : No Commentary No Copyright" — Copyright Free Gameplays
  { path: "bg-loops/gta5-parkour-race.mp4", videoId: "Q-9Rom6na1M", startSeconds: 300 },
  // "Gta 5 Stunt Jumps Free To Use Gameplay No Copyright" — Fox - No Copyright Gameplay
  { path: "bg-loops/gta5-stunt-jumps.mp4", videoId: "DzbgcE2c7BU", startSeconds: 300 },
  // "Gta 5 Stunt Race Free To Use Gameplay No Copyright" — Fox - No Copyright Gameplay
  { path: "bg-loops/gta5-stunt-race.mp4", videoId: "ARdwpNTe058", startSeconds: 600 },
  // "GTA 5 DRIFTING Gameplay ▸ No Copyright GTA Gameplay" — Dope Gameplays
  { path: "bg-loops/gta5-drifting.mp4", videoId: "AHeyo9D9Tyk", startSeconds: 150 },
  // "GTA 5 CRAZY BIKE PARKOUR GAMEPLAY | No Copyright Gameplay" — Dope Gameplays
  { path: "bg-loops/gta5-bike-parkour.mp4", videoId: "tzXbmpPpCRk", startSeconds: 150 },
];
// Check a window by eye before adding it: a "free roam" source tried here
// (DvIr0la3XcU) turned out to be mostly menus and map screens at the
// chosen timestamp, which compresses suspiciously small — a useful tell.
