import { promises as fs } from "fs";
import path from "path";
import dotenv from "dotenv";
import { Telegraf } from "telegraf";
import BigNumber from "bignumber.js";

dotenv.config();

interface CapSummary {
  onchainAddress: string | null;
  offchainGetgemsAddress: string;
  name: string;
  capNumber: number;
  collectionAddress: string;
  image: string;
  saleType: string;
  salePriceTon: string;
  buyPriceTon: string;
  detectedAt: number;
  buyTime: number;
  getGemsUrl: string;
  txHash: string;
  fromWalletAddress: string;
  toWalletAddress: string;
  giftId: number;
}

interface PollResponse {
  readonly success: boolean;
  message: string;
  data?: {
    ownerAddress: string;
    totalCaps: number;
    hasNew: boolean;
    newCaps: CapSummary[];
    seenCaps: string[];
    polledAt: number;
  };
}

const botToken = process.env.STRATEGY_APPS_ADMIN_BOT_TOKEN;
if (!botToken) {
  throw new Error("ADMIN_TG_BOT_TOKEN not set in environment");
}
const backendBaseUrl = process.env.BACKEND_API_URL ?? "http://localhost:3011";
const pollUrl = `${backendBaseUrl}/capStr/durovCaps/owner/poll`;
const rawPollApiKey = process.env.ADMIN_BACKEND_API_KEY;
if (!rawPollApiKey) {
  throw new Error("ADMIN_BACKEND_API_KEY not set in environment");
}
const pollApiKey = rawPollApiKey;

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

const bot = new Telegraf(botToken);

const staticChatIds = (process.env.ADMIN_POLL_CHAT_IDS ?? "")
  .split(",")
  .map((part) => part.trim())
  .filter((part) => part.length > 0)
  .map((part) => Number(part))
  .filter((id) => Number.isInteger(id));

if (staticChatIds.length === 0) {
  throw new Error("ADMIN_POLL_CHAT_IDS not set or empty in environment");
}

const allowedChatIds = new Set(staticChatIds);
const subscribedChats = new Set(staticChatIds);

type CapState = "PARTIAL_PUBLISHED" | "PUBLISHED" | "APPROVED" | "REJECTED";

type ApiRecord = Record<string, unknown>;

interface BackendTransactionPayload {
  txHash: string;
  fromWalletAddress: string;
  toWalletAddress: string;
  giftId: number;
  currency: string;
  amount: string;
  txType: string;
  timeStamp: number;
}

interface StoredCap {
  item: CapSummary;
  state: CapState;
  publishedChatIds: number[];
  messageIds: { [chatId: number]: number };
  isEdited: boolean;
  buyTransactionRecord: ApiRecord | null;
  capStrRecord: ApiRecord | null;
}

const announcedCaps = new Map<string, StoredCap>();

const dataDir =
  process.env.ADMIN_DATA_DIR ?? path.resolve(process.cwd(), "data");
const announcedFilePath = path.join(dataDir, "announced.json");
const rawLogFilePath = path.join(dataDir, "raw-caps-log.json");

const editableFields = [
  "Getgems Address",
  "Name",
  "Record Type",
  "Buy Price",
  "Sale Price",
  "Buy Time (UTC)",
  "GetGems URL",
  "Link to Gift",
  "Tx Hash",
  "Seller Wallet",
  "Buyer Wallet",
];

const fieldToProperty: { [key: string]: string } = {
  "Getgems Address": "offchainGetgemsAddress",
  Name: "name",
  "Record Type": "saleType",
  "Buy Price": "buyPriceTon",
  "Sale Price": "salePriceTon",
  "Buy Time (UTC)": "buyTime",
  "GetGems URL": "getGemsUrl",
  "Link to Gift": "onchainAddress",
  "Tx Hash": "txHash",
  "Seller Wallet": "fromWalletAddress",
  "Buyer Wallet": "toWalletAddress",
};

interface RawCapLogEntry {
  receivedAt: number;
  cap: CapSummary;
}

