import { describe, expect, it } from "vitest";
import { exportFilename, exportMimeType, sanitizeExportName } from "../output";

describe("exportMimeType", () => {
  it("maps each container to its video/audio type", () => {
    expect(exportMimeType("mp4")).toBe("video/mp4");
    expect(exportMimeType("webm")).toBe("video/webm");
    expect(exportMimeType("mp3")).toBe("audio/mpeg");
    expect(exportMimeType("wav")).toBe("audio/wav");
  });

  it("falls back to a binary type for anything unmapped", () => {
    expect(exportMimeType("gif")).toBe("image/gif");
    expect(exportMimeType("mov")).toBe("video/quicktime");
  });
});

describe("sanitizeExportName", () => {
  it("keeps a friendly name intact apart from spaces", () => {
    expect(sanitizeExportName("Holiday Trip")).toBe("Holiday_Trip");
  });

  it("collapses runs of unsafe characters to a single underscore", () => {
    expect(sanitizeExportName("a///b??c")).toBe("a_b_c");
  });

  it("strips path separators so a name cannot escape the download dir", () => {
    expect(sanitizeExportName("../secrets")).toBe("secrets");
    expect(sanitizeExportName("..\\windows\\evil")).toBe("windows_evil");
  });

  it("never produces a hidden-file or empty name", () => {
    expect(sanitizeExportName(".hidden")).toBe("hidden");
    expect(sanitizeExportName("___")).toBe("export");
    expect(sanitizeExportName("   ")).toBe("export");
    expect(sanitizeExportName("")).toBe("export");
  });

  it("preserves dots and dashes that are safe inside a filename", () => {
    expect(sanitizeExportName("cut.v2-final")).toBe("cut.v2-final");
  });
});

describe("exportFilename", () => {
  it("appends the container extension to the sanitised name", () => {
    expect(exportFilename("My Movie!", "mp4")).toBe("My_Movie.mp4");
    expect(exportFilename("  ghost  ", "webm")).toBe("ghost.webm");
    expect(exportFilename("", "mp4")).toBe("export.mp4");
  });
});
