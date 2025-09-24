import dotenv from "dotenv";
import { Telegraf, Markup } from "telegraf";

dotenv.config();

/* ─────────────────────────────────────────────────────────────
   1) Env
   ───────────────────────────────────────────────────────────── */
const token = process.env.BOT_TOKEN;
if (!token) throw new Error("🛑 BOT_TOKEN not set in .env");

const webAppUrl = process.env.WEB_APP_URL;
if (!webAppUrl) throw new Error("🛑 WEB_APP_URL not set in .env");

/* ─────────────────────────────────────────────────────────────
   2) Bot
   ───────────────────────────────────────────────────────────── */
const bot = new Telegraf(token);

/* ─────────────────────────────────────────────────────────────
   3) /start — inline “Open Mini App” + set the chat’s Menu Button
   ───────────────────────────────────────────────────────────── */
bot.start(async (ctx) => {
  // Inline button — this is what produces the “Open” pill in many clients
  await ctx.reply("🚀 Start the flywheel", {
    reply_markup: {
      inline_keyboard: [
        [{ text: "Open Mini App", web_app: { url: webAppUrl } }],
      ],
    },
  });

  // Set this chat’s bottom menu button to open your Mini App
  try {
    await ctx.telegram.setChatMenuButton({
      chatId: ctx.chat.id,
      menuButton: {
        type: "web_app",
        text: "OPEN",
        web_app: { url: webAppUrl },
      },
    });
  } catch (e) {
    console.error("setChatMenuButton (per-chat) failed:", e);
  }

  // Offer quick-action keyboard too (optional)
  // await ctx.reply(
  //   "Quick actions enabled. Use /keyboard again to re-show, /hidekeyboard to hide.",
  //   {
  //     reply_markup: {
  //       keyboard: [
  //         [
  //           {
  //             text: "💰 View Balance",
  //             web_app: { url: `${webAppUrl}/balance` },
  //           },
  //         ],
  //       ],
  //       is_persistent: true,
  //       resize_keyboard: true,
  //       one_time_keyboard: false,
  //     },
  //   }
  // );
});

/* ─────────────────────────────────────────────────────────────
   4) /notify — send a message that renders a big “Open” pill
   ───────────────────────────────────────────────────────────── */
// bot.command("notify", async (ctx) => {
//   await ctx.reply("🎉 Your TON withdrawal was successful.", {
//     reply_markup: {
//       inline_keyboard: [[{ text: "Open", web_app: { url: webAppUrl } }]],
//     },
//   });
// });

/* ─────────────────────────────────────────────────────────────
   5) /keyboard and /hidekeyboard — persistent quick-action bar
   ───────────────────────────────────────────────────────────── */
// bot.command("keyboard", async (ctx) => {
//   await ctx.reply("Quick actions:", {
//     reply_markup: {
//       keyboard: [
//         [{ text: "💰 View Balance", web_app: { url: `${webAppUrl}/balance` } }],
//       ],
//       is_persistent: true,
//       resize_keyboard: true,
//       one_time_keyboard: false,
//     },
//   });
// });

bot.command("hidekeyboard", async (ctx) => {
  await ctx.reply("Hiding quick actions.", {
    reply_markup: { remove_keyboard: true },
  });
});

bot.command("open", async (ctx) => {
  // (optional) hide any reply keyboard so the UI is clean
  await ctx.reply("…", { reply_markup: { remove_keyboard: true } });

  await ctx.reply(
    "Tap to open.",
    Markup.inlineKeyboard([Markup.button.webApp("Open", webAppUrl)])
  );
});

/* ─────────────────────────────────────────────────────────────
   6) Receive data back from Web App MainButton
   ───────────────────────────────────────────────────────────── */
bot.on("web_app_data", async (ctx) => {
  const raw = (ctx as any).webAppData?.data ?? ctx.message?.web_app_data?.data;
  if (!raw) return ctx.reply("❌ No data received from Web App");

  let payload: unknown;
  try {
    payload = JSON.parse(raw as string);
  } catch {
    return ctx.reply("❌ Failed to parse payload");
  }

  await ctx.reply(
    `✅ Got data back:\n\`\`\`json\n${JSON.stringify(
      payload,
      null,
      2
    )}\n\`\`\``,
    { parse_mode: "Markdown" }
  );
});

/* ─────────────────────────────────────────────────────────────
   7) Launch + set a BOT-WIDE default Menu Button to the Web App
      (Applies where you haven’t overridden per-chat.)
   ───────────────────────────────────────────────────────────── */
(async () => {
  console.log("🚀 Starting bot...");
  console.log(`🌐 Web App URL: ${webAppUrl}`);

  await bot.launch();

  try {
    await bot.telegram.setChatMenuButton({
      menuButton: {
        type: "web_app",
        text: "OPEN",
        web_app: { url: webAppUrl },
      },
    });
    console.log("✅ Default menu button set to Web App");
  } catch (e) {
    console.error("setChatMenuButton (default) failed:", e);
  }

  const me = await bot.telegram.getMe();
  console.log(`🤖 Bot is up: @${me.username}`);
  console.log("💬 Commands: /start /notify /keyboard /hidekeyboard");
})().catch((err) => {
  console.error("❌ Bot failed to launch:", err);
  process.exit(1);
});

/* ─────────────────────────────────────────────────────────────
   8) Graceful shutdown
   ───────────────────────────────────────────────────────────── */
process.once("SIGINT", () => {
  console.log("\n📴 SIGINT, shutting down...");
  bot.stop("SIGINT");
  process.exit(0);
});
process.once("SIGTERM", () => {
  console.log("\n📴 SIGTERM, shutting down...");
  bot.stop("SIGTERM");
  process.exit(0);
});
