const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const dataDir = process.env.SYNC_NOTES_DATA_DIR || "E:\\SyncNotes\\data";
const dataFile = path.join(dataDir, "notes.json");
const filesDir = process.env.SYNC_NOTES_ATTACHMENTS_DIR || "E:\\SyncNotes\\attachments";

fs.mkdirSync(filesDir, { recursive: true });

function extensionFromAttachment(attachment, meta) {
  const name = String(attachment.name || "").toLowerCase();
  const match = name.match(/\.([a-z0-9]{2,5})$/);
  if (match) return match[1];
  const type = String(attachment.type || meta || "").toLowerCase();
  if (type.includes("png")) return "png";
  if (type.includes("jpeg") || type.includes("jpg")) return "jpg";
  if (type.includes("gif")) return "gif";
  if (type.includes("webp")) return "webp";
  if (type.includes("mpeg") || type.includes("mp3")) return "mp3";
  if (type.includes("wav")) return "wav";
  if (type.includes("mp4")) return "mp4";
  if (type.includes("webm")) return "webm";
  return "bin";
}

const data = JSON.parse(fs.readFileSync(dataFile, "utf8"));
const backup = path.join(dataDir, `notes.backup-before-attachment-files-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
fs.copyFileSync(dataFile, backup);

let migrated = 0;
for (const entry of data.entries || []) {
  for (const attachment of entry.attachments || []) {
    if (attachment.file) continue;
    const raw = String(attachment.data || "");
    if (!raw.startsWith("data:") || !raw.includes(",")) continue;
    const [meta, payload] = raw.split(",", 2);
    const type = attachment.type || (meta.match(/^data:([^;]+)/) || [])[1] || "application/octet-stream";
    const ext = extensionFromAttachment(attachment, meta);
    const fileName = `${entry.id}-${attachment.id || crypto.randomBytes(8).toString("hex")}.${ext}`;
    const filePath = path.join(filesDir, fileName);
    fs.writeFileSync(filePath, Buffer.from(payload, "base64"));
    attachment.type = type;
    attachment.file = fileName;
    attachment.size = fs.statSync(filePath).size;
    delete attachment.data;
    migrated += 1;
  }
}

fs.writeFileSync(dataFile, JSON.stringify(data, null, 2), "utf8");
console.log(JSON.stringify({ backup, migrated, filesDir }, null, 2));
