import path from "path";
import dotenv from "dotenv";

dotenv.config();

const rawBotToken = process.env.STRATEGY_APPS_ADMIN_BOT_TOKEN;
if (!rawBotToken) {
  throw new Error("ADMIN_TG_BOT_TOKEN not set in environment");
}

const botToken: string = rawBotToken;

const backendBaseUrl = process.env.BACKEND_API_URL ?? "http://localhost:3011";
const pollUrl = `${backendBaseUrl}/capStr/durovCaps/owner/poll`;
const pepePollUrl = `${backendBaseUrl}/pepeStr/pepeGifts/owner/poll`;

const rawPollApiKey = process.env.ADMIN_BACKEND_API_KEY;
if (!rawPollApiKey) {
  throw new Error("ADMIN_BACKEND_API_KEY not set in environment");
}

const pollApiKey: string = rawPollApiKey;

const tonApiBaseUrl = process.env.TON_API_BASE_URL ?? "https://tonapi.io/v2";
const tonApiKey = process.env.TON_API_KEY;

const pollIntervalMs = (() => {
  const fallback = 60_000;
  const raw = process.env.ADMIN_POLL_INTERVAL_MS;
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 5_000) {
    console.warn(
      "ADMIN_POLL_INTERVAL_MS is invalid or too low; defaulting to 60000"
    );
    return fallback;
  }
  return parsed;
})();

const staticChatIds = (process.env.ADMIN_POLL_CHAT_IDS ?? "")
  .split(",")
  .map((part) => part.trim())
  .filter((part) => part.length > 0)
  .map((part) => Number(part))
  .filter((id) => Number.isInteger(id));

if (staticChatIds.length === 0) {
  throw new Error("ADMIN_POLL_CHAT_IDS not set or empty in environment");
}

const dataDir =
  process.env.ADMIN_DATA_DIR ?? path.resolve(process.cwd(), "data");
const announcedFilePath = path.join(dataDir, "announced.json");
const rawLogFilePath = path.join(dataDir, "raw-caps-log.json");
const announcedPepeFilePath = path.join(dataDir, "announced-pepe.json");
const rawPepeLogFilePath = path.join(dataDir, "raw-pepe-log.json");

export {
  botToken,
  backendBaseUrl,
  pollUrl,
  pollApiKey,
  tonApiBaseUrl,
  tonApiKey,
  pollIntervalMs,
  staticChatIds,
  dataDir,
  announcedFilePath,
  rawLogFilePath,
  pepePollUrl,
  announcedPepeFilePath,
  rawPepeLogFilePath,
};

export const adminConfig = {
  botToken,
  backendBaseUrl,
  pollUrl,
  pollApiKey,
  tonApiBaseUrl,
  tonApiKey,
  pollIntervalMs,
  staticChatIds,
  dataDir,
  announcedFilePath,
  rawLogFilePath,
  pepePollUrl,
  announcedPepeFilePath,
  rawPepeLogFilePath,
};
