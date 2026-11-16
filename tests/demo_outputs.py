"""One-off manual driver: serves the mock API and invokes the real CLI."""
import json, os, subprocess, sys, tempfile

sys.path.insert(0, os.path.join(os.path.dirname(__file__)))
import test_resumable_crawl as mock

httpd, base_url = mock.start_server()
tmp = tempfile.mkdtemp(prefix="rc-demo-")
out = os.path.join(tmp, "hono-docs")
env = dict(os.environ, SCAVIO_API_KEY="test-key")

script = os.path.abspath(os.path.join(os.path.dirname(__file__), "..",
                                      "examples", "resumable_crawl.py"))
subprocess.run([sys.executable, "-I", script,
                "--base-url", base_url, "--poll-interval", "0",
                "crawl", "--url", "https://example.test/docs",
                "--max-pages", "10", "--out", out], check=True, env=env)

print("\n--- tree ---")
for root, _, files in os.walk(out):
    for f in sorted(files):
        p = os.path.join(root, f)
        print(os.path.relpath(p, out), os.path.getsize(p), "bytes")

print("\n--- failures.json ---")
print(open(os.path.join(out, "failures.json"), encoding="utf-8").read())
print("--- one page file (verbatim) ---")
fn = mock.rc.url_to_filename("https://example.test/docs/intro", "md")
print(open(os.path.join(out, "pages", fn), encoding="utf-8", newline="").read(), end="")
httpd.shutdown()