function tonFriendlyAddress(raw: string | null | undefined): string {
  if (!raw) return "";
  const trimmed = raw.trim();
  if (!trimmed.includes(":")) {
    return trimmed;
  }

  const [wcPart, hashPart] = trimmed.split(":");
  if (!wcPart || !hashPart) {
    return trimmed;
  }

  const normalizedHash = hashPart.replace(/[^0-9a-fA-F]/g, "").toLowerCase();
  if (normalizedHash.length !== 64) {
    return trimmed;
  }

  const workchain = Number(wcPart);
  if (!Number.isInteger(workchain) || workchain < -128 || workchain > 127) {
    return trimmed;
  }

  const addressBytes = Buffer.alloc(34);
  addressBytes[0] = 0x11; // bounceable, non-bounce flag not set, non-testnet
  addressBytes.writeInt8(workchain, 1);
  Buffer.from(normalizedHash, "hex").copy(addressBytes, 2);

  const crc = crc16(addressBytes);
  const full = Buffer.alloc(36);
  addressBytes.copy(full, 0);
  full[34] = (crc >> 8) & 0xff;
  full[35] = crc & 0xff;

  return full
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function crc16(buffer: Buffer): number {
  let crc = 0xffff;
  for (let i = 0; i < buffer.length; i += 1) {
    crc ^= buffer[i] << 8;
    for (let j = 0; j < 8; j += 1) {
      if (crc & 0x8000) {
        crc = ((crc << 1) ^ 0x1021) & 0xffff;
      } else {
        crc = (crc << 1) & 0xffff;
      }
    }
  }
  return crc & 0xffff;
}

function buildActionKeyboard(capAddress: string) {
  return {
    inline_keyboard: [
      [
        { text: "Approve", callback_data: `approve_${capAddress}` },
        { text: "Edit", callback_data: `edit_${capAddress}` },
        { text: "Reject", callback_data: `reject_${capAddress}` },
      ],
    ],
  };
}

function buildFieldSelectionKeyboard() {
  const keyboard: { text: string; callback_data: string }[][] = [];
  for (let i = 0; i < editableFields.length; i += 3) {
    const row: { text: string; callback_data: string }[] = [];
    for (let j = i; j < Math.min(i + 3, editableFields.length); j += 1) {
      row.push({ text: editableFields[j], callback_data: `select_field_${j}` });
    }
    keyboard.push(row);
  }
  return keyboard;
}

const editState = new Map<
  number,
  {
    capAddress: string;
    field: string;
    promptMessageId: number;
    chatId: number;
    selectMessageId: number;
    infoMessageId: number;
  }
>();

const fieldSelectState = new Map<
  number,
  { address: string; selectMessageId: number; infoMessageId: number }
>(); // chatId to selection metadata

const registerFlowState = new Map<
  number,
  { chatId: number; promptMessageId: number; helperMessageIds: number[] }
>();

async function loadAnnouncedAddresses(): Promise<void> {
  try {
    const raw = await fs.readFile(announcedFilePath, "utf8");
    const parsed = JSON.parse(raw) as { caps?: StoredCap[] };
    if (Array.isArray(parsed.caps)) {
      parsed.caps.forEach((stored) => {
        stored.messageIds = stored.messageIds ?? {};
        stored.isEdited = stored.isEdited || false;
        stored.buyTransactionRecord = stored.buyTransactionRecord ?? null;
        stored.capStrRecord = stored.capStrRecord ?? null;
        announcedCaps.set(stored.item.offchainGetgemsAddress, stored);
      });
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return;
    console.error("Failed to load announced caps", error);
  }
}

async function persistAnnouncedAddresses(): Promise<void> {
  try {
    await fs.mkdir(dataDir, { recursive: true });
    const payload = JSON.stringify(
      { caps: Array.from(announcedCaps.values()) },
      null,
      2
    );
    await fs.writeFile(announcedFilePath, payload, "utf8");
  } catch (error) {
    console.error("Failed to persist announced caps", error);
  }
}

async function appendRawCaps(caps: CapSummary[]): Promise<void> {
  if (caps.length === 0) return;
  try {
    await fs.mkdir(dataDir, { recursive: true });
    let entries: RawCapLogEntry[] = [];
    try {
      const raw = await fs.readFile(rawLogFilePath, "utf8");
      const parsed = JSON.parse(raw) as { entries?: RawCapLogEntry[] };
      if (Array.isArray(parsed.entries)) {
        entries = parsed.entries;
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        console.error("Failed to read raw caps log", error);
      }
    }

    const receivedAt = Date.now();
    const newEntries = caps.map((cap) => ({
      receivedAt,
      cap: JSON.parse(JSON.stringify(cap)) as CapSummary,
    }));
    entries.push(...newEntries);

    const payload = JSON.stringify({ entries }, null, 2);
    await fs.writeFile(rawLogFilePath, payload, "utf8");
  } catch (error) {
    console.error("Failed to append raw caps", error);
  }
}

function normalizeIdentifier(value: unknown): string | number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length > 0) {
      return trimmed;
    }
  }
  return null;
}

function extractIdentifier(
  record: ApiRecord | null,
  keys: string[]
): string | number | null {
  if (!record) return null;

  const visited = new Set<object>();

  const visit = (candidate: any): string | number | null => {
    if (!candidate || typeof candidate !== "object") {
      return null;
    }
    if (visited.has(candidate)) {
      return null;
    }
    visited.add(candidate);

    for (const key of keys) {
      if (Object.prototype.hasOwnProperty.call(candidate, key)) {
        const value = normalizeIdentifier((candidate as any)[key]);
        if (value !== null) {
          return value;
        }
      }
    }

    for (const value of Object.values(candidate)) {
      const nested = visit(value);
      if (nested !== null) {
        return nested;
      }
    }

    return null;
  };

  const root = (record as any).data ?? record;
  const direct = visit(root);
  if (direct !== null) {
    return direct;
  }

  return visit(record);
}

function isSellTransactionPending(record: ApiRecord | null): boolean {
  if (!record) return false;
  const data = (record as any).data ?? record;
  if (!data || typeof data !== "object") return false;
  const sellTransaction =
    (data as any).SellTransaction ?? (data as any).sellTransaction ?? null;
  return sellTransaction === null || sellTransaction === undefined;
}

async function sendJson(
  method: "POST" | "PATCH",
  url: string,
  body: unknown
): Promise<ApiRecord> {
  const response = await fetch(url, {
    method,
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "x-api-key": pollApiKey,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `${method} ${url} failed with HTTP ${response.status}: ${text}`
    );
  }

  try {
    return (await response.json()) as ApiRecord;
  } catch (error) {
    throw new Error(`Failed to parse JSON response from ${url}`);
  }
}

async function postJson(url: string, body: unknown): Promise<ApiRecord> {
  return sendJson("POST", url, body);
}

async function patchJson(url: string, body: unknown): Promise<ApiRecord> {
  return sendJson("PATCH", url, body);
}

