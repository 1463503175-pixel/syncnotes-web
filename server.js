const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { execFileSync } = require("child_process");

const root = __dirname;
const publicDir = path.join(root, "public");
const mobileDir = path.resolve(root, "..", "..", "app", "mobile-web");
const dataDir = process.env.SYNC_NOTES_DATA_DIR || "E:\\SyncNotes\\web\\data";
const dataFile = path.join(dataDir, "notes.json");
const draftsFile = path.join(dataDir, "drafts.json");
const syncMetaFile = path.join(dataDir, "sync-meta.json");
const tempDir = path.join(dataDir, "tmp");
const attachmentsDir = process.env.SYNC_NOTES_ATTACHMENTS_DIR || "E:\\SyncNotes\\web\\attachments";
const accessFile = path.join(dataDir, "access.json");
const ffmpegPath = process.env.FFMPEG_PATH || "E:\\SyncNotes\\app\\build-tools\\ffmpeg\\ffmpeg-8.1.1-essentials_build\\bin\\ffmpeg.exe";
const pythonPath = process.env.PYTHON_PATH || path.join(os.homedir(), ".cache", "codex-runtimes", "codex-primary-runtime", "dependencies", "python", "python.exe");
const attachmentTextExtractor = path.join(root, "tools", "extract_attachment_text.py");
const port = Number(process.env.PORT || 8765);
const MAX_BODY_BYTES = Number(process.env.SYNC_NOTES_MAX_BODY_BYTES || 200_000_000);
const MAX_RAW_UPLOAD_BYTES = Number(process.env.SYNC_NOTES_MAX_RAW_UPLOAD_BYTES || 1024 * 1024 * 1024);
const STORAGE_QUOTA_BYTES = Number(process.env.SYNC_NOTES_STORAGE_QUOTA_BYTES || 10 * 1024 * 1024 * 1024);

function loadLocalEnv() {
  const envFile = path.join(root, ".env.local");
  if (!fs.existsSync(envFile)) return;
  const lines = fs.readFileSync(envFile, "utf8").replace(/^\uFEFF/, "").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index < 1) continue;
    const key = trimmed.slice(0, index).trim().replace(/\s+/g, "_").toUpperCase();
    let value = trimmed.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key && !process.env[key]) process.env[key] = value;
  }
}

loadLocalEnv();

fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(tempDir, { recursive: true });
fs.mkdirSync(attachmentsDir, { recursive: true });
if (!fs.existsSync(dataFile)) {
  fs.writeFileSync(dataFile, JSON.stringify({ entries: [] }, null, 2), "utf8");
}
if (!fs.existsSync(draftsFile)) {
  fs.writeFileSync(draftsFile, JSON.stringify({ drafts: [] }, null, 2), "utf8");
}
if (!fs.existsSync(syncMetaFile)) {
  fs.writeFileSync(syncMetaFile, JSON.stringify({
    deviceId: crypto.randomBytes(12).toString("hex"),
    createdAt: Date.now(),
    updatedAt: Date.now()
  }, null, 2), "utf8");
}

function accessConfig() {
  try {
    const raw = fs.readFileSync(accessFile, "utf8").replace(/^\uFEFF/, "");
    const data = JSON.parse(raw);
    if (data && data.username && data.password) return data;
  } catch {}
  return null;
}

function unauthorized(res) {
  res.writeHead(401, {
    "WWW-Authenticate": 'Basic realm="Chen Dushan Notes"',
    "Content-Type": "text/plain; charset=utf-8"
  });
  res.end("Authentication required");
}

function sessionToken(cfg) {
  return crypto
    .createHmac("sha256", String(cfg.password || ""))
    .update(`${cfg.username}:${cfg.password}:chen-dushan-notes`)
    .digest("hex");
}

function cookieValue(req, name) {
  const header = req.headers.cookie || "";
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    if (part.slice(0, index).trim() === name) return decodeURIComponent(part.slice(index + 1).trim());
  }
  return "";
}

function checkAuth(req, res) {
  const cfg = accessConfig();
  if (!cfg) return true;
  const cookieToken = cookieValue(req, "chen_notes_session");
  if (cookieToken && cookieToken === sessionToken(cfg)) return true;
  const header = req.headers.authorization || "";
  if (!header.startsWith("Basic ")) {
    unauthorized(res);
    return false;
  }
  const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
  const index = decoded.indexOf(":");
  const username = index >= 0 ? decoded.slice(0, index) : "";
  const password = index >= 0 ? decoded.slice(index + 1) : "";
  if (username === cfg.username && password === cfg.password) {
    res.setHeader("Set-Cookie", `chen_notes_session=${encodeURIComponent(sessionToken(cfg))}; Path=/; SameSite=Lax; Max-Age=2592000`);
    return true;
  }
  unauthorized(res);
  return false;
}

function readEntries() {
  try {
    const data = JSON.parse(fs.readFileSync(dataFile, "utf8"));
    return Array.isArray(data.entries) ? data.entries : [];
  } catch {
    return [];
  }
}

function cleanBrokenText(value) {
  return String(value || "").replace(/\uFFFD+/g, "").replace(/[ \t]{2,}/g, " ").trim();
}

function cleanBrokenTextDeep(value) {
  if (typeof value === "string") return cleanBrokenText(value);
  if (Array.isArray(value)) return value.map(cleanBrokenTextDeep);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cleanBrokenTextDeep(item)]));
  }
  return value;
}

function writeEntries(entries) {
  fs.writeFileSync(dataFile, JSON.stringify({ entries: cleanBrokenTextDeep(entries) }, null, 2), "utf8");
}

function readDrafts() {
  try {
    const data = JSON.parse(fs.readFileSync(draftsFile, "utf8"));
    return Array.isArray(data.drafts) ? data.drafts : [];
  } catch {
    return [];
  }
}

function writeDrafts(drafts) {
  fs.writeFileSync(draftsFile, JSON.stringify({ drafts: cleanBrokenTextDeep(drafts) }, null, 2), "utf8");
}

function readSyncMeta() {
  try {
    const data = JSON.parse(fs.readFileSync(syncMetaFile, "utf8"));
    if (data && data.deviceId) return data;
  } catch {}
  const meta = {
    deviceId: crypto.randomBytes(12).toString("hex"),
    createdAt: Date.now(),
    updatedAt: Date.now()
  };
  writeSyncMeta(meta);
  return meta;
}

function writeSyncMeta(meta) {
  fs.writeFileSync(syncMetaFile, JSON.stringify({
    ...meta,
    updatedAt: Date.now()
  }, null, 2), "utf8");
}

function publicEntries() {
  return applyTombstones(readEntries(), syncMetaTombstones(), false).filter(item => !item.deletedAt);
}

function publicDrafts() {
  return applyTombstones(readDrafts(), syncMetaTombstones(), true).filter(item => !item.deletedAt);
}

function maxUpdatedAt(items) {
  return items.reduce((max, item) => Math.max(max, Number(item.updatedAt || item.createdAt || 0), Number(item.deletedAt || 0)), 0);
}

function syncStatePayload() {
  const entries = readEntries();
  const drafts = readDrafts();
  const meta = readSyncMeta();
  return {
    ok: true,
    deviceId: meta.deviceId,
    serverTime: Date.now(),
    counts: {
      entries: publicEntries().length,
      drafts: publicDrafts().length
    },
    versions: {
      entriesUpdatedAt: maxUpdatedAt(entries),
      draftsUpdatedAt: maxUpdatedAt(drafts)
    }
  };
}

function tombstoneKey(item) {
  return `${item && item.draft ? "draft" : "entry"}:${String(item && item.id || "")}`;
}

function normalizeTombstone(input, draft = false) {
  if (!input || !input.id) return null;
  const now = Date.now();
  const deletedAt = Number(input.deletedAt || input.updatedAt || now);
  const updatedAt = Number(input.updatedAt || deletedAt || now);
  return {
    id: String(input.id),
    draft: Boolean(input.draft ?? draft),
    deletedAt: Number.isFinite(deletedAt) && deletedAt > 0 ? deletedAt : now,
    updatedAt: Number.isFinite(updatedAt) && updatedAt > 0 ? updatedAt : now,
    deviceId: String(input.deviceId || ""),
  };
}

function deletionIdsFrom(body) {
  return [
    ...(Array.isArray(body.deletedIds) ? body.deletedIds : []),
    ...(Array.isArray(body.deleteIds) ? body.deleteIds : []),
    ...(Array.isArray(body.removedIds) ? body.removedIds : []),
    ...(Array.isArray(body.ids) ? body.ids : []),
  ].filter(Boolean);
}

function collectTombstones(body = {}) {
  const now = Date.now();
  const list = [];
  for (const item of Array.isArray(body.tombstones) ? body.tombstones : []) {
    const normalized = normalizeTombstone(item);
    if (normalized) list.push(normalized);
  }
  for (const id of deletionIdsFrom(body)) {
    list.push(normalizeTombstone({
      id,
      draft: false,
      deletedAt: now,
      updatedAt: now,
      deviceId: body.deviceId,
    }));
  }
  return list.filter(Boolean);
}

function mergeTombstones(current = [], incoming = []) {
  const map = new Map();
  for (const item of current) {
    const normalized = normalizeTombstone(item);
    if (normalized) map.set(tombstoneKey(normalized), normalized);
  }
  for (const item of incoming) {
    const normalized = normalizeTombstone(item);
    if (!normalized) continue;
    const existing = map.get(tombstoneKey(normalized));
    if (!existing || Number(normalized.updatedAt || normalized.deletedAt || 0) >= Number(existing.updatedAt || existing.deletedAt || 0)) {
      map.set(tombstoneKey(normalized), normalized);
    }
  }
  const cutoff = Date.now() - Number(process.env.SYNC_NOTES_TOMBSTONE_TTL_MS || 30 * 24 * 60 * 60 * 1000);
  return Array.from(map.values())
    .filter(item => Number(item.updatedAt || item.deletedAt || 0) >= cutoff)
    .sort((a, b) => Number(b.updatedAt || b.deletedAt || 0) - Number(a.updatedAt || a.deletedAt || 0));
}

