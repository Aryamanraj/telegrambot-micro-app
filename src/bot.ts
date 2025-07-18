import dotenv from "dotenv";
import { Telegraf } from "telegraf";
dotenv.config();

//
// 1. Grab config from .env
//
const token = process.env.BOT_TOKEN;
if (!token) throw new Error("🛑 BOT_TOKEN not set in .env");

const webAppUrl = process.env.WEB_APP_URL;
if (!webAppUrl) throw new Error("🛑 WEB_APP_URL not set in .env");

//
// 2. Instantiate bot
//
const bot = new Telegraf(token);

//
// 3. /start — send a button that opens your React mini‑app
//
bot.start(async (ctx) => {
  await ctx.reply("🚀 Ready to launch Mini App!", {
    reply_markup: {
      inline_keyboard: [
        [
          {
            text: "Open Mini App",
            web_app: { url: webAppUrl },
          },
        ],
      ],
    },
  });
});

//
// 4. Handle data sent back from your Web App's MainButton
//
bot.on("web_app_data", async (ctx) => {
  // ctx.webAppData is Telegraf's shorthand for update.message.web_app_data
  const raw = ctx.webAppData?.data;
  if (!raw) return ctx.reply("❌ No data received from Web App");

  let payload: unknown;
  try {
    payload = JSON.parse(raw as any);
  } catch {
    return ctx.reply("❌ Failed to parse payload");
  }

  await ctx.reply(
    `✅ Got data back:\n\`\`\`json\n${JSON.stringify(payload, null, 2)}\n\`\`\``
  );
});

//
// 5. Launch and graceful shutdown
//
console.log("🚀 Starting bot...");
console.log(`🔑 Token: ${token.substring(0, 10)}...`);
console.log(`🌐 Web App URL: ${webAppUrl}`);

bot.launch().then(() => {
  // This happens immediately when the bot starts listening
  console.log("🤖 Bot is up and running!");
  console.log(`🔗 Bot username: @${bot.botInfo?.username || 'unknown'}`);
  console.log("💬 Send /start to test the bot");
}).catch((err) => {
  console.error("❌ Bot failed to launch:", err);
  process.exit(1);
});

// Graceful shutdown handlers
process.once("SIGINT", () => {
  console.log("\n📴 Received SIGINT, shutting down gracefully...");
  bot.stop("SIGINT");
  console.log("✅ Bot stopped successfully");
  process.exit(0);
});

process.once("SIGTERM", () => {
  console.log("\n📴 Received SIGTERM, shutting down gracefully...");
  bot.stop("SIGTERM");
  console.log("✅ Bot stopped successfully");
  process.exit(0);
});