async function createBackendTransaction(
  payload: BackendTransactionPayload
): Promise<ApiRecord> {
  console.log(
    `Creating ${payload.txType} transaction record for hash ${payload.txHash}`
  );
  return postJson(`${backendBaseUrl}/capStr/transactions`, payload);
}

async function createTransactionRecord(cap: CapSummary): Promise<ApiRecord> {
  const payload = {
    txHash: cap.txHash,
    fromWalletAddress: cap.fromWalletAddress,
    toWalletAddress: cap.toWalletAddress,
    giftId: cap.giftId ?? 0,
    currency: "TON",
    amount:
      new BigNumber(cap.buyPriceTon).multipliedBy(10 ** 9).toString() ??
      new BigNumber(0).toString(),
    txType: "BUY",
    timeStamp: cap.buyTime,
  };

  return createBackendTransaction(payload);
}

async function createCapRecord(
  cap: CapSummary,
  state: CapState,
  buyTransactionId: string | number
): Promise<ApiRecord> {
  const payload = {
    giftId: cap.giftId,
    url: cap.getGemsUrl,
    boughtFor: new BigNumber(cap.buyPriceTon).multipliedBy(10 ** 9).toString(),
    listedFor: new BigNumber(cap.salePriceTon).multipliedBy(10 ** 9).toString(),
    capStrCapState: "LISTED",
    buyDate: cap.buyTime,
    sellDate: null,
    buyTransactionId,
  };

  console.log(
    `Creating cap record for cap ${cap.offchainGetgemsAddress} using transaction ${buyTransactionId}`
  );
  return postJson(`${backendBaseUrl}/capStr/caps`, payload);
}

async function patchCapSellTransaction(
  capStrCapId: string | number,
  sellTransactionId: string | number,
  sellDate: number
): Promise<ApiRecord> {
  const payload = {
    sellTransactionId,
    sellDate,
    capStrCapState: "SOLD",
  };
  console.log(
    `Updating CapStr cap ${capStrCapId} with sell transaction ${sellTransactionId} at ${sellDate}`
  );
  return patchJson(
    `${backendBaseUrl}/capStr/caps/${capStrCapId}`,
    payload
  );
}

interface TonTransactionDetails {
  fromWalletAddress: string;
  toWalletAddress: string;
  amountNano: string;
  timeStamp: number;
}

async function fetchTonTransactionDetails(
  txHash: string
): Promise<TonTransactionDetails> {
  const base = tonApiBaseUrl.replace(/\/$/, "");
  const url = `${base}/blockchain/transactions/${txHash}`;
  const headers: Record<string, string> = {
    accept: "application/json",
  };
  if (tonApiKey) {
    headers.Authorization = `Bearer ${tonApiKey}`;
  }

  const response = await fetch(url, { headers });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `Ton API request failed for ${txHash} with HTTP ${response.status}: ${text}`
    );
  }

  const payload = (await response.json()) as any;
  const transaction = payload.transaction ?? payload;
  const inMsg = transaction.in_msg ?? transaction.inMessage ?? null;
  const outMsgs = (transaction.out_msgs ??
    transaction.outMessages ??
    []) as any[];

  const fromAddress =
    inMsg?.source?.address ??
    inMsg?.source ??
    transaction.account?.address ??
    null;

  const toAddressCandidate =
    inMsg?.destination?.address ??
    inMsg?.destination ??
    outMsgs?.[0]?.destination?.address ??
    outMsgs?.[0]?.destination ??
    transaction.account?.address ??
    null;

  const resolvedFrom = fromAddress ?? toAddressCandidate;
  const resolvedTo = toAddressCandidate ?? fromAddress;

  if (!resolvedFrom || !resolvedTo) {
    throw new Error(`Ton transaction ${txHash} missing address details`);
  }

  const friendlyFrom = tonFriendlyAddress(resolvedFrom);
  const friendlyTo = tonFriendlyAddress(resolvedTo);

  const extractValue = (
    candidate: any,
    seen: Set<any> = new Set()
  ): string | null => {
    if (candidate === null || candidate === undefined) {
      return null;
    }
    if (typeof candidate === "string") {
      const trimmed = candidate.trim();
      return trimmed.length > 0 ? trimmed : null;
    }
    if (typeof candidate === "number" && Number.isFinite(candidate)) {
      return Math.trunc(candidate).toString();
    }
    if (typeof candidate !== "object") {
      return null;
    }
    if (seen.has(candidate)) {
      return null;
    }
    seen.add(candidate);

    const directCandidates = [
      candidate.value,
      candidate.Value,
      candidate.amount,
      candidate.Amount,
      candidate.coins,
      candidate.Coins,
    ];
    for (const val of directCandidates) {
      const extracted = extractValue(val, seen);
      if (extracted) {
        return extracted;
      }
    }

    for (const value of Object.values(candidate)) {
      const extracted = extractValue(value, seen);
      if (extracted) {
        return extracted;
      }
    }

    return null;
  };

  const normalizeAmount = (raw: string | null): string | null => {
    if (!raw) return null;
    try {
      const value = new BigNumber(raw);
      if (!value.isFinite() || value.lte(0)) {
        return null;
      }
      return value.integerValue(BigNumber.ROUND_FLOOR).toString(10);
    } catch (_error) {
      return null;
    }
  };

  const pickNonZeroAmount = (candidates: (string | null)[]): string | null => {
    for (const candidate of candidates) {
      const normalized = normalizeAmount(candidate);
      if (normalized) {
        return normalized;
      }
    }
    return null;
  };

  const amountFromIn = normalizeAmount(extractValue(inMsg));

  let amountNano = amountFromIn;

  const collectOutAmounts = (): string | null => {
    if (!Array.isArray(outMsgs)) {
      return null;
    }

    const prioritized: (string | null)[] = [];
    const fallback: (string | null)[] = [];

    for (const msg of outMsgs) {
      const destinationRaw =
        msg?.destination?.address ?? msg?.destination ?? null;
      const friendlyDestination = tonFriendlyAddress(destinationRaw);
      const sourceRaw = msg?.source?.address ?? msg?.source ?? null;
      const friendlySource = tonFriendlyAddress(sourceRaw);
      const valueCandidate = extractValue(msg);

      if (
        friendlyDestination === friendlyTo ||
        friendlySource === friendlyFrom
      ) {
        prioritized.push(valueCandidate);
      } else {
        fallback.push(valueCandidate);
      }
    }

    return pickNonZeroAmount([...prioritized, ...fallback]);
  };

  if (!amountNano) {
    amountNano = collectOutAmounts();
  }

  if (!amountNano) {
    amountNano = normalizeAmount(extractValue(transaction));
  }

  const timeStampRaw =
    typeof transaction.utime === "number"
      ? transaction.utime
      : typeof transaction.timestamp === "number"
      ? transaction.timestamp
      : null;

  return {
    fromWalletAddress: friendlyFrom,
    toWalletAddress: friendlyTo,
    amountNano: amountNano ?? "0",
    timeStamp: timeStampRaw !== null ? timeStampRaw * 1000 : Date.now(),
  };
}

