import { Telegraf } from "telegraf";

interface SubscriptionFlowDeps {
  bot: Telegraf;
  allowedChatIds: Set<number>;
  subscribedChats: Set<number>;
}

export function setupSubscriptionFlow({
  bot,
  allowedChatIds,
  subscribedChats,
}: SubscriptionFlowDeps) {
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
}