function applyTombstones(items = [], tombstones = [], draft = false) {
  const latest = new Map();
  for (const item of tombstones) {
    if (Boolean(item.draft) !== Boolean(draft)) continue;
    const key = String(item.id || "");
    const version = Math.max(Number(item.updatedAt || 0), Number(item.deletedAt || 0));
    if (!key) continue;
    if (version > Number(latest.get(key) || 0)) latest.set(key, version);
  }
  return (items || []).filter(item => {
    const deleteVersion = Number(latest.get(String(item && item.id || "")) || 0);
    if (!deleteVersion) return !item.deletedAt;
    const itemVersion = Math.max(Number(item.updatedAt || item.createdAt || 0), Number(item.deletedAt || 0));
    return itemVersion > deleteVersion && !item.deletedAt;
  });
}

function syncMetaTombstones(meta = readSyncMeta()) {
  return Array.isArray(meta.tombstones) ? meta.tombstones.map(item => normalizeTombstone(item)).filter(Boolean) : [];
}

function rememberServerDelete(id, draft = false) {
  const meta = readSyncMeta();
  const tombstone = normalizeTombstone({
    id,
    draft,
    deletedAt: Date.now(),
    updatedAt: Date.now(),
    deviceId: meta.deviceId
  });
  writeSyncMeta({
    ...meta,
    tombstones: mergeTombstones(syncMetaTombstones(meta), [tombstone]),
    lastLocalDeleteAt: Date.now()
  });
}

function normalizeSyncItem(input, existing = {}, draft = false) {
  const cleaned = draft ? cleanDraft(input, existing) : cleanEntry(input, existing);
  const updatedAt = Number(input.updatedAt || cleaned.updatedAt || Date.now());
  const deletedAt = Number(input.deletedAt || 0);
  return {
    ...cleaned,
    updatedAt,
    deletedAt: Number.isFinite(deletedAt) && deletedAt > 0 ? deletedAt : undefined,
    deviceId: String(input.deviceId || existing.deviceId || "")
  };
}

function mergeSyncItems(current, incoming, draft = false) {
  const byId = new Map(current.map(item => [item.id, item]));
  for (const raw of Array.isArray(incoming) ? incoming : []) {
    if (!raw || !raw.id) continue;
    const existing = byId.get(raw.id) || {};
    const incomingVersion = Math.max(Number(raw.updatedAt || 0), Number(raw.deletedAt || 0));
    const existingVersion = Math.max(Number(existing.updatedAt || existing.createdAt || 0), Number(existing.deletedAt || 0));
    if (incomingVersion >= existingVersion) {
      byId.set(raw.id, normalizeSyncItem(raw, existing, draft));
    }
  }
  return Array.from(byId.values()).sort((a, b) => Math.max(Number(b.updatedAt || 0), Number(b.deletedAt || 0)) - Math.max(Number(a.updatedAt || 0), Number(a.deletedAt || 0)));
}

function send(res, status, body, type = "application/json; charset=utf-8") {
  res.writeHead(status, {
    "Content-Type": type,
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-File-Name, X-File-Type, X-File-Kind, X-Filename, X-Content-Type",
    "Access-Control-Allow-Credentials": "true"
  });
  res.end(body);
}

function json(res, status, value) {
  send(res, status, JSON.stringify(value), "application/json; charset=utf-8");
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", chunk => {
      body += chunk;
      if (body.length > MAX_BODY_BYTES) {
        reject(new Error("Body too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (err) {
        reject(err);
      }
    });
  });
}

function directorySize(dir) {
  if (!fs.existsSync(dir)) return 0;
  let total = 0;
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    const target = path.join(dir, item.name);
    try {
      if (item.isDirectory()) total += directorySize(target);
      else if (item.isFile()) total += fs.statSync(target).size;
    } catch {}
  }
  return total;
}

function stripDataUrl(data) {
  const text = String(data || "");
  const index = text.indexOf(",");
  return index >= 0 ? text.slice(index + 1) : "";
}

function safeBaseUrl() {
  return String(process.env.AI_BASE_URL || "").replace(/\/+$/, "");
}

function aiTextModel() {
  return process.env.AI_TEXT_MODEL || process.env.AI_MODEL || "gpt-4o-mini";
}

function aiVisionModel() {
  return process.env.AI_VISION_MODEL || aiTextModel();
}

function aiAudioModel() {
  return process.env.AI_AUDIO_MODEL || "";
}

function aiModel() {
  return aiTextModel();
}

function aiEnabled() {
  return Boolean(safeBaseUrl() && process.env.AI_API_KEY);
}

async function transcribeAudioDataUrl(attachment) {
  if (!aiEnabled() || !aiAudioModel() || !attachment.data) return "";
  const type = String(attachment.mimeType || attachment.type || "audio/mpeg");
  const name = String(attachment.name || "audio.mp3");
  const payload = stripDataUrl(attachment.data);
  if (!payload) return "";
  const buffer = Buffer.from(payload, "base64");
  if (!buffer.length || buffer.length > 18 * 1024 * 1024) return "";
  const form = new FormData();
  form.append("model", aiAudioModel());
  form.append("file", new Blob([buffer], { type }), name);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number(process.env.AI_AUDIO_TIMEOUT_MS || 30000));
  try {
    const response = await fetch(`${safeBaseUrl()}/audio/transcriptions`, {
      method: "POST",
      headers: { "Authorization": `Bearer ${process.env.AI_API_KEY}` },
      body: form,
      signal: controller.signal
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`audio_transcription_failed:${response.status}:${text.slice(0, 160)}`);
    try {
      const data = JSON.parse(text);
      return String(data.text || data.transcript || data.result || "").trim().slice(0, 6000);
    } catch {
      return text.trim().slice(0, 6000);
    }
  } finally {
    clearTimeout(timeout);
  }
}

async function enrichAudioAttachmentsForAi(body) {
  const attachments = Array.isArray(body.attachments) ? body.attachments : [];
  if (!attachments.some(item => attachmentKindForAi(item) === "audio" && item.data)) return body;
  const next = [];
  for (const item of attachments) {
    if (attachmentKindForAi(item) !== "audio" || item.text) {
      next.push(item);
      continue;
    }
    try {
      const text = await transcribeAudioDataUrl(item);
      next.push(text ? { ...item, text } : item);
    } catch {
      next.push(item);
    }
  }
  return { ...body, attachments: next };
}

function dataUrlMime(data) {
  const match = String(data || "").match(/^data:([^;,]+)/);
  return match ? match[1] : "";
}

function attachmentMimeForAi(attachment) {
  return String(attachment.mimeType || attachment.type || dataUrlMime(attachment.data) || "application/octet-stream");
}