function findCapByGiftNumber(giftNumber: number): StoredCap | undefined {
  const matches: StoredCap[] = [];
  for (const stored of announcedCaps.values()) {
    if (
      stored.item.giftId === giftNumber ||
      stored.item.capNumber === giftNumber
    ) {
      matches.push(stored);
    }
  }

  if (matches.length === 0) {
    return undefined;
  }

  const withCapRecord = matches.filter((stored) => stored.capStrRecord);
  const pendingSell = withCapRecord.find((stored) =>
    isSellTransactionPending(stored.capStrRecord)
  );
  if (pendingSell) {
    return pendingSell;
  }

  if (withCapRecord.length > 0) {
    return withCapRecord[0];
  }

  return matches[0];
}

async function pollOnce(): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(pollUrl, {
      method: "GET",
      headers: {
        accept: "application/json",
        "x-api-key": pollApiKey,
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`Poll failed with HTTP ${response.status}`);
    }

    const payload = (await response.json()) as PollResponse;
    if (!payload.success || !payload.data) {
      console.warn(
        "Poll succeeded but response flagged as unsuccessful",
        payload
      );
      return;
    }

    const { data } = payload;
    console.log(
      `Polled at ${new Date(data.polledAt).toISOString()}: totalCaps=${
        data.totalCaps
      }, hasNew=${data.hasNew}, newCaps=${data.newCaps.length}`
    );

    if (!data.hasNew || data.newCaps.length === 0) {
      return;
    }

    const freshCaps = data.newCaps.filter(
      (cap) => !announcedCaps.has(cap.offchainGetgemsAddress)
    );

    if (freshCaps.length === 0) return;

    await appendRawCaps(freshCaps);

    for (const cap of freshCaps) {
      const stored: StoredCap = {
        item: cap,
        state: "PUBLISHED",
        publishedChatIds: Array.from(subscribedChats),
        messageIds: {},
        isEdited: false,
        buyTransactionRecord: null,
        capStrRecord: null,
      };
      announcedCaps.set(cap.offchainGetgemsAddress, stored);
      const message = buildAlertMessage(cap, stored.state, stored.isEdited);
      await broadcastMessage(message, cap.offchainGetgemsAddress);
    }

    await persistAnnouncedAddresses();
  } catch (error) {
    if ((error as Error).name === "AbortError") {
      console.error("Poll request timed out");
      return;
    }

    console.error("Polling failed", error);
  } finally {
    clearTimeout(timeout);
  }
}

function saleTypeFormatter(saleType: string): string {
  switch (saleType.toLowerCase()) {
    case "auction":
      return "Auction";
    case "nftsalefixprice":
    case "fixpricesale":
      return "Sale";
    case "putupforsale":
      return "Listed";
    case "transfer":
      return "Transferred";
    default:
      return saleType;
  }
}

function knownAddressFormatter(address: string): string {
  if (
    address === "EQDp00TOpFDpJ0IvBgIn6rOUiCQeNZQSAPzI7kNPT65pjyr2" ||
    address === "UQDp00TOpFDpJ0IvBgIn6rOUiCQeNZQSAPzI7kNPT65pj3cz"
  ) {
    return "capstrategy.ton";
  }
  return address;
}

