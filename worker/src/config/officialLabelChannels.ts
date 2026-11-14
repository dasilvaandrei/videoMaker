// Official label / collective channels whose uploads count toward an
// artist's YouTube-views ranking, alongside the artist's own channel.
// Many artists' biggest official videos live here rather than on a
// personal channel — BTS members' MVs on HYBE LABELS, Juice WRLD's on
// Lyrical Lemonade — so without this they were undercounted or had no
// usable channel at all (see fetch-youtube-rankings.ts).
//
// Only channels that publish official releases belong here. A video from
// one of them still has to have the artist's name in its title to count
// for that artist. IDs were looked up through the YouTube API and checked
// against each channel's @handle and subscriber count (impostor copies of
// these names exist with a few dozen subscribers). Add more as gaps turn
// up.

export const OFFICIAL_LABEL_CHANNELS: { id: string; name: string }[] = [
  { id: "UC3IZKseVpdzPSBaWxBxundA", name: "HYBE LABELS" }, // @hybelabels
  { id: "UCEf_Bc-KVd7onSeifS3py9g", name: "SMTOWN" }, // @smtown
  { id: "UCaO6TYtlC8U5ttz62hTrZgg", name: "JYP Entertainment" }, // @jypentertainment
  { id: "UCQi67q4kGdmnJaRzX81uK5g", name: "YG ENTERTAINMENT" }, // @ygentertainment
  { id: "UCweOkPb1wVVH0Q0Tlj4a5Pw", name: "1theK" }, // @1thek
  { id: "UC_pwIXKXNm5KGhdEVzmY60A", name: "STONE MUSIC" }, // @officialstonemusic
  { id: "UCtylTUUVIGY_i5afsQYeBZA", name: "Lyrical Lemonade" }, // @lyricalemonade
];
