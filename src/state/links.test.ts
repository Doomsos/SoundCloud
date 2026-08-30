/** Covers the clipboard link detection ported from `clipboard_watcher.dart`. */

import { describe, expect, it } from "vitest";

import { isSoundcloudUrl } from "./links";

describe("isSoundcloudUrl", () => {
  it("accepts real track and profile links", () => {
    expect(isSoundcloudUrl("https://soundcloud.com/artist/track")).toBe(true);
    expect(isSoundcloudUrl("soundcloud.com/artist")).toBe(true);
    expect(isSoundcloudUrl("https://m.soundcloud.com/artist/track")).toBe(true);
    expect(isSoundcloudUrl("HTTPS://SOUNDCLOUD.COM/Artist")).toBe(true);
  });

  it("rejects a bare domain with nothing after it", () => {
    expect(isSoundcloudUrl("https://soundcloud.com/")).toBe(false);
  });

  it("rejects prose that merely mentions the domain", () => {
    // Copying a sentence should never raise the "open this link" toast.
    expect(isSoundcloudUrl("check out soundcloud.com/artist")).toBe(false);
    expect(isSoundcloudUrl("soundcloud.com/a b")).toBe(false);
  });

  it("rejects unrelated links and empty input", () => {
    expect(isSoundcloudUrl("https://example.com/artist")).toBe(false);
    expect(isSoundcloudUrl("")).toBe(false);
  });
});
