import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createHash, createPrivateKey, createPublicKey } from "node:crypto";
import { execFileSync } from "node:child_process";

const root = fileURLToPath(new URL("../", import.meta.url));
const { values } = parseArgs({ options: { key: { type: "string" }, tag: { type: "string" } } });
const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
if (manifest.version !== pkg.version) throw new Error("manifest.json and package.json versions must match.");
if (!/^\d+(\.\d+){1,3}$/.test(manifest.version)) throw new Error("Invalid extension version.");
const tag = values.tag || (process.env.GITHUB_REF_TYPE === "tag" ? process.env.GITHUB_REF_NAME : undefined);
if (tag && tag !== `v${manifest.version}`) throw new Error(`Release tag must be v${manifest.version}, received ${tag}.`);

// A missing key must fail instead of silently changing the extension ID.
const pem = values.key ? fs.readFileSync(values.key, "utf8") : process.env.CRX_PRIVATE_KEY;
if (!pem) throw new Error("Set CRX_PRIVATE_KEY or pass --key <private-key.pem>; the signing key is never generated during packaging.");
const privateKey = createPrivateKey(pem);
if (privateKey.asymmetricKeyType !== "rsa") throw new Error("The CRX signing key must be RSA.");
const publicKey = createPublicKey(privateKey).export({ type: "spki", format: "der" });
if (manifest.key && manifest.key !== publicKey.toString("base64")) throw new Error("Manifest key does not match the signing key.");
const extensionId = [...createHash("sha256").update(publicKey).digest("hex").slice(0, 32)]
  .map(char => String.fromCharCode(97 + parseInt(char, 16))).join("");
const chrome = process.env.CHROME_PATH || (process.platform === "darwin"
  ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
  : "google-chrome");

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "live-audio-sync-pack-"));
try {
  const stage = path.join(temp, "extension");
  fs.mkdirSync(stage);
  // Runtime resources live at the repository root. Never copy the whole checkout.
  const files = fs.readdirSync(root, { withFileTypes: true })
    .filter(entry => entry.isFile() && (/\.(js|html|css)$/.test(entry.name) || entry.name === "LICENSE"))
    .map(entry => entry.name);
  for (const name of files) fs.copyFileSync(path.join(root, name), path.join(stage, name));
  // The unpacked ZIP uses the same stable ID as the signed CRX.
  fs.writeFileSync(path.join(stage, "manifest.json"), `${JSON.stringify({ ...manifest, key: publicKey.toString("base64") }, null, 2)}\n`);
  const keyPath = path.join(temp, "private-key.pem");
  fs.writeFileSync(keyPath, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  execFileSync(chrome, [
    "--headless=new", "--no-sandbox", "--disable-gpu", "--no-first-run",
    `--user-data-dir=${path.join(temp, "chrome-profile")}`,
    `--pack-extension=${stage}`, `--pack-extension-key=${keyPath}`
  ], { stdio: "pipe", timeout: 30_000 });

  const crx = fs.readFileSync(`${stage}.crx`);
  if (crx.length < 12 || crx.toString("ascii", 0, 4) !== "Cr24" || crx.readUInt32LE(4) !== 3) {
    throw new Error("Chrome did not produce a valid CRX3 package.");
  }
  // CRX3 contains the ZIP after its 12-byte prefix and protobuf header.
  const zipOffset = 12 + crx.readUInt32LE(8);
  if (zipOffset + 4 > crx.length || crx.readUInt32LE(zipOffset) !== 0x04034b50) {
    throw new Error("The CRX3 archive is missing its ZIP payload.");
  }
  const dist = path.join(root, "dist");
  fs.mkdirSync(dist, { recursive: true });
  const base = `BilibiliLiveDelay-v${manifest.version}`;
  const artifacts = [[`${base}.crx`, crx], [`${base}.zip`, crx.subarray(zipOffset)]];
  for (const [name, data] of artifacts) fs.writeFileSync(path.join(dist, name), data);
  fs.writeFileSync(path.join(dist, "SHA256SUMS"), artifacts
    .map(([name, data]) => `${createHash("sha256").update(data).digest("hex")}  ${name}\n`).join(""));
  console.log(`Packaged v${manifest.version}: ${files.length + 1} files; extension ID ${extensionId}`);
  console.log(`Artifacts: dist/${base}.crx, dist/${base}.zip, dist/SHA256SUMS`);
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
