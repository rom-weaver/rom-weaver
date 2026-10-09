import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const START = "<!-- apply-video:start -->";
const END = "<!-- apply-video:end -->";
const ATTACHMENT = /^https:\/\/github\.com\/user-attachments\/assets\/[a-f0-9-]+$/;

export function replaceApplyVideo(readme, url) {
  if (!ATTACHMENT.test(url)) throw new Error("Expected a GitHub video attachment URL");
  if (readme.split(START).length !== 2 || readme.split(END).length !== 2) {
    throw new Error("README must contain exactly one apply-video marker pair");
  }
  const start = readme.indexOf(START) + START.length;
  const end = readme.indexOf(END);
  if (end < start) throw new Error("README apply-video markers are reversed");
  return `${readme.slice(0, start)}\nApply two sample patches and download the result as 7z.\n\n<${url}>\n${readme.slice(end)}`;
}

export function publishApplyVideo(root = ROOT) {
  const readmePath = path.join(root, "README.md");
  const readme = fs.readFileSync(readmePath, "utf8");
  // Validate the destination before creating an attachment that cannot be reused on failure.
  replaceApplyVideo(
    readme,
    "https://github.com/user-attachments/assets/00000000-0000-0000-0000-000000000000",
  );
  const video = path.join(root, ".cache/agents/scratch/release-video/apply-workflow.mp4");
  const bytes = fs.readFileSync(video);
  if (bytes.length < 12 || bytes.length > 10_000_000 || bytes.toString("ascii", 4, 8) !== "ftyp") {
    throw new Error("Expected a validated MP4 smaller than 10 MB");
  }
  const repository = process.env.GITHUB_REPOSITORY;
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository ?? ""))
    throw new Error("GITHUB_REPOSITORY is required");
  const gh = (args) => execFileSync("gh", args, { encoding: "utf8", timeout: 120_000 });
  const id = gh(["api", `repos/${repository}`, "--jq", ".id"]).trim();
  if (!/^\d+$/.test(id)) throw new Error("GitHub returned an invalid repository ID");
  // GitHub attachments require a user token; the installation GITHUB_TOKEN cannot upload them.
  const response = JSON.parse(
    gh([
      "api",
      "--method",
      "POST",
      `https://uploads.github.com/user-attachments/assets?name=apply-workflow.mp4&content_type=video%2Fmp4&repository_id=${id}`,
      "-H",
      "Content-Type: application/octet-stream",
      "--input",
      video,
    ]),
  );
  const updated = replaceApplyVideo(readme, response.url);
  fs.writeFileSync(readmePath, updated);
  console.log(`Updated README video: ${response.url}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) publishApplyVideo();
