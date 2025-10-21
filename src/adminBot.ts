import { promises as fs } from "fs";
import path from "path";
import dotenv from "dotenv";
import { Telegraf } from "telegraf";

dotenv.config();

type ChatId = number;

interface CapSummary {
  readonly address: string;
  readonly name: string;
  readonly capNumber: number;
  readonly collectionAddress: string;
  readonly image: string;
  readonly saleType: string;
  readonly salePriceTon: string;
  readonly detectedAt: number;
  readonly saleTime: number;
  readonly getGemsUrl: string;
  readonly txHash: string;
  readonly fromWalletAddress: string;
  readonly toWalletAddress: string;
}

interface PollResponse {
  readonly success: boolean;
  readonly message: string;
  readonly data?: {
    readonly ownerAddress: string;
    readonly totalCaps: number;
    readonly hasNew: boolean;
    readonly newCaps: CapSummary[];
    readonly seenCaps?: string[];
    readonly polledAt: number;
  };
}

const botToken =
  process.env.ADMIN_TG_BOT_TOKEN ?? process.env.TGMARKETPLACE_TEST_BOT_TOKEN;
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

const pollIntervalMs = (() => {
  const fallback = 6000;
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

const subscribedChats = new Set<ChatId>();
const announcedCapAddresses = new Set<string>();

const dataDir =
  process.env.ADMIN_DATA_DIR ?? path.resolve(process.cwd(), "data");
const subscriptionsFilePath = path.join(dataDir, "subscriptions.json");

const staticChatIds = (process.env.ADMIN_POLL_CHAT_IDS ?? "")
  .split(",")
  .map((part) => part.trim())
  .filter((part) => part.length > 0)
  .map((part) => Number(part))
  .filter((id) => Number.isInteger(id));
staticChatIds.forEach((id) => subscribedChats.add(id));

async function loadStoredChatIds(): Promise<void> {
  try {
    const raw = await fs.readFile(subscriptionsFilePath, "utf8");
    const parsed = JSON.parse(raw) as { chatIds?: unknown };
    if (Array.isArray(parsed.chatIds)) {
      parsed.chatIds
        .map((value) => Number(value))
        .filter((value) => Number.isInteger(value))
        .forEach((id) => subscribedChats.add(id));
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return;
    console.error("Failed to load stored chat IDs", error);
  }
}

async function persistSubscriptions(): Promise<void> {
  try {
    await fs.mkdir(dataDir, { recursive: true });
    const payload = JSON.stringify(
      { chatIds: Array.from(subscribedChats) },
      null,
      2
    );
    await fs.writeFile(subscriptionsFilePath, payload, "utf8");
  } catch (error) {
    console.error("Failed to persist chat IDs", error);
  }
}

function addChatId(id: ChatId): boolean {
  if (subscribedChats.has(id)) return false;
  subscribedChats.add(id);
  return true;
}

function removeChatId(id: ChatId): boolean {
  return subscribedChats.delete(id);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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
      }, newCaps=${data.newCaps.length}`
    );

    data.seenCaps?.forEach((address) => announcedCapAddresses.add(address));

    if (!data.hasNew || data.newCaps.length === 0) {
      return;
    }

    const freshCaps = data.newCaps.filter(
      (cap) => !announcedCapAddresses.has(cap.address)
    );

    if (freshCaps.length === 0) return;

    const message = buildAlertMessage(data.ownerAddress, freshCaps);
    await broadcastMessage(message);

    freshCaps.forEach((cap) => announcedCapAddresses.add(cap.address));
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

function buildAlertMessage(ownerAddress: string, caps: CapSummary[]): string {
  const header =
    caps.length === 1
      ? "Cap alert: 1 new cap detected"
      : `Cap alert: ${caps.length} new caps detected`;

  const lines = caps.map((cap, index) => {
    const saleDate = new Date(cap.saleTime).toISOString();
    return [
      `${index + 1}. ${cap.name} (#${cap.capNumber})`,
      `   Sale type: ${cap.saleType}`,
      `   Price: ${cap.salePriceTon} TON`,
      `   Sale time: ${saleDate}`,
      `   Link: ${cap.getGemsUrl}`,
    ].join("\n");
  });

  return [
    header,
    `Owner: ${ownerAddress}`,
    "",
    ...lines,
    "",
    "Reply with /unsubscribe to stop these alerts.",
  ].join("\n");
}

async function broadcastMessage(message: string): Promise<void> {
  if (subscribedChats.size === 0) {
    console.warn("No chat subscriptions available; message skipped");
    return;
  }

  await Promise.all(
    Array.from(subscribedChats).map(async (chatId) => {
      try {
        await bot.telegram.sendMessage(chatId, message);
      } catch (error) {
        console.error(`Failed to deliver alert to chat ${chatId}`, error);
      }
    })
  );
}

bot.start(async (ctx) => {
  const changed = addChatId(ctx.chat.id);
  if (changed) {
    await persistSubscriptions();
  }
  await ctx.reply(
    "Subscribed to cap alerts. Use /unsubscribe to stop notifications."
  );
});

bot.command("subscribe", async (ctx) => {
  const changed = addChatId(ctx.chat.id);
  if (changed) {
    await persistSubscriptions();
  }
  await ctx.reply("Subscription confirmed. You'll receive cap alerts here.");
});

bot.command("unsubscribe", async (ctx) => {
  const removed = removeChatId(ctx.chat.id);
  if (removed) {
    await persistSubscriptions();
  }
  await ctx.reply("Unsubscribed. Send /subscribe anytime to re-enable alerts.");
});

bot.on("my_chat_member", async (ctx) => {
  // Automatically subscribe when the bot is added to a group.
  const status = ctx.myChatMember?.new_chat_member?.status;
  if (status === "member" || status === "administrator") {
    const changed = addChatId(ctx.chat.id);
    if (changed) {
      await persistSubscriptions();
    }
    console.log(`Auto-subscribed chat ${ctx.chat.id} after join event`);
  }

  if (status === "left" || status === "kicked") {
    const removed = removeChatId(ctx.chat.id);
    if (removed) {
      await persistSubscriptions();
    }
    console.log(`Removed chat ${ctx.chat.id} after leave event`);
  }
});

let running = true;

async function pollingLoop(): Promise<void> {
  while (running) {
    await pollOnce();
    await sleep(pollIntervalMs);
  }
}

(async () => {
  await loadStoredChatIds();
  console.log("Starting admin bot...");
  console.log(`Polling ${pollUrl} every ${pollIntervalMs}ms`);

  await bot.launch();
  pollingLoop().catch((error) => {
    console.error("Polling loop terminated unexpectedly", error);
  });

  const me = await bot.telegram.getMe();
  console.log(`Bot username: @${me.username}`);
  console.log(
    subscribedChats.size > 0
      ? `Broadcasting to ${subscribedChats.size} preset chat(s)`
      : "No preset chat subscriptions found"
  );
})().catch((error) => {
  console.error("Failed to start admin bot", error);
  process.exit(1);
});

process.once("SIGINT", () => {
  console.log("\nSIGINT received. Stopping bot...");
  running = false;
  bot.stop("SIGINT");
  process.exit(0);
});

process.once("SIGTERM", () => {
  console.log("\nSIGTERM received. Stopping bot...");
  running = false;
  bot.stop("SIGTERM");
  process.exit(0);
});
