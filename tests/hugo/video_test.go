package hugo_test

import (
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// TestVideoLocalResource_PageBundle verifies that a src matching a page
// resource is resolved to the resource's RelPermalink and its MediaType.
func TestVideoLocalResource_PageBundle(t *testing.T) {
	outputDir := buildHugoSite(t, "video-local-resource")
	content := readOutputFile(t, outputDir, "posts/test-page/index.html")
	assertContains(t, content, `<source src="/posts/test-page/video.mp4" type="video/mp4">`)
}

// TestVideoLocalResource_GlobalAssets verifies the resources.GetMatch
// fallback for files living in the site assets/ directory.
func TestVideoLocalResource_GlobalAssets(t *testing.T) {
	outputDir := buildHugoSite(t, "video-local-resource")
	content := readOutputFile(t, outputDir, "posts/global-page/index.html")
	assertContains(t, content, `<source src="/video/global.webm" type="video/webm">`)
}

// TestVideoRemoteURL_KeepsOriginalSrc verifies that a remote URL (no local
// resource match) is emitted unchanged, with the type inferred from the
// file extension.
func TestVideoRemoteURL_KeepsOriginalSrc(t *testing.T) {
	outputDir := buildHugoSite(t, "video-remote-url")
	content := readOutputFile(t, outputDir, "posts/test-page/index.html")
	assertContains(t, content, `<source src="https://example.com/demo.mp4" type="video/mp4">`)
	assertContains(t, content, `<source src="https://example.com/movie.webm" type="video/webm">`)
}

// TestVideoRemoteURL_ExplicitTypeWins verifies that an explicit type
// parameter always takes precedence over extension inference.
func TestVideoRemoteURL_ExplicitTypeWins(t *testing.T) {
	outputDir := buildHugoSite(t, "video-remote-url")
	content := readOutputFile(t, outputDir, "posts/test-page/index.html")
	assertContains(t, content, `<source src="https://example.com/clip.mp4" type="video/webm">`)
}

// TestVideoRemoteURL_AutoplayImpliesMuted guards the existing behavior
// that autoplay always implies muted.
func TestVideoRemoteURL_AutoplayImpliesMuted(t *testing.T) {
	outputDir := buildHugoSite(t, "video-remote-url")
	content := readOutputFile(t, outputDir, "posts/test-page/index.html")
	assertContains(t, content, `autoplay`)
	assertContains(t, content, `muted`)
}

// TestVideoCaptions_RendersTracks verifies that the captions parameter
// produces one <track kind="subtitles"> per entry, with the subtitle file
// resolved through the local resource pipeline.
func TestVideoCaptions_RendersTracks(t *testing.T) {
	outputDir := buildHugoSite(t, "video-captions")
	content := readOutputFile(t, outputDir, "posts/test-page/index.html")
	assertContains(t, content, `<source src="/posts/test-page/video.mp4" type="video/mp4">`)
	assertContains(t, content, `<track kind="subtitles" srclang="zh-Hans" src="/posts/test-page/cn.vtt" label="zh-Hans">`)
	assertContains(t, content, `<track kind="subtitles" srclang="en" src="/posts/test-page/captions.vtt" label="en">`)
}

// TestVideoCaptions_Omitted renders no <track> elements at all.
func TestVideoCaptions_Omitted(t *testing.T) {
	outputDir := buildHugoSite(t, "video-remote-url")
	content := readOutputFile(t, outputDir, "posts/test-page/index.html")
	if strings.Contains(content, "<track") {
		t.Errorf("expected no <track> elements when captions is omitted, got:\n%s", content)
	}
}

// TestVideoCaptionsInvalid_Errors verifies that a malformed captions entry
// (no hyphen separating language code and file) fails the build with an
// error that points at the shortcode position.
func TestVideoCaptionsInvalid_Errors(t *testing.T) {
	root := testDir(t)
	siteDir := filepath.Join(root, "tests", "hugo", "testdata", "video-captions-invalid")

	cmd := exec.Command("hugo", "--source", siteDir)
	cmd.Dir = siteDir

	output, err := cmd.CombinedOutput()

	if err == nil {
		t.Fatalf("expected build error for invalid captions entry, but build succeeded:\n%s", string(output))
	}

	combined := string(output)
	if !strings.Contains(combined, "invalid captions entry") {
		t.Errorf("expected error to mention the invalid captions entry, got:\n%s", combined)
	}
	if !strings.Contains(combined, "test-page.md") {
		t.Errorf("expected error to include the shortcode position, got:\n%s", combined)
	}
}