function buildAlertMessage(
  cap: CapSummary,
  state: CapState,
  isEdited: boolean = false
): string {
  const saleDate = new Date(cap.buyTime)
    .toISOString()
    .replace("T", " ")
    .replace(/\.\d{3}Z$/, " UTC");
  let heading = "<b>🚨 New Cap Detected</b>";
  const headerLines: string[] = [];
  if (state === "APPROVED") {
    heading = "<b>✅ Cap Published</b>";
    headerLines.push(
      '<b>Live at:</b> <a href="https://capstrategy.fun">capstrategy.fun</a>'
    );
  } else if (state === "REJECTED") {
    heading = "<b>⛔ Rejected Cap</b>";
  } else if (isEdited) {
    heading = "<b>✏️ Edited Cap</b>";
  }

  const lines: string[] = [heading, ...headerLines, ""];

  lines.push(
    `<b>Getgems Address:</b> <code>${cap.offchainGetgemsAddress}</code>`,
    `<b>Name:</b> ${cap.name ?? "N/A"}`,
    "",
    `<b>Record Type:</b> ${saleTypeFormatter(cap.saleType) ?? "N/A"}`,
    `<b>Buy Price:</b> ${cap.buyPriceTon ?? "N/A"} TON`,
    `<b>Sale Price:</b> ${cap.salePriceTon ?? "N/A"} TON`,
    "",
    `<b>Buy Time (UTC):</b> ${saleDate} (${cap.buyTime / 1000})`,
    `<b>GetGems URL:</b> <a href="${cap.getGemsUrl}">View on GetGems</a>`,
    `<b>Link to Gift:</b> ${
      cap.onchainAddress
        ? `<a href="https://tonviewer.com/${cap.onchainAddress}">View on Tonviewer</a>`
        : "Offchain Gift"
    }`,
    "",
    `<b>Tx Hash:</b> <code>${cap.txHash}</code>`,
    `<b>Seller Wallet:</b> <code>${knownAddressFormatter(
      cap.fromWalletAddress
    )}</code>`,
    `<b>Buyer Wallet:</b> <code>${knownAddressFormatter(
      cap.toWalletAddress
    )}</code>`
  );

  return lines.join("\n");
}

async function broadcastMessage(
  message: string,
  capAddress: string
): Promise<void> {
  if (subscribedChats.size === 0) {
    console.warn("No chat subscriptions available; message skipped");
    return;
  }

  console.log("Broadcasting alert to chats:", Array.from(subscribedChats));
  for (const chatId of subscribedChats) {
    try {
      const result = await bot.telegram.sendMessage(chatId, message, {
        parse_mode: "HTML",
        reply_markup: buildActionKeyboard(capAddress),
      });
      const stored = announcedCaps.get(capAddress);
      if (stored) {
        stored.messageIds[chatId] = result.message_id;
      }
      console.log(`Alert sent to chat ${chatId} for cap ${capAddress}`);
    } catch (error) {
      console.error(`Failed to deliver alert to chat ${chatId}`, error);
    }
  }
}

bot.on("callback_query", async (ctx) => {
  const data = (ctx.callbackQuery as any).data;
  if (data.startsWith("edit_") && !data.startsWith("edit_field_")) {
    const address = data.slice(5);
    const stored = announcedCaps.get(address);
    if (!stored) {
      await ctx.answerCbQuery("Cap not found");
      return;
    }
    const chatId = ctx.chat!.id;
    const originMessageId = ctx.callbackQuery.message?.message_id;
    if (originMessageId) {
      stored.messageIds[chatId] = originMessageId;
    }

    const infoMessage = await ctx.telegram.sendMessage(
      chatId,
      `<b>Editing:</b> ${stored.item.name ?? "N/A"}\n<code>${
        stored.item.offchainGetgemsAddress
      }</code>`,
      { parse_mode: "HTML" }
    );

    const selectionMessage = await ctx.telegram.sendMessage(
      chatId,
      "Select the field to edit:",
      {
        reply_markup: { inline_keyboard: buildFieldSelectionKeyboard() },
      }
    );

    fieldSelectState.set(chatId, {
      address,
      selectMessageId: selectionMessage.message_id,
      infoMessageId: infoMessage.message_id,
    });
    await ctx.answerCbQuery();
  } else if (data.startsWith("select_field_")) {
    const index = Number(data.slice(13));
    const chatId = ctx.chat!.id;
    const state = fieldSelectState.get(chatId);
    if (!state) {
      await ctx.answerCbQuery("Session expired");
      return;
    }
    const { address, selectMessageId, infoMessageId } = state;
    const field = editableFields[index];
    if (!field) {
      await ctx.answerCbQuery("Invalid field");
      return;
    }
    const promptMsg = await ctx.telegram.sendMessage(
      chatId,
      `Please enter the new value for ${field}:`
    );
    editState.set(ctx.from!.id, {
      capAddress: address,
      field,
      promptMessageId: promptMsg.message_id,
      chatId,
      selectMessageId,
      infoMessageId,
    });
    fieldSelectState.delete(chatId);
    await ctx.answerCbQuery();
  } else if (data.startsWith("approve_")) {
    const address = data.slice(8);
    try {
      await approveCap(address);
      await ctx.answerCbQuery("Approved");
    } catch (error) {
      console.error(`Approval flow failed for ${address}`, error);
      await ctx.answerCbQuery("Approval failed");
      await ctx.reply("Failed to approve cap. Check logs for details.");
    }
  } else if (data.startsWith("reject_")) {
    const address = data.slice(7);
    await rejectCap(address);
    await ctx.answerCbQuery("Rejected");
  }
});

