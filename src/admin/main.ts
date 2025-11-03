import { Telegraf } from "telegraf";

import {
  backendBaseUrl,
  botToken,
  pollApiKey,
  pollIntervalMs,
  pollUrl,
  pepePollUrl,
  staticChatIds,
} from "./config";
import { loadAnnouncedAddresses } from "./storage";
import { setupRegisterSellBuyBurnFlow } from "./flows/registerSellBuyBurn";
import { setupGreenTextFlow } from "./flows/greenText";
import { setupSubscriptionFlow } from "./flows/subscription";
import { setupCapManagement } from "./flows/capManagement";
import { setupPepeManagement } from "./flows/pepeManagement";
import { setupRegisterMultipleBuysFlow } from "./flows/registerMultipleBuys";
import { setupRegisterMultipleSellsFlow } from "./flows/registerMultipleSells";
import { setupRegisterMultipleBurnsFlow } from "./flows/registerMultipleBurns";

const bot = new Telegraf(botToken);

const allowedChatIds = new Set(staticChatIds);
const subscribedChats = new Set(staticChatIds);

setupRegisterSellBuyBurnFlow({ bot, allowedChatIds });
setupGreenTextFlow({
  bot,
  allowedChatIds,
  pollApiKey,
  backendBaseUrl,
});
setupRegisterMultipleBuysFlow({ bot, allowedChatIds });
setupRegisterMultipleSellsFlow({ bot, allowedChatIds });
setupRegisterMultipleBurnsFlow({ bot, allowedChatIds });
setupSubscriptionFlow({ bot, allowedChatIds, subscribedChats });
const {
  startPolling: startCapPolling,
  stopPolling: stopCapPolling,
  triggerManualPoll: triggerManualCapPoll,
} = setupCapManagement({
  bot,
  pollUrl,
  pollApiKey,
  pollIntervalMs,
  subscribedChats,
});
const {
  startPolling: startPepePolling,
  stopPolling: stopPepePolling,
  triggerManualPoll: triggerManualPepePoll,
} = setupPepeManagement({
  bot,
  pepePollUrl,
  pollApiKey,
  pollIntervalMs,
  subscribedChats,
});

bot.command("pulldata", async (ctx) => {
  const chatId = ctx.chat?.id;
  if (!chatId || !allowedChatIds.has(chatId)) {
    await ctx.reply("Not authorized for manual polling.");
    return;
  }

  await ctx.reply("Which strategy should be polled?", {
    reply_markup: {
      inline_keyboard: [
        [
          { text: "CapStrategy", callback_data: "manual_poll_CAPSTRATEGY" },
          { text: "PepeStrategy", callback_data: "manual_poll_PEPESTRATEGY" },
        ],
      ],
    },
  });
});

bot.action("manual_poll_CAPSTRATEGY", async (ctx) => {
  const chatId = ctx.chat?.id ?? ctx.callbackQuery?.message?.chat?.id;
  if (!chatId || !allowedChatIds.has(chatId)) {
    await ctx.answerCbQuery("Not authorized", { show_alert: true });
    return;
  }

  await ctx.answerCbQuery("Polling CapStrategy...");
  await ctx.reply("Manual CapStrategy poll triggered. Fetching latest caps...");
  try {
    await triggerManualCapPoll();
    await ctx.reply("CapStrategy manual poll complete.");
  } catch (error) {
    console.error("Manual CapStrategy poll failed", error);
    await ctx.reply("Manual CapStrategy poll failed. Check logs for details.");
  }
});

bot.action("manual_poll_PEPESTRATEGY", async (ctx) => {
  const chatId = ctx.chat?.id ?? ctx.callbackQuery?.message?.chat?.id;
  if (!chatId || !allowedChatIds.has(chatId)) {
    await ctx.answerCbQuery("Not authorized", { show_alert: true });
    return;
  }

  await ctx.answerCbQuery("Polling PepeStrategy...");
  await ctx.reply("Manual PepeStrategy poll triggered. Fetching latest gifts...");
  try {
    await triggerManualPepePoll();
    await ctx.reply("PepeStrategy manual poll complete.");
  } catch (error) {
    console.error("Manual PepeStrategy poll failed", error);
    await ctx.reply(
      "Manual PepeStrategy poll failed. Check logs for details."
    );
  }
});

(async () => {
  await loadAnnouncedAddresses();
  console.log("Starting admin bot...");
  console.log(`Polling ${pollUrl} every ${pollIntervalMs}ms`);
  console.log(`Polling ${pepePollUrl} every ${pollIntervalMs}ms for Pepe gifts`);

  bot.launch();
  await bot.telegram.setMyCommands([
    {
      command: "pulldata",
      description: "Trigger manual poll of new CapStrategy or PepeStrategy items",
    },
    { command: "subscribe", description: "Subscribe this chat to cap alerts" },
    {
      command: "unsubscribe",
      description: "Unsubscribe this chat from cap alerts",
    },
    {
      command: "registersellbuyburn",
      description: "Register transactions for CapStrategy or PepeStrategy",
    },
    {
      command: "registerbuys",
      description: "Register multiple buy transactions for CapStrategy or PepeStrategy",
    },
    {
      command: "registersells",
      description: "Register multiple sell transactions for CapStrategy or PepeStrategy",
    },
    {
      command: "registerburns",
      description: "Register multiple burn transactions for CapStrategy or PepeStrategy",
    },
    {
      command: "updategreentext",
      description: "Update CAPSTRATEGY_FUN or PEPESTRATEGY_FUN green text",
    },
    {
      command: "removegreentext",
      description: "Disable green text for CapStrategy or PepeStrategy",
    },
    {
      command: "getgreentext",
      description: "Display green text for CapStrategy or PepeStrategy",
    },
  ]);

  startCapPolling();
  startPepePolling();

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
  stopCapPolling();
  stopPepePolling();
  bot.stop("SIGINT");
  process.exit(0);
});

process.once("SIGTERM", () => {
  console.log("\nSIGTERM received. Stopping bot...");
  stopCapPolling();
  stopPepePolling();
  bot.stop("SIGTERM");
  process.exit(0);
});
