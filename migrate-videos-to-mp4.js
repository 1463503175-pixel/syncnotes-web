const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execFileSync } = require("child_process");

const dataDir = process.env.SYNC_NOTES_DATA_DIR || "E:\\SyncNotes\\data";
const dataFile = path.join(dataDir, "notes.json");
const tempDir = path.join(dataDir, "tmp");
const ffmpegPath = process.env.FFMPEG_PATH || "E:\\SyncNotes\\tools\\ffmpeg\\ffmpeg-8.1.1-essentials_build\\bin\\ffmpeg.exe";

fs.mkdirSync(tempDir, { recursive: true });

function extensionFromVideo(input) {
  const name = String(input.name || "").toLowerCase();
  const match = name.match(/\.([a-z0-9]{2,5})$/);
  if (match) return match[1];
  const type = String(input.type || "").toLowerCase();
  if (type.includes("avi")) return "avi";
  if (type.includes("quicktime")) return "mov";
  if (type.includes("webm")) return "webm";
  if (type.includes("mp4")) return "mp4";
  return "video";
}

function convertVideoToMp4(input) {
  const data = String(input.data || "");
  const payload = data.split(",", 2)[1] || "";
  const id = crypto.randomBytes(12).toString("hex");
  const ext = extensionFromVideo(input);
  const source = path.join(tempDir, `${id}.${ext}`);
  const target = path.join(tempDir, `${id}.mp4`);
  fs.writeFileSync(source, Buffer.from(payload, "base64"));
  try {
    execFileSync(ffmpegPath, [
      "-y",
      "-hide_banner",
      "-loglevel", "error",
      "-i", source,
      "-vf", "scale='min(1280,iw)':-2",
      "-c:v", "libx264",
      "-preset", "veryfast",
      "-crf", "24",
      "-pix_fmt", "yuv420p",
      "-movflags", "+faststart",
      "-c:a", "aac",
      "-b:a", "128k",
      target
    ], { stdio: "pipe" });
    const mp4 = fs.readFileSync(target);
    const base = String(input.name || "video").replace(/\.[^.]+$/, "") || "video";
    return {
      ...input,
      name: `${base}.mp4`,
      type: "video/mp4",
      data: `data:video/mp4;base64,${mp4.toString("base64")}`
    };
  } finally {
    fs.rmSync(source, { force: true });
    fs.rmSync(target, { force: true });
  }
}

const data = JSON.parse(fs.readFileSync(dataFile, "utf8"));
const backup = path.join(dataDir, `notes.backup-before-video-migration-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
fs.copyFileSync(dataFile, backup);

let converted = 0;
let skipped = 0;
for (const entry of data.entries || []) {
  for (let i = 0; i < (entry.attachments || []).length; i += 1) {
    const attachment = entry.attachments[i];
    const raw = String(attachment.data || "");
    if (!raw.startsWith("data:video/")) continue;
    if (raw.startsWith("data:video/mp4") && attachment.type === "video/mp4") {
      skipped += 1;
      continue;
    }
    console.log(`Converting ${attachment.name || attachment.id}`);
    entry.attachments[i] = convertVideoToMp4(attachment);
    entry.updatedAt = Date.now();
    converted += 1;
  }
}

fs.writeFileSync(dataFile, JSON.stringify(data, null, 2), "utf8");
console.log(JSON.stringify({ backup, converted, skipped }, null, 2));