bot.on("text", async (ctx, next) => {
  const userId = ctx.from!.id;
  const registerState = registerFlowState.get(userId);
  if (registerState) {
    await handleRegisterFlowMessage(ctx, registerState);
    return;
  }

  const state = editState.get(userId);
  if (state) {
    const {
      capAddress,
      field,
      promptMessageId,
      chatId,
      selectMessageId,
      infoMessageId,
    } = state;
    const newValue = ctx.message!.text!;
    const stored = announcedCaps.get(capAddress);
    if (stored) {
      const prop = fieldToProperty[field];
      if (prop === "buyTime") {
        const parsed = Number(newValue);
        if (!isNaN(parsed)) {
          stored.item.buyTime = parsed;
        }
      } else if (prop === "onchainAddress") {
        stored.item.onchainAddress = newValue || null;
      } else {
        (stored.item as any)[prop] = newValue;
      }
      stored.isEdited = true;
      await persistAnnouncedAddresses();
      const newMessage = buildAlertMessage(
        stored.item,
        stored.state,
        stored.isEdited
      );
      const replyMarkup =
        stored.state === "APPROVED" || stored.state === "REJECTED"
          ? { inline_keyboard: [] }
          : buildActionKeyboard(capAddress);
      for (const [chid, mid] of Object.entries(stored.messageIds)) {
        try {
          await ctx.telegram.editMessageText(
            Number(chid),
            Number(mid),
            undefined,
            newMessage,
            {
              parse_mode: "HTML",
              reply_markup: replyMarkup,
            }
          );
        } catch (error) {
          console.error(`Failed to edit message in chat ${chid}`, error);
        }
      }
      for (const messageId of [
        promptMessageId,
        selectMessageId,
        infoMessageId,
      ]) {
        try {
          await ctx.telegram.deleteMessage(chatId, messageId);
        } catch (error) {
          console.warn(`Failed to delete helper message ${messageId}`, error);
        }
      }
    }
    editState.delete(userId);
    return;
  }
  await next();
});

bot.command("subscribe", async (ctx) => {
  const chatId = ctx.chat?.id;
  if (!chatId || !allowedChatIds.has(chatId)) {
    await ctx.reply(
      `Chat not authorized to subscribe, please get this added by the bot admin: ${chatId}`
    );
    return;
  }
  if (subscribedChats.has(chatId)) {
    await ctx.reply("Already subscribed to cap alerts.");
    return;
  }
  subscribedChats.add(chatId);
  await ctx.reply("Subscription enabled. This chat will receive cap alerts.");
});

bot.command("unsubscribe", async (ctx) => {
  const chatId = ctx.chat?.id;
  if (!chatId || !allowedChatIds.has(chatId)) {
    await ctx.reply(
      `Chat not authorized to unsubscribe, please get this added by the bot admin: ${chatId}`
    );
    return;
  }
  if (!subscribedChats.has(chatId)) {
    await ctx.reply("This chat is not currently subscribed.");
    return;
  }
  subscribedChats.delete(chatId);
  await ctx.reply(
    "Subscription removed. This chat will stop receiving cap alerts."
  );
});

bot.command("pulldata", async (ctx) => {
  const chatId = ctx.chat?.id;
  if (!chatId || !allowedChatIds.has(chatId)) {
    await ctx.reply("Not authorized for manual polling.");
    return;
  }

  await ctx.reply("Manual poll triggered. Fetching latest caps...");
  try {
    await runPollCycle();
    await ctx.reply("Manual poll complete.");
  } catch (error) {
    console.error("Manual poll failed", error);
    await ctx.reply("Manual poll failed. Check logs for details.");
  }
});

bot.command("registersellbuyburn", async (ctx) => {
  const chatId = ctx.chat?.id;
  const userId = ctx.from?.id;
  if (!chatId || !allowedChatIds.has(chatId)) {
    await ctx.reply("Not authorized to register sell/buy/burn flows.");
    return;
  }
  if (!userId) {
    await ctx.reply("Unable to determine user initiating the request.");
    return;
  }

  if (registerFlowState.has(userId)) {
    await ctx.reply(
      "A sell/buy/burn registration is already in progress. Please send the JSON payload or cancel the flow before starting another."
    );
    return;
  }

  const instructions = [
    "Please reply with the registration payload as JSON (single message).",
    "Required fields:",
    "- capSellTxHash",
    "- capstrBuyTxHash",
    "- capstrBurnTxHash",
    "- capstrValue in TON",
    "- giftNumber",
    "Send the JSON exactly as in the example below.",
  ].join("\n");

  const promptMessage = await ctx.reply(instructions);

  const exampleJson = `{
  "capSellTxHash": "<TON hash>",
  "capstrBuyTxHash": "<CAPSTR buy hash>",
  "capstrBurnTxHash": "<CAPSTR burn hash>",
  "capstrValue": "1500",
  "giftNumber": 3387
}`;

  const exampleMessage = await ctx.reply(
    `\u0060\u0060\u0060json\n${exampleJson}\n\u0060\u0060\u0060`,
    {
      parse_mode: "MarkdownV2",
    }
  );

  registerFlowState.set(userId, {
    chatId,
    promptMessageId: promptMessage.message_id,
    helperMessageIds: [promptMessage.message_id, exampleMessage.message_id],
  });
});

async function editCap(address: string) {
  const stored = announcedCaps.get(address);
  if (stored) {
    stored.state = "REJECTED"; // or whatever for edit
    await persistAnnouncedAddresses();
  }
  // TODO: implement edit logic
}