function savedAttachmentPathForAi(attachment) {
  const file = String(attachment.file || attachment.path || attachment.fileUrl || attachment.url || "");
  if (!file || /^https?:\/\//i.test(file) || file.startsWith("data:")) return "";
  const normalized = file.replace(/^\/?uploads\//i, "").replace(/^\/+/, "");
  const safeFile = path.basename(normalized).replace(/[^a-zA-Z0-9._-]/g, "");
  if (!safeFile) return "";
  const target = path.resolve(attachmentsDir, safeFile);
  const rootDir = path.resolve(attachmentsDir);
  return target.startsWith(rootDir) ? target : "";
}

function attachmentBufferForAi(attachment) {
  const data = String(attachment.data || "");
  if (data.startsWith("data:") && data.includes(",")) {
    const payload = stripDataUrl(data);
    return payload ? Buffer.from(payload, "base64") : Buffer.alloc(0);
  }
  const filePath = savedAttachmentPathForAi(attachment);
  if (filePath && fs.existsSync(filePath)) return fs.readFileSync(filePath);
  return Buffer.alloc(0);
}

function imageDataUrlForAiAttachment(attachment, maxBytes) {
  const buffer = attachmentBufferForAi(attachment);
  if (!buffer.length) return "";
  const sourceMime = attachmentMimeForAi(attachment) || "image/jpeg";
  const originalDataUrl = `data:${sourceMime};base64,${buffer.toString("base64")}`;
  if (!fs.existsSync(ffmpegPath)) {
    return buffer.length <= Math.min(maxBytes, Number(process.env.AI_IMAGE_ORIGINAL_MAX_BYTES || 320 * 1024)) ? originalDataUrl : "";
  }
  const name = String(attachment.name || "image.jpg");
  const ext = (name.match(/\.([a-z0-9]{1,8})$/i) || [])[1] || extensionFromAttachment({ name, type: sourceMime }) || "jpg";
  const input = path.join(tempDir, `${crypto.randomBytes(12).toString("hex")}.${ext}`);
  const output = path.join(tempDir, `${crypto.randomBytes(12).toString("hex")}.jpg`);
  try {
    fs.writeFileSync(input, buffer);
    execFileSync(ffmpegPath, [
      "-y",
      "-hide_banner",
      "-loglevel", "error",
      "-i", input,
      "-frames:v", "1",
      "-vf", "scale=w=1280:h=1280:force_original_aspect_ratio=decrease,format=yuvj420p",
      "-q:v", String(process.env.AI_IMAGE_JPEG_QUALITY || 5),
      output
    ], {
      timeout: Number(process.env.AI_IMAGE_OPTIMIZE_TIMEOUT_MS || 15000),
      maxBuffer: 1024 * 1024
    });
    if (!fs.existsSync(output)) return "";
    const optimized = fs.readFileSync(output);
    if (!optimized.length || optimized.length > maxBytes) return "";
    return `data:image/jpeg;base64,${optimized.toString("base64")}`;
  } catch {
    return buffer.length <= Math.min(maxBytes, Number(process.env.AI_IMAGE_ORIGINAL_MAX_BYTES || 320 * 1024)) ? originalDataUrl : "";
  } finally {
    fs.rmSync(input, { force: true });
    fs.rmSync(output, { force: true });
  }
}

function dataUrlForAiAttachment(attachment, maxBytes) {
  if (attachmentKindForAi(attachment) === "image") {
    return imageDataUrlForAiAttachment(attachment, maxBytes);
  }
  const data = String(attachment.data || "");
  if (data.startsWith("data:") && data.includes(",")) {
    const estimated = Math.floor(stripDataUrl(data).length * 0.75);
    return estimated <= maxBytes ? data : "";
  }
  const filePath = savedAttachmentPathForAi(attachment);
  if (!filePath || !fs.existsSync(filePath)) return "";
  const stat = fs.statSync(filePath);
  if (!stat.size || stat.size > maxBytes) return "";
  return `data:${attachmentMimeForAi(attachment)};base64,${fs.readFileSync(filePath).toString("base64")}`;
}

function tempFileForAiAttachment(attachment) {
  const existing = savedAttachmentPathForAi(attachment);
  if (existing && fs.existsSync(existing)) return { filePath: existing, cleanup: () => {} };
  const buffer = attachmentBufferForAi(attachment);
  if (!buffer.length) return { filePath: "", cleanup: () => {} };
  const name = String(attachment.name || "attachment.bin");
  const ext = (name.match(/\.([a-z0-9]{1,8})$/i) || [])[1] || extensionFromAttachment({ name, type: attachmentMimeForAi(attachment) });
  const filePath = path.join(tempDir, `${crypto.randomBytes(12).toString("hex")}.${ext}`);
  fs.writeFileSync(filePath, buffer);
  return { filePath, cleanup: () => fs.rmSync(filePath, { force: true }) };
}

function extractAttachmentTextForAi(attachment) {
  const kind = attachmentKindForAi(attachment);
  if (!["pdf", "word", "ppt", "sheet", "text", "file"].includes(kind)) return "";
  if (!fs.existsSync(pythonPath) || !fs.existsSync(attachmentTextExtractor)) return "";
  const { filePath, cleanup } = tempFileForAiAttachment(attachment);
  if (!filePath) return "";
  try {
    const raw = execFileSync(pythonPath, [attachmentTextExtractor, filePath, kind], {
      encoding: "utf8",
      timeout: Number(process.env.AI_EXTRACT_TIMEOUT_MS || 30000),
      maxBuffer: 2 * 1024 * 1024
    });
    const result = JSON.parse(String(raw || "{}"));
    return result && result.ok ? String(result.text || "").trim().slice(0, 12000) : "";
  } catch {
    return "";
  } finally {
    cleanup();
  }
}

async function transcribeAudioAttachmentForAi(attachment) {
  if (!aiEnabled() || !aiAudioModel()) return "";
  const buffer = attachmentBufferForAi(attachment);
  if (!buffer.length || buffer.length > Number(process.env.AI_AUDIO_MAX_BYTES || 30 * 1024 * 1024)) return "";
  const type = attachmentMimeForAi(attachment) || "audio/mpeg";
  const name = String(attachment.name || "audio.mp3");
  const form = new FormData();
  form.append("model", aiAudioModel());
  form.append("file", new Blob([buffer], { type }), name);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number(process.env.AI_AUDIO_TIMEOUT_MS || 45000));
  try {
    const response = await fetch(`${safeBaseUrl()}/audio/transcriptions`, {
      method: "POST",
      headers: { "Authorization": `Bearer ${process.env.AI_API_KEY}` },
      body: form,
      signal: controller.signal
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`audio_transcription_failed:${response.status}:${text.slice(0, 160)}`);
    try {
      const data = JSON.parse(text);
      return String(data.text || data.transcript || data.result || "").trim().slice(0, 12000);
    } catch {
      return text.trim().slice(0, 12000);
    }
  } finally {
    clearTimeout(timeout);
  }
}

function compactAttachmentForAiV2(attachment) {
  const type = attachmentMimeForAi(attachment);
  const name = String(attachment.name || "附件");
  const item = {
    id: attachment.id || "",
    name,
    type,
    kind: attachment.kind || "",
    size: Number(attachment.size || 0),
    aiKind: attachmentKindForAi(attachment)
  };
  if (attachment.text) item.text = String(attachment.text).slice(0, 12000);
  if (attachment.transcription) item.text = String(attachment.transcription).slice(0, 12000);
  if (attachment.imageData) item.imageData = String(attachment.imageData);
  if (attachment.videoData) item.videoData = String(attachment.videoData);
  if (attachment.aiRecognized) item.aiRecognized = true;
  return item;
}

async function enrichAttachmentsForAi(body) {
  const attachments = Array.isArray(body.attachments) ? body.attachments : [];
  const next = [];
  for (const item of attachments) {
    const kind = attachmentKindForAi(item);
    const enriched = { ...item };
    try {
      if (kind === "audio" && !enriched.text && !enriched.transcription) {
        const text = await transcribeAudioAttachmentForAi(item);
        if (text) {
          enriched.text = text;
          enriched.transcription = text;
          enriched.aiRecognized = true;
        }
      } else if (["pdf", "word", "ppt", "sheet", "text", "file"].includes(kind) && !enriched.text) {
        const text = extractAttachmentTextForAi(item);
        if (text) {
          enriched.text = text;
          enriched.aiRecognized = true;
        }
      } else if (kind === "image" && !enriched.imageData) {
        const dataUrl = dataUrlForAiAttachment(item, Number(process.env.AI_IMAGE_MAX_BYTES || 8 * 1024 * 1024));
        if (dataUrl) {
          enriched.imageData = dataUrl;
          enriched.aiRecognized = true;
        }
      } else if (kind === "video" && !enriched.videoData && !enriched.imageData) {
        const dataUrl = dataUrlForAiAttachment(item, Number(process.env.AI_VIDEO_MAX_BYTES || 25 * 1024 * 1024));
        if (dataUrl) {
          enriched.videoData = dataUrl;
          enriched.aiRecognized = true;
        }
      }
    } catch {}
    next.push(enriched);
  }
  return { ...body, attachments: next };
}

function attachmentKindForAi(item) {
  const type = String(item.mimeType || item.type || "").toLowerCase();
  const explicitKind = String(item.kind || "").toLowerCase();
  const name = String(item.name || "").toLowerCase();
  if (explicitKind.includes("image")) return "image";
  if (explicitKind.includes("audio")) return "audio";
  if (explicitKind.includes("video")) return "video";
  if (explicitKind.includes("drawing")) return "image";
  if (explicitKind.includes("document")) return "file";
  if (type.startsWith("image/") || /\.(jpg|jpeg|png|webp|gif|bmp|svg)$/.test(name)) return "image";
  if (type.startsWith("audio/") || /\.(mp3|wav|m4a|webm|ogg|amr)$/.test(name)) return "audio";
  if (type.startsWith("video/") || /\.(mp4|mov|webm|mkv)$/.test(name)) return "video";
  if (/pdf/.test(type) || /\.pdf$/.test(name)) return "pdf";
  if (/word|officedocument\.word|msword/.test(type) || /\.(doc|docx)$/.test(name)) return "word";
  if (/presentation|powerpoint/.test(type) || /\.(ppt|pptx)$/.test(name)) return "ppt";
  if (/spreadsheet|excel/.test(type) || /\.(xls|xlsx)$/.test(name)) return "sheet";
  if (type.startsWith("text/") || /\.(txt|md)$/.test(name)) return "text";
  return "file";
}

function buildAttachmentSummaryTextV2(attachments) {
  return attachments.map((item, index) => {
    const kind = item.aiKind || attachmentKindForAi(item);
    const textSnippet = item.text ? "\n可读取内容片段：" + String(item.text).slice(0, 5000) : "";
    const status = item.aiRecognized || item.text || item.imageData || item.videoData ? "已识别" : "未读取正文";
    return [
      (index + 1) + ". 文件名：" + (item.name || "附件"),
      "附件类型：" + kind,
      "MIME：" + (item.type || "未知"),
      "大小：" + (item.size || 0) + " 字节",
      "识别状态：" + status + textSnippet
    ].join("\n");
  }).join("\n\n");
}

function buildAiTopicMessagesV2(body) {
  const attachments = Array.isArray(body.attachments) ? body.attachments.slice(0, 12).map(compactAttachmentForAiV2) : [];
  const noteContent = String(body.content || "").trim().slice(0, 5000);
  const currentTitle = String(body.title || "").trim();
  const attachmentText = buildAttachmentSummaryTextV2(attachments);
  let visionInlineCount = 0;
  const hasVision = attachments.some(item => item.imageData);
  const instruction = [
    "你是陈笃山记事本的 AI 取题助手。",
    "你只做两件事：根据正文和附件生成一个具体中文标题；如果正文为空，再根据附件识别结果生成一段简短介绍。",
    "必须只返回合法 JSON，不要 Markdown，不要解释。",
    "JSON 格式：{\"topic\":\"标题\",\"summary\":\"简介\",\"sources\":[{\"name\":\"文件名\",\"kind\":\"image/audio/video/document/text/file\",\"status\":\"recognized|fallback\",\"summary\":\"一句话依据\"}]}",
    "标题规则：中文，6 到 18 个中文字符，具体、可检索；不要用“未命名记录、今日记录、图片附件、文档附件、录音附件、新建记录”等空泛标题。",
    "summary 规则：正文为空时必须返回；正文不为空时可以为空。不要假装读懂无法读取的文件全文。",
    "",
    "记录类型：" + String(body.type || "diary"),
    "日期：" + String(body.date || ""),
    currentTitle ? "当前标题：" + currentTitle : "",
    noteContent ? "正文内容：" + noteContent : "正文内容：无",
    attachmentText ? "附件信息：\n" + attachmentText : "附件信息：无"
  ].filter(Boolean).join("\n");
  if (!hasVision) {
    return {
      model: aiTextModel(),
      messages: [
        { role: "system", content: "你只返回合法 JSON，用于私人记事本 AI 取题。" },
        { role: "user", content: instruction }
      ]
    };
  }
  const content = [{ type: "text", text: instruction }];
  for (const item of attachments) {
    if (item.imageData && visionInlineCount < Number(process.env.AI_MAX_INLINE_IMAGES || 1)) {
      content.push({ type: "image_url", image_url: { url: item.imageData } });
      visionInlineCount += 1;
    }
  }
  return {
    model: aiVisionModel(),
    messages: [
      { role: "system", content: "你只返回合法 JSON，用于私人记事本图片、视频和附件取题。" },
      { role: "user", content }
    ]
  };
}

function cleanAiTopic(text) {
  return String(text || "")
    .replace(/^\`\`\`json\s*/i, "")
    .replace(/^\`\`\`\s*/i, "")
    .replace(/\`\`\`$/i, "")
    .replace(/^[\"'“”‘’\s]+|[\"'“”‘’\s]+$/g, "")
    .replace(/[\r\n]+/g, " ")
    .replace(/[。！？!?，,；;：:]+$/g, "")
    .trim()
    .slice(0, 32);
}

function parseAiTopicResult(text) {
  const raw = String(text || "").trim().replace(/^\`\`\`json\s*/i, "").replace(/^\`\`\`\s*/i, "").replace(/\`\`\`$/i, "").trim();
  try {
    const data = JSON.parse(raw);
    return {
      topic: cleanAiTopic(data.topic || data.title || ""),
      summary: String(data.summary || data.description || "").trim(),
      sources: Array.isArray(data.sources) ? data.sources.slice(0, 8) : []
    };
  } catch {}
  const match = raw.match(/\{[\s\S]*\}/);
  if (match) {
    try {
      const data = JSON.parse(match[0]);
      return {
        topic: cleanAiTopic(data.topic || data.title || ""),
        summary: String(data.summary || data.description || "").trim(),
        sources: Array.isArray(data.sources) ? data.sources.slice(0, 8) : []
      };
    } catch {}
  }
  return { topic: cleanAiTopic(raw), summary: "", sources: [] };
}

function localAiTopicFallback(body) {
  const content = String(body.content || "").trim();
  const attachments = Array.isArray(body.attachments) ? body.attachments : [];
  if (content) {
    const first = content.split(/\n+/).map(line => line.trim()).find(Boolean) || "";
    const topic = cleanAiTopic(first.replace(/^[-*\d.\s、，。；:：]+/, "").replace(/[，。！？、,.!?;；:："“”‘’]/g, "").replace(/\s+/g, ""));
    return { topic: topic || "文字内容整理", summary: "", sources: [] };
  }
  if (!attachments.length) return { topic: "", summary: "", sources: [] };
  const kinds = new Set(attachments.map(attachmentKindForAi));
  const kindTitle =
    kinds.has("audio") ? "录音资料整理" :
    kinds.has("video") ? "视频资料记录" :
    kinds.has("image") ? "图片资料记录" :
    kinds.has("pdf") ? "PDF资料整理" :
    kinds.has("word") ? "文档资料整理" :
    kinds.has("ppt") ? "演示文稿整理" :
    kinds.has("sheet") ? "表格资料整理" :
    "附件资料整理";
  const names = attachments.map(item => item.name || "附件").slice(0, 4).join("、");
  return {
    topic: kindTitle,
    summary: "已上传 " + attachments.length + " 个附件：" + names + "。当前 AI 未完成深度识别，请检查模型配置后重新取题。",
    sources: attachments.slice(0, 8).map(item => ({
      name: item.name || "附件",
      kind: attachmentKindForAi(item),
      status: "fallback",
      summary: "未获得模型识别结果，仅保留附件信息"
    }))
  };
}

async function generateAiTopic(body) {
  if (!aiEnabled()) {
    return { ...localAiTopicFallback(body), enabled: false, reason: "ai_not_configured" };
  }
  const enrichedBody = await enrichAttachmentsForAi(body);
  const endpoint = `${safeBaseUrl()}/chat/completions`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number(process.env.AI_TIMEOUT_MS || 30000));
  const request = buildAiTopicMessagesV2(enrichedBody);
  const payload = {
    model: request.model,
    messages: request.messages,
    temperature: 0.2,
    max_tokens: 700
  };
  if (request.model === aiTextModel()) {
    payload.enable_thinking = false;
    payload.response_format = { type: "json_object" };
  }
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.AI_API_KEY}`
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`ai_request_failed:${response.status}:${text.slice(0, 160)}`);
    const data = JSON.parse(text);
    const message = data.choices && data.choices[0] && data.choices[0].message;
    const result = parseAiTopicResult(message && (message.content || message.reasoning_content || ""));
    if (!result.topic) {
      const fallback = localAiTopicFallback(enrichedBody);
      return { ...fallback, enabled: true, model: request.model, fallback: true };
    }
    if (!String(body.content || "").trim() && !result.summary) {
      result.summary = localAiTopicFallback(enrichedBody).summary;
    }
    return { ...result, enabled: true, model: request.model };
  } catch (err) {
    const fallback = localAiTopicFallback(enrichedBody);
    return {
      ...fallback,
      enabled: true,
      model: request.model,
      fallback: true,
      warning: err && err.message ? String(err.message).slice(0, 240) : "ai_topic_fallback"
    };
  } finally {
    clearTimeout(timeout);
  }
}

function summarizeEntriesForAi(entries, scope = "today") {
  return entries.slice(0, 80).map((entry, index) => {
    const attachments = Array.isArray(entry.attachments) ? entry.attachments : [];
    const attachmentText = attachments.map(item => `${item.name || "附件"}（${item.type || "文件"}）`).join("、") || "无附件";
    return [
      `${index + 1}. ${entry.date} ${entry.type} ${entry.status || ""}`,
      `标题：${entry.title || "无标题"}`,
      `内容：${String(entry.content || "").slice(0, 500)}`,
      `附件：${attachmentText}`
    ].join("\n");
  }).join("\n\n") || `${scope} 没有记录`;
}

async function generateAiDirectory(body) {
  if (!aiEnabled()) {
    return { text: "", enabled: false, reason: "ai_not_configured" };
  }
  const scope = body.scope || "today";
  const entries = Array.isArray(body.entries) ? body.entries : [];
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number(process.env.AI_TIMEOUT_MS || 20000));
  const payload = {
    model: aiModel(),
    messages: [
      { role: "system", content: "你是私人记事本整理助手。输出简洁中文目录，不要解释。" },
      {
        role: "user",
        content: [
          `请把这些${scope === "week" ? "本周" : "今天"}记录整理成清晰目录。`,
          "要求：按学习资料、录音记录、图片记录、文件资料、待办事项、其他记录分类；没有的分类不要写；保留关键标题；最后给 1-3 条待整理提醒。",
          "",
          summarizeEntriesForAi(entries, scope)
        ].join("\n")
      }
    ],
    temperature: 0.2,
    max_tokens: 800
  };
  try {
    const response = await fetch(`${safeBaseUrl()}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.AI_API_KEY}`
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`ai_request_failed:${response.status}:${text.slice(0, 160)}`);
    const data = JSON.parse(text);
    return {
      text: String(data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content || "").trim(),
      enabled: true,
      model: aiModel()
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function generateAiDraft(body) {
  if (!aiEnabled()) {
    return { text: "", title: "", enabled: false, reason: "ai_not_configured" };
  }
  const typeLabel = { diary: "日记", task: "事项", idea: "灵感" }[body.type] || "日记";
  const attachments = Array.isArray(body.attachments) ? body.attachments.slice(0, 8) : [];
  const attachmentText = attachments.map((item, index) => {
    return `${index + 1}. ${item.name || "附件"}（${item.type || "文件"}，${item.size || 0} 字节）`;
  }).join("\n") || "无附件";
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number(process.env.AI_TIMEOUT_MS || 18000));
  const payload = {
    model: aiModel(),
    messages: [
      { role: "system", content: "你是私人记事本写作助手。输出自然、简洁、可直接放入记事本的中文内容。" },
      {
        role: "user",
        content: [
          `记录类型：${typeLabel}`,
          `当前标题：${body.title || "未填写"}`,
          `日期：${body.date || ""}`,
          "附件：",
          attachmentText,
          "",
          "请生成一段适合放在“内容”里的草稿。要求：",
          "1. 不要虚构具体事实；",
          "2. 如果有附件，简要说明附件用途；",
          "3. 事项类型请用待办清单；",
          "4. 只输出内容，不要解释。"
        ].join("\n")
      }
    ],
    temperature: 0.4,
    max_tokens: 500
  };
  try {
    const response = await fetch(`${safeBaseUrl()}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.AI_API_KEY}`
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`ai_request_failed:${response.status}:${text.slice(0, 160)}`);
    const data = JSON.parse(text);
    return {
      text: String(data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content || "").trim(),
      title: cleanAiTopic(body.title || ""),
      enabled: true,
      model: aiModel()
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function generateAiChat(body) {
  if (!aiEnabled()) {
    return { text: "", enabled: false, reason: "ai_not_configured" };
  }
  const prompt = String(body.prompt || "").trim();
  const scope = String(body.scope || "当前记录");
  const entries = Array.isArray(body.entries) ? body.entries.slice(0, 30) : [];
  const history = Array.isArray(body.history) ? body.history.slice(-8) : [];
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number(process.env.AI_TIMEOUT_MS || 25000));
  const context = summarizeEntriesForAi(entries, scope);
  const messages = [
    {
      role: "system",
      content: [
        "你是陈笃山的个人记事本 AI 助手。",
        "你应该像 ChatGPT 一样自然对话，而不是只列固定功能。",
        "你可以基于用户的记事本记录进行总结、搜索、整理、提取待办、辅助写作和文件分析。",
        "回答要直接、有用、中文表达自然。如果上下文不足，先说明缺少什么，再给可执行建议。",
        "不要声称已经读取附件全文，除非上下文里确实提供了文字内容。"
      ].join("\n")
    },
    {
      role: "user",
      content: [
        `当前处理范围：${scope}`,
        "当前记录上下文：",
        context,
        "",
        "最近对话：",
        history.map(item => `${item.role === "user" ? "用户" : "助手"}：${String(item.text || "").slice(0, 600)}`).join("\n") || "暂无",
        "",
        `用户新问题：${prompt}`
      ].join("\n")
    }
  ];
  try {
    const response = await fetch(`${safeBaseUrl()}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.AI_API_KEY}`
      },
      body: JSON.stringify({
        model: aiModel(),
        messages,
        temperature: 0.45,
        max_tokens: 1200
      }),
      signal: controller.signal
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`ai_request_failed:${response.status}:${text.slice(0, 160)}`);
    const data = JSON.parse(text);
    return {
      text: String(data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content || "").trim(),
      enabled: true,
      model: aiModel()
    };
  } finally {
    clearTimeout(timeout);
  }
}

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
  if (type.includes("pdf")) return "pdf";
  if (type.includes("wordprocessingml") || type.includes("msword")) return "docx";
  if (type.includes("presentationml") || type.includes("powerpoint")) return "pptx";
  if (type.includes("spreadsheetml") || type.includes("excel")) return "xlsx";
  if (type.includes("plain")) return "txt";
  return "bin";
}

function safeUploadName(name) {
  const raw = decodeURIComponent(String(name || "attachment.bin")).replace(/[\\/:*?"<>|]+/g, "_").trim();
  return (raw || "attachment.bin").slice(0, 160);
}

function persistRawUpload(req) {
  return new Promise((resolve, reject) => {
    const now = Date.now();
    const originalName = safeUploadName(req.headers["x-file-name"]);
    const type = String(req.headers["x-file-type"] || req.headers["content-type"] || "application/octet-stream").split(";")[0].slice(0, 100);
    const kind = String(req.headers["x-file-kind"] || "").slice(0, 40);
    const ext = extensionFromAttachment({ name: originalName, type }) || "bin";
    const id = crypto.randomUUID ? crypto.randomUUID() : `${now.toString(36)}${Math.random().toString(36).slice(2, 10)}`;
    const file = `upload-${now}-${id}.${ext}`.replace(/[^a-zA-Z0-9._-]/g, "");
    const target = path.join(attachmentsDir, file);
    const temp = path.join(tempDir, `${file}.part`);
    let size = 0;
    let done = false;
    fs.mkdirSync(tempDir, { recursive: true });
    const out = fs.createWriteStream(temp);
    const cleanup = () => {
      try { fs.rmSync(temp, { force: true }); } catch {}
    };
    const fail = (err) => {
      if (done) return;
      done = true;
      out.destroy();
      cleanup();
      reject(err);
    };
    req.on("data", chunk => {
      size += chunk.length;
      if (size > MAX_RAW_UPLOAD_BYTES) {
        fail(new Error("raw_upload_too_large"));
        req.destroy();
        return;
      }
    });
    req.on("error", fail);
    out.on("error", fail);
    out.on("finish", () => {
      if (done) return;
      done = true;
      fs.renameSync(temp, target);
      resolve({
        id,
        name: originalName,
        type,
        kind,
        file,
        size,
        createdAt: now
      });
    });
    req.pipe(out);
  });
}

function persistAttachment(entryId, attachment, index) {
  const now = Date.now();
  const id = String(attachment.id || `${now.toString(36)}-${index}`);
  const base = {
    id,
    name: String(attachment.name || "attachment").slice(0, 120),
    type: String(attachment.type || "application/octet-stream").slice(0, 80),
    createdAt: attachment.createdAt || now,
    durationMs: Number(attachment.durationMs || 0) || undefined,
    duration: Number(attachment.duration || 0) || undefined
  };
  if (attachment.file) {
    return {
      ...base,
      file: String(attachment.file).replace(/[^a-zA-Z0-9._-]/g, ""),
      size: Number(attachment.size || 0)
    };
  }
  const data = String(attachment.data || "");
  if (!data.startsWith("data:") || !data.includes(",")) return null;
  if (!data.startsWith("data:image/") && !data.startsWith("data:audio/") && !data.startsWith("data:video/") && !data.startsWith("data:application/") && !data.startsWith("data:text/")) return null;
  const [meta, payload] = data.split(",", 2);
  const type = base.type || (meta.match(/^data:([^;]+)/) || [])[1] || "application/octet-stream";
  const ext = extensionFromAttachment({ ...attachment, type }, meta);
  const file = `${entryId}-${id}.${ext}`;
  const target = path.join(attachmentsDir, file);
  fs.writeFileSync(target, Buffer.from(payload || "", "base64"));
  return {
    ...base,
    type,
    file,
    size: fs.statSync(target).size
  };
}

function editedImagePayload(body) {
  const data = String(body.data || "");
  if (!data.startsWith("data:image/") || !data.includes(",")) {
    throw new Error("invalid_image_data");
  }
  const [meta, payload] = data.split(",", 2);
  const type = (meta.match(/^data:([^;]+)/) || [])[1] || "image/png";
  const ext = extensionFromAttachment({ name: body.name || "edited.png", type }, meta) || "png";
  return { type, ext, buffer: Buffer.from(payload || "", "base64") };
}

function cleanEntry(input, existing = {}) {
  const now = Date.now();
  const type = ["diary", "task", "idea"].includes(input.type) ? input.type : "diary";
  const id = existing.id || input.id || `${now.toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const attachments = Array.isArray(input.attachments)
    ? input.attachments.slice(0, 12).map((item, index) => persistAttachment(id, item, index)).filter(Boolean)
    : [];
  const tagSource = Array.isArray(input.tags) ? input.tags : Array.isArray(existing.tags) ? existing.tags : [];
  const tags = Array.from(new Set(tagSource.map(tag => String(tag || "").replace(/^#/, "").trim()).filter(Boolean).slice(0, 12))).map(tag => tag.slice(0, 24));
  return {
    id,
    type,
    title: String(input.title || "").slice(0, 120),
    date: String(input.date || new Date().toISOString().slice(0, 10)).slice(0, 10),
    status: type === "task" ? String(input.status || "open") : "",
    content: String(input.content || "").slice(0, 20000),
    tags,
    attachments,
    createdAt: existing.createdAt || input.createdAt || now,
    updatedAt: Number(input.updatedAt || existing.updatedAt || now)
  };
}

function cleanDraft(input, existing = {}) {
  const draft = cleanEntry(input, existing);
  return {
    ...draft,
    draft: true,
    updatedAt: Date.now()
  };
}

function extensionFromAudio(input) {
  const name = String(input.name || "").toLowerCase();
  const match = name.match(/\.([a-z0-9]{2,5})$/);
  if (match) return match[1];
  const type = String(input.type || "").toLowerCase();
  if (type.includes("amr")) return "amr";
  if (type.includes("wav")) return "wav";
  if (type.includes("mp4") || type.includes("m4a")) return "m4a";
  if (type.includes("ogg")) return "ogg";
  if (type.includes("webm")) return "webm";
  return "audio";
}

function convertAudioToMp3(input) {
  const name = String(input.name || "").toLowerCase();
  const type = String(input.type || "").toLowerCase();
  if (name.endsWith(".mp3") || type.includes("mpeg") || type.includes("mp3")) {
    return {
      ...input,
      id: input.id || crypto.randomBytes(8).toString("hex"),
      type: "audio/mpeg",
      createdAt: input.createdAt || Date.now()
    };
  }
  if (!fs.existsSync(ffmpegPath)) throw new Error("ffmpeg_not_found");
  const data = String(input.data || "");
  if (!data.startsWith("data:audio/") || !data.includes(",")) throw new Error("invalid_audio_data");
  const payload = data.split(",", 2)[1] || "";
  const id = crypto.randomBytes(12).toString("hex");
  const ext = extensionFromAudio(input);
  const source = path.join(tempDir, `${id}.${ext}`);
  const target = path.join(tempDir, `${id}.mp3`);
  fs.writeFileSync(source, Buffer.from(payload, "base64"));
  try {
    execFileSync(ffmpegPath, [
      "-y",
      "-hide_banner",
      "-loglevel", "error",
      "-i", source,
      "-vn",
      "-codec:a", "libmp3lame",
      "-b:a", "128k",
      target
    ], { stdio: "pipe" });
    const mp3 = fs.readFileSync(target);
    const base = String(input.name || "voice").replace(/\.[^.]+$/, "") || "voice";
    return {
      id: input.id || crypto.randomBytes(8).toString("hex"),
      name: `${base}.mp3`,
      type: "audio/mpeg",
      data: `data:audio/mpeg;base64,${mp3.toString("base64")}`,
      createdAt: input.createdAt || Date.now()
    };
  } finally {
    fs.rmSync(source, { force: true });
    fs.rmSync(target, { force: true });
  }
}

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
  const name = String(input.name || "").toLowerCase();
  const type = String(input.type || "").toLowerCase();
  if (name.endsWith(".mp4") || type.includes("mp4")) {
    return {
      ...input,
      id: input.id || crypto.randomBytes(8).toString("hex"),
      type: "video/mp4",
      createdAt: input.createdAt || Date.now()
    };
  }
  if (!fs.existsSync(ffmpegPath)) throw new Error("ffmpeg_not_found");
  const data = String(input.data || "");
  if (!data.startsWith("data:video/") || !data.includes(",")) throw new Error("invalid_video_data");
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
      id: input.id || crypto.randomBytes(8).toString("hex"),
      name: `${base}.mp4`,
      type: "video/mp4",
      data: `data:video/mp4;base64,${mp4.toString("base64")}`,
      createdAt: input.createdAt || Date.now()
    };
  } finally {
    fs.rmSync(source, { force: true });
    fs.rmSync(target, { force: true });
  }
}

function contentType(file) {
  const ext = path.extname(file).toLowerCase();
  if (ext === ".html") return "text/html; charset=utf-8";
  if (ext === ".css") return "text/css; charset=utf-8";
  if (ext === ".js") return "application/javascript; charset=utf-8";
  if (ext === ".json") return "application/json; charset=utf-8";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".png") return "image/png";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  if (ext === ".bmp") return "image/bmp";
  if (ext === ".svg") return "image/svg+xml";
  return "application/octet-stream";
}


function isPrivateIpv4(address) {
  const value = String(address || "");
  return /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(value);
}

function scoreIpv4(address) {
  const value = String(address || "");
  if (value.startsWith("10.")) return 30;
  if (value.startsWith("192.168.")) return 20;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(value)) return 10;
  return 0;
}

function ipconfigAddresses() {
  try {
    const output = execFileSync("ipconfig", { encoding: "utf8", windowsHide: true, timeout: 2500 });
    const list = [];
    for (const match of output.matchAll(/IPv4[^\r\n:：]*[:：]\s*([0-9]{1,3}(?:\.[0-9]{1,3}){3})/gi)) {
      const address = match[1];
      if (!address || address === "127.0.0.1" || address.startsWith("169.254.")) continue;
      if (!isPrivateIpv4(address)) continue;
      list.push(address);
    }
    return [...new Set(list)];
  } catch {
    return [];
  }
}

function localAddresses() {
  const nets = os.networkInterfaces();
  const candidates = [];
  for (const [name, list] of Object.entries(nets)) {
    for (const net of list || []) {
      if (net.family !== "IPv4" || net.internal) continue;
      const address = String(net.address || "");
      if (!address || address.startsWith("169.254.") || address === "127.0.0.1") continue;
      const label = String(name || "").toLowerCase();
      const virtual = /(virtual|vmware|virtualbox|hyper-v|vethernet|wsl|loopback|docker|npcap|bluetooth|tap|zerotier)/i.test(label);
      const preferred = /(wi-?fi|wlan|wireless|以太网|ethernet|lan)/i.test(label);
      const privateScore = address.startsWith("10.") ? 3 : address.startsWith("192.168.") ? 2 : /^172\.(1[6-9]|2\d|3[01])\./.test(address) ? 1 : 0;
      candidates.push({ address, score: (preferred ? 100 : 0) + (virtual ? -100 : 0) + privateScore, name });
    }
  }
  return candidates
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .map(item => item.address)
    .filter((address, index, list) => list.indexOf(address) === index);
}

function discoveryUrls() {
  const addresses = [...localAddresses(), ...ipconfigAddresses()]
    .filter(isPrivateIpv4)
    .filter((address, index, list) => list.indexOf(address) === index)
    .sort((a, b) => scoreIpv4(b) - scoreIpv4(a));
  return addresses.map(ip => `http://${ip}:${port}`);
}

function weatherText(code) {
  const value = Number(code);
  if ([0, 1].includes(value)) return "晴";
  if ([2, 3].includes(value)) return "多云";
  if ([45, 48].includes(value)) return "雾";
  if ([51, 53, 55, 56, 57].includes(value)) return "毛毛雨";
  if ([61, 63, 65, 66, 67, 80, 81, 82].includes(value)) return "雨";
  if ([71, 73, 75, 77, 85, 86].includes(value)) return "雪";
  if ([95, 96, 99].includes(value)) return "雷雨";
  return "天气";
}

async function lookupIpLocation() {
  const errors = [];
  const providers = [
    async () => {
      const response = await fetch("https://ipinfo.io/json");
      if (!response.ok) throw new Error(`ipinfo:${response.status}`);
      const data = await response.json();
      const [lat, lon] = String(data.loc || "").split(",").map(Number);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) throw new Error("ipinfo:no_coords");
      return {
        latitude: lat,
        longitude: lon,
        locality: data.city || data.region || "当前位置",
        province: data.region || "",
        country: data.country || "",
        location: Array.from(new Set([data.city, data.region, data.country].filter(Boolean))).join(" - ") || "当前位置"
      };
    },
    async () => {
      const response = await fetch("http://ip-api.com/json/?lang=zh-CN");
      if (!response.ok) throw new Error(`ip-api:${response.status}`);
      const data = await response.json();
      if (data.status !== "success" || !Number.isFinite(Number(data.lat)) || !Number.isFinite(Number(data.lon))) {
        throw new Error(data.message || "ip-api:no_coords");
      }
      return {
        latitude: Number(data.lat),
        longitude: Number(data.lon),
        locality: data.city || data.regionName || "当前位置",
        province: data.regionName || "",
        country: data.country || "",
        location: Array.from(new Set([data.city, data.regionName, data.country].filter(Boolean))).join(" - ") || "当前位置"
      };
    },
    async () => {
      const response = await fetch("https://ipwho.is/?lang=zh-CN");
      if (!response.ok) throw new Error(`ipwho:${response.status}`);
      const data = await response.json();
      if (!data || data.success === false || !Number.isFinite(Number(data.latitude)) || !Number.isFinite(Number(data.longitude))) {
        throw new Error(data && data.message || "ipwho:no_coords");
      }
      return {
        latitude: Number(data.latitude),
        longitude: Number(data.longitude),
        locality: data.city || data.region || "当前位置",
        province: data.region || "",
        country: data.country || "",
        location: Array.from(new Set([data.city, data.region, data.country].filter(Boolean))).join(" - ") || "当前位置"
      };
    }
  ];
  for (const provider of providers) {
    try {
      return await provider();
    } catch (error) {
      errors.push(error.message || String(error));
    }
  }
  throw new Error(`ip_location_failed:${errors.join(";")}`);
}

async function lookupWeatherByCoords(latitude, longitude) {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${encodeURIComponent(latitude)}&longitude=${encodeURIComponent(longitude)}&current=temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m,wind_direction_10m&timezone=auto`;
  const response = await fetch(url);
  if (!response.ok) throw new Error("weather_unavailable");
  const data = await response.json();
  const current = data.current || {};
  return {
    temperature: current.temperature_2m,
    feelsLike: current.apparent_temperature,
    humidity: current.relative_humidity_2m,
    windSpeed: current.wind_speed_10m,
    windDirection: current.wind_direction_10m,
    weatherCode: current.weather_code,
    condition: weatherText(current.weather_code)
  };
}

function airQualityText(aqi, pm25, pm10) {
  const value = Number(aqi);
  const level = Number.isFinite(value)
    ? value <= 50 ? "优" : value <= 100 ? "良" : value <= 150 ? "轻度污染" : value <= 200 ? "中度污染" : value <= 300 ? "重度污染" : "严重污染"
    : "";
  const parts = [];
  if (level) parts.push(`${level} AQI ${Math.round(value)}`);
  if (Number.isFinite(Number(pm25))) parts.push(`PM2.5 ${Number(pm25).toFixed(1)}`);
  if (Number.isFinite(Number(pm10))) parts.push(`PM10 ${Number(pm10).toFixed(1)}`);
  return parts.join(" · ") || "暂无空气质量数据";
}

async function lookupAirQualityByCoords(latitude, longitude) {
  const url = `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${encodeURIComponent(latitude)}&longitude=${encodeURIComponent(longitude)}&current=us_aqi,pm10,pm2_5&timezone=auto`;
  const response = await fetch(url);
  if (!response.ok) throw new Error("air_quality_unavailable");
  const data = await response.json();
  const current = data.current || {};
  return {
    aqi: current.us_aqi,
    pm25: current.pm2_5,
    pm10: current.pm10,
    airQuality: airQualityText(current.us_aqi, current.pm2_5, current.pm10)
  };
}

function localizePlace(place) {
  const cnMap = {
    CN: "中华人民共和国",
    China: "中华人民共和国",
    Hubei: "湖北省",
    Wuhan: "武汉市",
    Hongshan: "洪山区",
    Singapore: "新加坡"
  };
  const locality = cnMap[place.locality] || place.locality || "";
  const province = cnMap[place.province] || place.province || "";
  const country = cnMap[place.country] || place.country || "";
  return {
    ...place,
    locality: locality || province || "当前位置",
    province,
    country,
    location: Array.from(new Set([locality, province, country].filter(Boolean))).join(" - ") || place.location || "当前位置"
  };
}

let weatherFallbackCache = null;

async function serverWeatherFallback() {
  if (weatherFallbackCache && Date.now() - Number(weatherFallbackCache.updatedAt || 0) < 10 * 60 * 1000) {
    return { ...weatherFallbackCache, cached: true };
  }
  const place = localizePlace(await lookupIpLocation());
  const weather = await lookupWeatherByCoords(place.latitude, place.longitude);
  let air;
  try {
    air = await lookupAirQualityByCoords(place.latitude, place.longitude);
  } catch {
    air = { aqi: null, pm25: null, pm10: null, airQuality: "暂无空气质量数据" };
  }
  weatherFallbackCache = {
    ...place,
    ...weather,
    ...air,
    source: "IP兜底定位",
    updatedAt: Date.now()
  };
  return weatherFallbackCache;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || `localhost:${port}`}`);
    if (req.method === "OPTIONS") return send(res, 204, "");

    if (url.pathname === "/api/discovery" && req.method === "GET") {
      const urls = discoveryUrls();
      const requestHost = String(req.headers.host || "").split(":")[0];
      const hostUrl = isPrivateIpv4(requestHost) ? `http://${requestHost}:${port}` : "";
      const primaryUrl = urls[0] || hostUrl || `http://localhost:${port}`;
      return json(res, 200, {
        ok: true,
        name: "陈笃山的记事本",
        port,
        computerUrl: `http://localhost:${port}`,
        primaryUrl,
        mobileUrl: primaryUrl,
        hostUrl,
        urls,
        serverTime: Date.now()
      });
    }

    if (!checkAuth(req, res)) return;

    if (url.pathname === "/api/upload" && req.method === "POST") {
      try {
        const attachment = await persistRawUpload(req);
        return json(res, 201, { ok: true, attachment, maxRawUploadBytes: MAX_RAW_UPLOAD_BYTES });
      } catch (error) {
        const tooLarge = String(error && error.message || "") === "raw_upload_too_large";
        return json(res, tooLarge ? 413 : 500, {
          error: tooLarge ? "upload_too_large" : "upload_failed",
          maxRawUploadBytes: MAX_RAW_UPLOAD_BYTES
        });
      }
    }

    if (url.pathname === "/api/mobile-ai-config" && req.method === "GET") {
      return json(res, 200, {
        ok: true,
        enabled: aiEnabled(),
        baseUrl: safeBaseUrl(),
        apiKey: process.env.AI_API_KEY || "",
        textModel: aiTextModel(),
        visionModel: aiVisionModel(),
        audioModel: aiAudioModel()
      });
    }

    if (url.pathname === "/api/entries" && req.method === "GET") {
      return json(res, 200, { entries: publicEntries() });
    }

    if (url.pathname === "/api/drafts" && req.method === "GET") {
      return json(res, 200, { drafts: publicDrafts() });
    }

    if (url.pathname === "/api/attachments" && req.method === "GET") {
      const records = [
        ...publicEntries().map(item => ({ ...item, draft: false })),
        ...publicDrafts().map(item => ({ ...item, draft: true }))
      ];
      const attachments = [];
      for (const item of records) {
        for (const attachment of Array.isArray(item.attachments) ? item.attachments : []) {
          attachments.push({
            id: String(attachment.id || ""),
            entryId: String(item.id || ""),
            draft: Boolean(item.draft),
            name: attachment.name || attachment.file || "",
            type: attachment.type || "application/octet-stream",
            size: Number(attachment.size || 0),
            file: attachment.file || "",
            url: attachment.file ? `/uploads/${encodeURIComponent(attachment.file)}` : `/api/attachments/${encodeURIComponent(item.id)}/${encodeURIComponent(attachment.id || "")}`,
            updatedAt: Number(attachment.updatedAt || item.updatedAt || item.createdAt || 0)
          });
        }
      }
      return json(res, 200, { ok: true, attachments });
    }

    if (url.pathname === "/api/sync/state" && req.method === "GET") {
      return json(res, 200, syncStatePayload());
    }

    if (url.pathname === "/api/sync/pull" && req.method === "GET") {
      const since = Number(url.searchParams.get("since") || 0);
      const meta = readSyncMeta();
      const tombstones = syncMetaTombstones(meta);
      const entries = applyTombstones(readEntries(), tombstones, false)
        .filter(item => Math.max(Number(item.updatedAt || item.createdAt || 0), Number(item.deletedAt || 0)) > since);
      const drafts = applyTombstones(readDrafts(), tombstones, true)
        .filter(item => Math.max(Number(item.updatedAt || item.createdAt || 0), Number(item.deletedAt || 0)) > since);
      return json(res, 200, {
        ...syncStatePayload(),
        entries,
        drafts,
        tombstones: tombstones.filter(item => Math.max(Number(item.updatedAt || 0), Number(item.deletedAt || 0)) > since)
      });
    }

    if (url.pathname === "/api/sync/push" && req.method === "POST") {
      const body = await readBody(req);
      const previousMeta = readSyncMeta();
      const tombstones = mergeTombstones(syncMetaTombstones(previousMeta), collectTombstones(body));
      const entries = applyTombstones(mergeSyncItems(readEntries(), body.entries || [], false), tombstones, false);
      const drafts = applyTombstones(mergeSyncItems(readDrafts(), body.drafts || [], true), tombstones, true);
      writeEntries(entries);
      writeDrafts(drafts);
      writeSyncMeta({
        ...previousMeta,
        tombstones,
        lastPushAt: Date.now(),
        lastPeerDeviceId: String(body.deviceId || "")
      });
      return json(res, 200, {
        ...syncStatePayload(),
        entries: publicEntries(),
        drafts: publicDrafts(),
        tombstones
      });
    }

    if (url.pathname === "/api/sync/delete" && req.method === "POST") {
      const body = await readBody(req);
      const previousMeta = readSyncMeta();
      const tombstones = mergeTombstones(syncMetaTombstones(previousMeta), collectTombstones(body));
      const entries = applyTombstones(readEntries(), tombstones, false);
      const drafts = applyTombstones(readDrafts(), tombstones, true);
      writeEntries(entries);
      writeDrafts(drafts);
      writeSyncMeta({
        ...previousMeta,
        tombstones,
        lastPushAt: Date.now(),
        lastPeerDeviceId: String(body.deviceId || "")
      });
      return json(res, 200, {
        ...syncStatePayload(),
        entries: publicEntries(),
        drafts: publicDrafts(),
        tombstones
      });
    }

    if ((url.pathname === "/api/weather" || url.pathname === "/api/weather-fallback") && req.method === "GET") {
      try {
        return json(res, 200, { ok: true, weather: await serverWeatherFallback() });
      } catch (err) {
        return json(res, 200, { ok: false, error: err.message || "weather_fallback_failed" });
      }
    }

    if (url.pathname === "/api/storage" && req.method === "GET") {
      const dataBytes = directorySize(dataDir);
      const attachmentBytes = directorySize(attachmentsDir);
      return json(res, 200, {
        ok: true,
        dataBytes,
        attachmentBytes,
        totalBytes: dataBytes + attachmentBytes,
        quotaBytes: STORAGE_QUOTA_BYTES,
        maxBodyBytes: MAX_BODY_BYTES,
        approximateMaxFileBytes: Math.floor(MAX_BODY_BYTES * 0.72),
        maxRawUploadBytes: MAX_RAW_UPLOAD_BYTES
      });
    }

    if (url.pathname === "/api/convert-audio" && req.method === "POST") {
      const body = await readBody(req);
      return json(res, 200, { attachment: convertAudioToMp3(body) });
    }

    if (url.pathname === "/api/convert-video" && req.method === "POST") {
      const body = await readBody(req);
      return json(res, 200, { attachment: convertVideoToMp4(body) });
    }

    if (url.pathname === "/api/ai-topic" && req.method === "POST") {
      const body = await readBody(req);
      try {
        return json(res, 200, await generateAiTopic(body));
      } catch (err) {
        return json(res, 200, {
          ...localAiTopicFallback(body),
          enabled: aiEnabled(),
          error: err.message || "ai_topic_failed"
        });
      }
    }

    if (url.pathname === "/api/ai-directory" && req.method === "POST") {
      const body = await readBody(req);
      try {
        return json(res, 200, await generateAiDirectory(body));
      } catch (err) {
        return json(res, 200, {
          text: "",
          enabled: aiEnabled(),
          error: err.message || "ai_directory_failed"
        });
      }
    }

    if (url.pathname === "/api/ai-draft" && req.method === "POST") {
      const body = await readBody(req);
      try {
        return json(res, 200, await generateAiDraft(body));
      } catch (err) {
        return json(res, 200, {
          text: "",
          title: "",
          enabled: aiEnabled(),
          error: err.message || "ai_draft_failed"
        });
      }
    }

    if (url.pathname === "/api/ai-chat" && req.method === "POST") {
      const body = await readBody(req);
      try {
        return json(res, 200, await generateAiChat(body));
      } catch (err) {
        return json(res, 200, {
          text: "",
          enabled: aiEnabled(),
          error: err.message || "ai_chat_failed"
        });
      }
    }

    const attachmentMatch = url.pathname.match(/^\/api\/attachments\/([^/]+)\/([^/]+)$/);
    if (attachmentMatch && req.method === "GET") {
      const entryId = decodeURIComponent(attachmentMatch[1]);
      const attachmentId = decodeURIComponent(attachmentMatch[2]);
      const entry = readEntries().find(item => item.id === entryId);
      const attachment = entry && Array.isArray(entry.attachments)
        ? entry.attachments.find(item => item.id === attachmentId)
        : null;
      if (!attachment) {
        return send(res, 404, "Not found", "text/plain");
      }
      let type = attachment.type || "application/octet-stream";
      let buffer;
      if (attachment.file) {
        const safeFile = String(attachment.file).replace(/[^a-zA-Z0-9._-]/g, "");
        const filePath = path.join(attachmentsDir, safeFile);
        if (!filePath.startsWith(attachmentsDir) || !fs.existsSync(filePath)) {
          return send(res, 404, "Not found", "text/plain");
        }
        buffer = fs.readFileSync(filePath);
      } else if (String(attachment.data || "").includes(",")) {
        const [meta, payload] = attachment.data.split(",", 2);
        type = attachment.type || (meta.match(/^data:([^;]+)/) || [])[1] || "application/octet-stream";
        buffer = Buffer.from(payload || "", "base64");
      } else {
        return send(res, 404, "Not found", "text/plain");
      }
      const range = req.headers.range;
      if (range) {
        const match = range.match(/bytes=(\d*)-(\d*)/);
        if (!match) return send(res, 416, "Invalid range", "text/plain");
        const size = buffer.length;
        const start = match[1] ? Number(match[1]) : 0;
        const end = match[2] ? Number(match[2]) : size - 1;
        if (start >= size || end >= size || start > end) {
          res.writeHead(416, {
            "Content-Range": `bytes */${size}`,
            "Accept-Ranges": "bytes"
          });
          res.end();
          return;
        }
        const chunk = buffer.subarray(start, end + 1);
        res.writeHead(206, {
          "Content-Type": type,
          "Content-Length": chunk.length,
          "Content-Range": `bytes ${start}-${end}/${size}`,
          "Accept-Ranges": "bytes",
          "Content-Disposition": `inline; filename="${encodeURIComponent(attachment.name || attachment.file || "attachment")}"`,
          "Cache-Control": "private, max-age=3600"
        });
        res.end(chunk);
        return;
      }
      res.writeHead(200, {
        "Content-Type": type,
        "Content-Length": buffer.length,
        "Content-Disposition": `inline; filename="${encodeURIComponent(attachment.name || attachment.file || "attachment")}"`,
        "Cache-Control": "private, max-age=3600",
        "Accept-Ranges": "bytes"
      });
      res.end(buffer);
      return;
    }

    const uploadMatch = url.pathname.match(/^\/uploads\/(.+)$/);
    if (uploadMatch && req.method === "GET") {
      const safeFile = path.basename(decodeURIComponent(uploadMatch[1])).replace(/[^a-zA-Z0-9._\-\u4e00-\u9fff ]/g, "");
      const filePath = path.join(attachmentsDir, safeFile);
      if (!filePath.startsWith(attachmentsDir) || !fs.existsSync(filePath)) {
        return send(res, 404, "Not found", "text/plain");
      }
      return send(res, 200, fs.readFileSync(filePath), contentType(filePath));
    }

    if (url.pathname === "/api/entries" && req.method === "POST") {
      const body = await readBody(req);
      const entries = readEntries();
      const entry = cleanEntry(body);
      entries.unshift(entry);
      writeEntries(entries);
      return json(res, 201, { entry });
    }

    const attachmentEditMatch = url.pathname.match(/^\/api\/entries\/([^/]+)\/attachments\/([^/]+)$/);
    if (attachmentEditMatch && (req.method === "PUT" || req.method === "POST")) {
      const entryId = decodeURIComponent(attachmentEditMatch[1]);
      const attachmentId = decodeURIComponent(attachmentEditMatch[2]);
      const body = await readBody(req);
      const entries = readEntries();
      const entryIndex = entries.findIndex(item => item.id === entryId);
      if (entryIndex < 0) return json(res, 404, { error: "entry_not_found" });
      const entry = entries[entryIndex];
      const attachments = Array.isArray(entry.attachments) ? entry.attachments : [];
      const attachmentIndex = attachments.findIndex(item => String(item.id || "") === attachmentId);
      if (attachmentIndex < 0) return json(res, 404, { error: "attachment_not_found" });
      let image;
      try {
        image = editedImagePayload(body);
      } catch (err) {
        return json(res, 400, { error: err.message || "invalid_image" });
      }
      const original = attachments[attachmentIndex];
      if (req.method === "PUT") {
        const file = original.file
          ? String(original.file).replace(/[^a-zA-Z0-9._-]/g, "")
          : `${entryId}-${attachmentId}.${image.ext}`;
        const target = path.join(attachmentsDir, file);
        fs.writeFileSync(target, image.buffer);
        attachments[attachmentIndex] = {
          ...original,
          type: image.type,
          file,
          size: image.buffer.length,
          editedAt: Date.now()
        };
        entry.attachments = attachments;
        entry.updatedAt = Date.now();
        entries[entryIndex] = entry;
        writeEntries(entries);
        return json(res, 200, { entry, attachment: attachments[attachmentIndex] });
      }
      const id = crypto.randomBytes(8).toString("hex");
      const file = `${entryId}-${id}.${image.ext}`;
      fs.writeFileSync(path.join(attachmentsDir, file), image.buffer);
      const attachment = {
        id,
        name: String(body.name || `编辑图片-${new Date().toLocaleString("zh-CN").replace(/[\\/:*?"<>|]/g, "-")}.png`).slice(0, 160),
        type: image.type,
        file,
        size: image.buffer.length,
        sourceAttachmentId: attachmentId,
        createdAt: Date.now()
      };
      entry.attachments = attachments.concat(attachment).slice(0, 12);
      entry.updatedAt = Date.now();
      entries[entryIndex] = entry;
      writeEntries(entries);
      return json(res, 201, { entry, attachment });
    }

    if (url.pathname === "/api/drafts" && req.method === "POST") {
      const body = await readBody(req);
      const drafts = readDrafts();
      const draft = cleanDraft(body);
      drafts.unshift(draft);
      writeDrafts(drafts);
      return json(res, 201, { draft });
    }

    const match = url.pathname.match(/^\/api\/entries\/([^/]+)$/);
    if (match && req.method === "PUT") {
      const id = decodeURIComponent(match[1]);
      const body = await readBody(req);
      const entries = readEntries();
      const index = entries.findIndex(item => item.id === id);
      if (index < 0) return json(res, 404, { error: "not_found" });
      entries[index] = cleanEntry({ ...body, id }, entries[index]);
      writeEntries(entries);
      return json(res, 200, { entry: entries[index] });
    }

    if (match && req.method === "DELETE") {
      const id = decodeURIComponent(match[1]);
      const entries = readEntries();
      const next = entries.filter(item => item.id !== id);
      writeEntries(next);
      rememberServerDelete(id, false);
      return json(res, 200, { ok: true });
    }

    const draftMatch = url.pathname.match(/^\/api\/drafts\/([^/]+)$/);
    if (draftMatch && req.method === "PUT") {
      const id = decodeURIComponent(draftMatch[1]);
      const body = await readBody(req);
      const drafts = readDrafts();
      const index = drafts.findIndex(item => item.id === id);
      if (index < 0) return json(res, 404, { error: "not_found" });
      drafts[index] = cleanDraft({ ...body, id }, drafts[index]);
      writeDrafts(drafts);
      return json(res, 200, { draft: drafts[index] });
    }

    if (draftMatch && req.method === "DELETE") {
      const id = decodeURIComponent(draftMatch[1]);
      writeDrafts(readDrafts().filter(item => item.id !== id));
      rememberServerDelete(id, true);
      return json(res, 200, { ok: true });
    }

    if (url.pathname === "/api/import" && req.method === "POST") {
      const body = await readBody(req);
      const incoming = Array.isArray(body.entries) ? body.entries : [];
      const byId = new Map(readEntries().map(item => [item.id, item]));
      incoming.forEach(item => {
        const cleaned = cleanEntry(item, byId.get(item.id) || {});
        byId.set(cleaned.id, cleaned);
      });
      const entries = Array.from(byId.values()).sort((a, b) => b.updatedAt - a.updatedAt);
      writeEntries(entries);
      return json(res, 200, { entries });
    }

    if (url.pathname === "/mobile" || url.pathname.startsWith("/mobile/")) {
      const mobileRequest = url.pathname === "/mobile" || url.pathname === "/mobile/"
        ? "/index.html"
        : url.pathname.replace(/^\/mobile/, "");
      const mobilePath = path.normalize(path.join(mobileDir, mobileRequest));
      if (!mobilePath.startsWith(mobileDir)) return send(res, 403, "Forbidden", "text/plain");
      if (!fs.existsSync(mobilePath) || !fs.statSync(mobilePath).isFile()) {
        return send(res, 404, "Not found", "text/plain");
      }
      return send(res, 200, fs.readFileSync(mobilePath), contentType(mobilePath));
    }

    const requested = url.pathname === "/" || url.pathname === "/ai" ? "/index.html" : url.pathname;
    const filePath = path.normalize(path.join(publicDir, requested));
    if (!filePath.startsWith(publicDir)) return send(res, 403, "Forbidden", "text/plain");
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      return send(res, 404, "Not found", "text/plain");
    }
    send(res, 200, fs.readFileSync(filePath), contentType(filePath));
  } catch (err) {
    json(res, 500, { error: err.message || "server_error" });
  }
});

server.listen(port, "0.0.0.0", () => {
  console.log(`陈笃山的记事本 server running`);
  console.log(`Data file: ${dataFile}`);
  console.log(`Computer: http://localhost:${port}`);
  localAddresses().forEach(ip => console.log(`Phone/Wi-Fi: http://${ip}:${port}`));
});
