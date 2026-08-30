import { describe, expect, it } from "vitest";

import { localiseManifest } from "./drmEngine";

/** The shape `AudioCache::hit_drm` hands back, with three segments. */
const entry = {
  manifest: [
    "#EXTM3U",
    '#EXT-X-KEY:METHOD=SAMPLE-AES-CTR,URI="data:text/plain;base64,AAA"',
    '#EXT-X-MAP:URI="wf-local:0"',
    "#EXTINF:10.0,",
    "wf-local:1",
    "#EXTINF:10.0,",
    "wf-local:2",
    "#EXT-X-ENDLIST",
    "",
  ].join("\n"),
  files: [
    "C:\\cache\\audio_cache\\drm\\9\\init000.mp4",
    "C:\\cache\\audio_cache\\drm\\9\\seg00000.m4s",
    "C:\\cache\\audio_cache\\drm\\9\\seg00001.m4s",
  ],
};

/** What `convertFileSrc` does on Windows. */
const asset = (path: string) => `http://asset.localhost/${encodeURIComponent(path)}`;

describe("localiseManifest", () => {
  it("swaps every placeholder for the segment it stands for", () => {
    const out = localiseManifest(entry, asset);

    expect(out).not.toContain("wf-local:");
    expect(out).toContain(`#EXT-X-MAP:URI="${asset(entry.files[0])}"`);
    expect(out.split("\n")[4]).toBe(asset(entry.files[1]));
    expect(out.split("\n")[6]).toBe(asset(entry.files[2]));
  });

  it("leaves the PlayReady header and the playlist structure alone", () => {
    const out = localiseManifest(entry, asset);

    expect(out).toContain('URI="data:text/plain;base64,AAA"');
    // Shaka only treats a playlist as VOD once it sees this, and a stored
    // stream is complete by definition.
    expect(out.endsWith("#EXT-X-ENDLIST\n")).toBe(true);
    // It also reads the extension off a segment URL to pick a demuxer, so
    // percent-encoding a Windows path must leave the suffix legible.
    expect(out).toContain(".m4s");
  });

  it("refuses a manifest whose segment is not in the entry", () => {
    const broken = { manifest: "wf-local:9\n", files: entry.files };
    expect(() => localiseManifest(broken, asset)).toThrow(/segment 9/);
  });
});