async function handleRegisterFlowMessage(
  ctx: any,
  state: { chatId: number; promptMessageId: number; helperMessageIds: number[] }
): Promise<void> {
  const userId = ctx.from!.id;
  const rawText = ctx.message?.text?.trim();

  if (!rawText) {
    await ctx.reply("Please send the JSON payload as plain text.");
    return;
  }

  let parsed: any;
  try {
    parsed = JSON.parse(rawText);
  } catch (error) {
    await ctx.reply("Invalid JSON. Please check the payload and try again.");
    registerFlowState.delete(userId);
    return;
  }

  const capSellTxHash = String(parsed.capSellTxHash ?? "").trim();
  const capstrBuyTxHash = String(parsed.capstrBuyTxHash ?? "").trim();
  const capstrBurnTxHash = String(parsed.capstrBurnTxHash ?? "").trim();
  const capstrValueRaw = parsed.capstrValue;
  const giftNumberRaw = parsed.giftNumber;

  const missingFields: string[] = [];
  if (!capSellTxHash) missingFields.push("capSellTxHash");
  if (!capstrBuyTxHash) missingFields.push("capstrBuyTxHash");
  if (!capstrBurnTxHash) missingFields.push("capstrBurnTxHash");
  if (capstrValueRaw === undefined || capstrValueRaw === null)
    missingFields.push("capstrValue");
  if (giftNumberRaw === undefined || giftNumberRaw === null)
    missingFields.push("giftNumber");

  if (missingFields.length > 0) {
    await ctx.reply(
      `Missing required field(s): ${missingFields.join(
        ", "
      )}. Please resend the payload.`
    );
    registerFlowState.delete(userId);
    return;
  }

  const giftNumber = Number(giftNumberRaw);
  if (!Number.isFinite(giftNumber)) {
    await ctx.reply("giftNumber must be a valid number.");
    registerFlowState.delete(userId);
    return;
  }

  const targetCap = findCapByGiftNumber(giftNumber);
  if (!targetCap) {
    await ctx.reply(
      `Could not find an announced cap with gift number ${giftNumber}.`
    );
    registerFlowState.delete(userId);
    return;
  }

  if (!targetCap.capStrRecord) {
    await ctx.reply(
      "CapStr record not found for this cap. Approve the cap before registering sell/buy/burn transactions."
    );
    registerFlowState.delete(userId);
    return;
  }

  const giftId = targetCap.item.giftId ?? targetCap.item.capNumber;
  if (typeof giftId !== "number") {
    await ctx.reply(
      "Unable to resolve giftId for this cap. Ensure the cap has been announced with a gift identifier."
    );
    registerFlowState.delete(userId);
    return;
  }

  let capstrAmount: string;
  try {
    capstrAmount = new BigNumber(capstrValueRaw).multipliedBy(1e9).toString();
  } catch (error) {
    await ctx.reply("capstrValue must be numeric.");
    return;
  }

  try {
    const [capSellDetails, capstrBuyDetails, capstrBurnDetails] =
      await Promise.all([
        fetchTonTransactionDetails(capSellTxHash),
        fetchTonTransactionDetails(capstrBuyTxHash),
        fetchTonTransactionDetails(capstrBurnTxHash),
      ]);

    await createBackendTransaction({
      txHash: capSellTxHash,
      fromWalletAddress: capSellDetails.fromWalletAddress,
      toWalletAddress: capSellDetails.toWalletAddress,
      giftId,
      currency: "TON",
      amount: capSellDetails.amountNano,
      txType: "SELL",
      timeStamp: capSellDetails.timeStamp,
    });

    await createBackendTransaction({
      txHash: capstrBuyTxHash,
      fromWalletAddress: capstrBuyDetails.fromWalletAddress,
      toWalletAddress: capstrBuyDetails.toWalletAddress,
      giftId,
      currency: "CAPSTR",
      amount: capstrAmount,
      txType: "BUY",
      timeStamp: capstrBuyDetails.timeStamp,
    });

    const capstrBurnRecord = await createBackendTransaction({
      txHash: capstrBurnTxHash,
      fromWalletAddress: capstrBurnDetails.fromWalletAddress,
      toWalletAddress: capstrBurnDetails.toWalletAddress,
      giftId,
      currency: "CAPSTR",
      amount: capstrAmount,
      txType: "BURN",
      timeStamp: capstrBurnDetails.timeStamp,
    });

    const sellTransactionId = extractIdentifier(capstrBurnRecord, [
      "TxID",
      "txId",
      "transactionId",
      "id",
    ]);

    if (sellTransactionId === null) {
      throw new Error(
        "Unable to determine sell transaction identifier from burn transaction response"
      );
    }

    const capStrCapId = extractIdentifier(targetCap.capStrRecord, [
      "CapStrCapID",
      "capStrCapId",
      "id",
    ]);

    if (capStrCapId === null) {
      throw new Error(
        "Unable to determine CapStrCapID for this cap; cannot patch sell transaction."
      );
    }

    const normalizedSellTransactionId =
      typeof sellTransactionId === "string"
        ? Number(sellTransactionId)
        : sellTransactionId;
    if (!Number.isFinite(normalizedSellTransactionId)) {
      throw new Error("Sell transaction identifier is not a valid number");
    }

    const normalizedCapStrCapId =
      typeof capStrCapId === "string" ? Number(capStrCapId) : capStrCapId;
    if (!Number.isFinite(normalizedCapStrCapId)) {
      throw new Error("CapStrCapID is not a valid number");
    }

    const updatedCapRecord = await patchCapSellTransaction(
      normalizedCapStrCapId,
      normalizedSellTransactionId,
      capSellDetails.timeStamp
    );

    targetCap.capStrRecord = updatedCapRecord;
    await persistAnnouncedAddresses();

    registerFlowState.delete(userId);

    for (const messageId of state.helperMessageIds) {
      try {
        await ctx.telegram.deleteMessage(state.chatId, messageId);
      } catch (error) {
        console.warn(
          `Failed to delete register flow helper message ${messageId}`,
          error
        );
      }
    }

    await ctx.reply(
      [
        "Sell/buy/burn registration complete:",
        `- TON sell transaction: <a href="https://tonviewer.com/${capSellTxHash}">${capSellTxHash}</a>`,
        `- CAPSTR buy transaction: <a href="https://tonviewer.com/${capstrBuyTxHash}">${capstrBuyTxHash}</a>`,
        `- CAPSTR burn transaction: <a href="https://tonviewer.com/${capstrBurnTxHash}">${capstrBurnTxHash}</a>`,
        `- CapStr cap updated: ${normalizedCapStrCapId}`,
        `- Sell transaction linked: ${normalizedSellTransactionId}`,
      ].join("\n"),
      { parse_mode: "HTML" }
    );
  } catch (error) {
    console.error("Sell/buy/burn registration failed", error);
    await ctx.reply(
      `Failed to register sell/buy/burn flow: ${(error as Error).message}`
    );
    registerFlowState.delete(userId);
  }
}

