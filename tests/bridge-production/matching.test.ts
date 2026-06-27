import assert from "node:assert/strict";
import test from "node:test";

import {
  matchKavitaSeriesToMal,
  normalizeTitleForMatching,
  type KavitaSeriesCandidate,
  type MalSearchCandidate,
} from "../../apps/kavita-mal-bridge/src/matching.js";

test("deterministic MAL URL metadata auto-links a Kavita series", () => {
  const series: KavitaSeriesCandidate = {
    kavitaSeriesId: 42,
    title: "A Certain Story",
    libraryId: 7,
    webLinks: ["https://myanimelist.net/manga/12345/A_Certain_Story"],
  };

  const result = matchKavitaSeriesToMal({ series, searchCandidates: [] });

  assert.equal(result.status, "matched");
  assert.equal(result.malId, 12345);
  assert.equal(result.matchMethod, "mal-url");
  assert.equal(result.confidence, 1);
});

test("high-confidence normalized title matching auto-links only when top result is clearly ahead", () => {
  const series: KavitaSeriesCandidate = {
    kavitaSeriesId: 9,
    title: "The Angel Next Door Spoils Me Rotten",
    altTitles: ["Otonari no Tenshi-sama"],
    authors: ["Saekisan"],
    publicationYear: 2019,
    volumeCount: 9,
  };
  const candidates: MalSearchCandidate[] = [
    {
      malId: 50001,
      title: "The Angel Next Door Spoils Me Rotten",
      altTitles: ["Otonari no Tenshi-sama ni Itsunomanika Dame Ningen ni Sareteita Ken"],
      authors: ["Saekisan"],
      mediaType: "light_novel",
      startYear: 2019,
      volumes: 9,
    },
    {
      malId: 50002,
      title: "The Angel Next Door",
      altTitles: [],
      authors: ["Other"],
      mediaType: "manga",
      startYear: 2021,
      volumes: 3,
    },
  ];

  const result = matchKavitaSeriesToMal({ series, searchCandidates: candidates });

  assert.equal(result.status, "matched");
  assert.equal(result.malId, 50001);
  assert.equal(result.matchMethod, "title-search");
  assert.ok(result.confidence >= 0.92);
});

test("low-confidence title search goes to review instead of guessing", () => {
  const series: KavitaSeriesCandidate = {
    kavitaSeriesId: 11,
    title: "Blue Spring",
  };
  const candidates: MalSearchCandidate[] = [
    { malId: 1, title: "Blue Spring", altTitles: [], mediaType: "manga" },
    { malId: 2, title: "Blue Spring Ride", altTitles: ["Ao Haru Ride"], mediaType: "manga" },
  ];

  const result = matchKavitaSeriesToMal({ series, searchCandidates: candidates });

  assert.equal(result.status, "review");
  assert.equal(result.reason, "ambiguous-or-low-confidence");
});

test("exact title with compatible media type auto-links when clearly ahead", () => {
  const series: KavitaSeriesCandidate = {
    kavitaSeriesId: 12,
    title: "+ Tic Neesan",
    mediaType: "manga",
  };
  const candidates: MalSearchCandidate[] = [
    {
      malId: 25675,
      title: "Plastic Neesan",
      altTitles: ["+tic Neesan", "Plastic Elder Sister"],
      mediaType: "manga",
    },
    {
      malId: 27053,
      title: "Kick no Oneesan",
      mediaType: "manga",
    },
  ];

  const result = matchKavitaSeriesToMal({ series, searchCandidates: candidates });

  assert.equal(result.status, "matched");
  assert.equal(result.malId, 25675);
  assert.equal(result.matchMethod, "title-search");
  assert.ok(result.confidence >= 0.92);
});

test("exact title ties remain in review", () => {
  const series: KavitaSeriesCandidate = {
    kavitaSeriesId: 13,
    title: "BlazBlue",
    mediaType: "light_novel",
  };
  const candidates: MalSearchCandidate[] = [
    {
      malId: 28629,
      title: "BlazBlue: Phase 0",
      altTitles: ["BlazBlue"],
      mediaType: "light_novel",
    },
    {
      malId: 65097,
      title: "BlazBlue",
      altTitles: ["BLAZBLUE"],
      mediaType: "light_novel",
    },
  ];

  const result = matchKavitaSeriesToMal({ series, searchCandidates: candidates });

  assert.equal(result.status, "review");
  assert.equal(result.reason, "ambiguous-or-low-confidence");
});

test("title normalization removes punctuation and casing noise", () => {
  assert.equal(
    normalizeTitleForMatching("Baka to Tesuto to Syokanju: Volume 10.5"),
    "baka to tesuto to syokanju volume 10 5",
  );
});