async function approveCap(address: string) {
  const stored = announcedCaps.get(address);
  if (!stored) {
    throw new Error(`Cap ${address} not found for approval`);
  }

  const cap = stored.item;

  if (!stored.buyTransactionRecord) {
    stored.buyTransactionRecord = await createTransactionRecord(cap);
    await persistAnnouncedAddresses();
  }

  const buyTransactionId = (stored.buyTransactionRecord as any).data
    ?.TxID as number;

  if (buyTransactionId === null) {
    console.error(
      "Transaction response missing identifier:",
      JSON.stringify(stored.buyTransactionRecord)
    );
    throw new Error(
      `Transaction record for ${cap.offchainGetgemsAddress} missing identifier`
    );
  }

  if (!stored.capStrRecord) {
    stored.capStrRecord = await createCapRecord(
      cap,
      "APPROVED",
      buyTransactionId
    );
    await persistAnnouncedAddresses();
  }

  stored.state = "APPROVED";
  await persistAnnouncedAddresses();
  const message = buildAlertMessage(stored.item, stored.state, stored.isEdited);
  for (const [chatId, messageId] of Object.entries(stored.messageIds)) {
    try {
      await bot.telegram.editMessageText(
        Number(chatId),
        Number(messageId),
        undefined,
        message,
        {
          parse_mode: "HTML",
          reply_markup: { inline_keyboard: [] },
        }
      );
    } catch (error) {
      console.error(
        `Failed to update approved message in chat ${chatId}`,
        error
      );
    }
  }
}

async function rejectCap(address: string) {
  const stored = announcedCaps.get(address);
  if (stored) {
    stored.state = "REJECTED";
    await persistAnnouncedAddresses();
    const message = buildAlertMessage(
      stored.item,
      stored.state,
      stored.isEdited
    );
    for (const [chatId, messageId] of Object.entries(stored.messageIds)) {
      try {
        await bot.telegram.editMessageText(
          Number(chatId),
          Number(messageId),
          undefined,
          message,
          {
            parse_mode: "HTML",
            reply_markup: { inline_keyboard: [] },
          }
        );
      } catch (error) {
        console.error(
          `Failed to update rejected message in chat ${chatId}`,
          error
        );
      }
    }
  }
  // TODO: implement reject logic
}

let pollTimer: NodeJS.Timeout | null = null;
let currentPollPromise: Promise<void> | null = null;

function runPollCycle(): Promise<void> {
  if (!currentPollPromise) {
    currentPollPromise = (async () => {
      try {
        await pollOnce();
      } finally {
        currentPollPromise = null;
      }
    })();
  }

  return currentPollPromise;
}

function startPolling(): void {
  console.log("Initial poll cycle starting...");
  runPollCycle().catch((error) => {
    console.error("Initial poll failed", error);
  });

  pollTimer = setInterval(() => {
    runPollCycle().catch((error) => {
      console.error("Scheduled poll failed", error);
    });
  }, pollIntervalMs);
}

function stopPolling(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

(async () => {
  await loadAnnouncedAddresses();
  console.log("Starting admin bot...");
  console.log(`Polling ${pollUrl} every ${pollIntervalMs}ms`);

  bot.launch();
  await bot.telegram.setMyCommands([
    { command: "pulldata", description: "Trigger manual poll of new caps" },
    { command: "subscribe", description: "Subscribe this chat to cap alerts" },
    {
      command: "unsubscribe",
      description: "Unsubscribe this chat from cap alerts",
    },
    {
      command: "registersellbuyburn",
      description: "Register sell/buy/burn transactions for a cap",
    },
  ]);

  startPolling();

  const me = await bot.telegram.getMe();
  console.log(`Bot username: @${me.username}`);
  console.log(
    subscribedChats.size > 0
      ? `Broadcasting to ${subscribedChats.size} preset chat(s)`
      : "No preset chat subscriptions found"
  );
  console.log("Bot setup complete. Polling started.");
})().catch((error) => {
  console.error("Failed to start admin bot", error);
  process.exit(1);
});

process.once("SIGINT", () => {
  console.log("\nSIGINT received. Stopping bot...");
  stopPolling();
  bot.stop("SIGINT");
  process.exit(0);
});

process.once("SIGTERM", () => {
  console.log("\nSIGTERM received. Stopping bot...");
  stopPolling();
  bot.stop("SIGTERM");
  process.exit(0);
});
