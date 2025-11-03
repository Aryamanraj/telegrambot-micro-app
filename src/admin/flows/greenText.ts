import { Telegraf } from "telegraf";

interface GreenTextFlowDeps {
  bot: Telegraf;
  allowedChatIds: Set<number>;
  pollApiKey: string;
  backendBaseUrl: string;
}

const GREEN_TEXT_TARGETS = [
  { id: "CAPSTRATEGY_FUN" as const, label: "capstrategy.fun" },
  { id: "PEPESTRATEGY_FUN" as const, label: "pepestrategy.fun" },
];

type GreenTextTargetId = (typeof GREEN_TEXT_TARGETS)[number]["id"];

type UpdateGreenTextState =
  | {
      stage: "awaitingTarget";
      chatId: number;
      helperMessageIds: number[];
    }
  | {
      stage: "awaitingText";
      chatId: number;
      targetId: GreenTextTargetId;
      helperMessageIds: number[];
    };

function buildTargetSelectionKeyboard() {
  return {
    inline_keyboard: GREEN_TEXT_TARGETS.map((target) => [
      {
        text: target.label,
        callback_data: `greentext_target_${target.id}`,
      },
    ]),
  };
}

function findTargetById(id: string) {
  return GREEN_TEXT_TARGETS.find((target) => target.id === id);
}

async function fetchGreenTextSnapshot(
  backendBaseUrl: string,
  pollApiKey: string,
  targetId: GreenTextTargetId
): Promise<{ text: string | null; isOnline: boolean | null }> {
  const response = await fetch(
    `${backendBaseUrl}/greentext/fetch/${targetId}`,
    {
      headers: {
        accept: "application/json",
        "x-api-key": pollApiKey,
      },
    }
  );

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  const payload = await response.json();
  if (!payload.success || !payload.data) {
    throw new Error("Backend did not return green text data");
  }

  return {
    text: payload.data.Text ?? null,
    isOnline: payload.data.IsOnline ?? null,
  };
}

async function updateGreenTextValue(
  backendBaseUrl: string,
  pollApiKey: string,
  targetId: GreenTextTargetId,
  text: string
): Promise<void> {
  const response = await fetch(
    `${backendBaseUrl}/greentext/update/${targetId}`,
    {
      method: "PATCH",
      headers: {
        accept: "application/json",
        "x-api-key": pollApiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ Text: text, IsOnline: true }),
    }
  );

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`HTTP ${response.status}: ${body}`);
  }
}

export function setupGreenTextFlow({
  bot,
  allowedChatIds,
  pollApiKey,
  backendBaseUrl,
}: GreenTextFlowDeps) {
  const updateGreenTextFlowState = new Map<number, UpdateGreenTextState>();

  async function cleanupHelperMessages(
    chatId: number,
    messageIds: number[]
  ) {
    for (const messageId of messageIds) {
      try {
        await bot.telegram.deleteMessage(chatId, messageId);
      } catch (error) {
        console.warn(
          `Failed to delete green text helper message ${messageId}`,
          error
        );
      }
    }
  }

  bot.on("text", async (ctx, next) => {
    const userId = ctx.from?.id;
    if (!userId) {
      await next();
      return;
    }

    const state = updateGreenTextFlowState.get(userId);
    if (!state) {
      await next();
      return;
    }

    if (state.stage === "awaitingTarget") {
      await ctx.reply(
        "Please choose which green text to update using the buttons above."
      );
      return;
    }

    const incomingText = ctx.message?.text ?? "";
    if (incomingText.trim().length === 0) {
      await ctx.reply("Green text cannot be empty. Please send a value.");
      return;
    }

    updateGreenTextFlowState.delete(userId);
    const { chatId, targetId, helperMessageIds } = state;
    const target = findTargetById(targetId);

    try {
      await updateGreenTextValue(
        backendBaseUrl,
        pollApiKey,
        targetId,
        incomingText
      );
      await cleanupHelperMessages(chatId, helperMessageIds);

      let confirmation = `Green text for ${target?.label ?? targetId} updated.`;
      try {
        const snapshot = await fetchGreenTextSnapshot(
          backendBaseUrl,
          pollApiKey,
          targetId
        );
        if (snapshot.text) {
          confirmation = [
            confirmation,
            "",
            "Updated text:",
            snapshot.text,
          ].join("\n");
        }
      } catch (confirmError) {
        console.warn("Failed to refetch updated green text", confirmError);
      }

      await ctx.reply(confirmation);
    } catch (error) {
      console.error("Failed to update green text", error);
      await cleanupHelperMessages(chatId, helperMessageIds);
      await ctx.reply(
        `Failed to update green text for ${target?.label ?? targetId}. Try again later.`
      );
    }
  });

  bot.on("callback_query", async (ctx, next) => {
    const data = (ctx.callbackQuery as any)?.data;
    if (typeof data !== "string" || !data.startsWith("greentext_target_")) {
      await next();
      return;
    }

    const targetId = data.replace("greentext_target_", "");
    const target = findTargetById(targetId);
    if (!target) {
      await ctx.answerCbQuery("Unknown selection", { show_alert: true });
      return;
    }

    const userId = ctx.from?.id;
    if (!userId) {
      await ctx.answerCbQuery();
      return;
    }

    const state = updateGreenTextFlowState.get(userId);
    if (!state || state.stage !== "awaitingTarget") {
      await ctx.answerCbQuery("Session expired. Use /updategreentext again.", {
        show_alert: true,
      });
      return;
    }

    const helperIds = new Set(state.helperMessageIds);
    const selectionMessageId = ctx.callbackQuery.message?.message_id;
    if (selectionMessageId) {
      helperIds.add(selectionMessageId);
    }

    try {
      const snapshot = await fetchGreenTextSnapshot(
        backendBaseUrl,
        pollApiKey,
        target.id
      );

      const instructionMessage = await ctx.telegram.sendMessage(
        state.chatId,
        [
          `Updating green text for ${target.label}.`,
          `Current status: ${
            snapshot.isOnline === null
              ? "unknown"
              : snapshot.isOnline
              ? "online"
              : "offline"
          }.`,
          "",
          "Reply with the new green text. We'll clean up these helper messages once the update is done.",
        ].join("\n")
      );
      helperIds.add(instructionMessage.message_id);

      if (snapshot.text) {
        const currentMessage = await ctx.telegram.sendMessage(
          state.chatId,
          [
            `Current ${target.label} green text:`,
            snapshot.text,
          ].join("\n")
        );
        helperIds.add(currentMessage.message_id);
      }

      updateGreenTextFlowState.set(userId, {
        stage: "awaitingText",
        chatId: state.chatId,
        targetId: target.id,
        helperMessageIds: Array.from(helperIds),
      });

      await ctx.answerCbQuery(`Selected ${target.label}`);
    } catch (error) {
      console.error("Failed to prepare green text update flow", error);
      updateGreenTextFlowState.delete(userId);
      await ctx.answerCbQuery("Failed to fetch current text", {
        show_alert: true,
      });
      await cleanupHelperMessages(state.chatId, Array.from(helperIds));
      await ctx.reply(
        `Could not fetch current green text for ${target.label}. Please try again later.`
      );
    }
  });

  bot.command(["updategreentext", "updatecapstrategygreentext"], async (ctx) => {
    const chatId = ctx.chat?.id;
    const userId = ctx.from?.id;
    if (!chatId || !allowedChatIds.has(chatId)) {
      await ctx.reply("Not authorized to update green text.");
      return;
    }
    if (!userId) {
      await ctx.reply("Unable to determine user initiating the request.");
      return;
    }

    if (updateGreenTextFlowState.has(userId)) {
      await ctx.reply(
        "A green text update is already in progress. Please complete or cancel it before starting another."
      );
      return;
    }

    const selectionMessage = await ctx.reply(
      "Select which green text to update:",
      {
        reply_markup: buildTargetSelectionKeyboard(),
      }
    );

    updateGreenTextFlowState.set(userId, {
      stage: "awaitingTarget",
      chatId,
      helperMessageIds: [selectionMessage.message_id],
    });
  });

  bot.command("removecapstrategygreentext", async (ctx) => {
    const chatId = ctx.chat?.id;
    if (!chatId || !allowedChatIds.has(chatId)) {
      await ctx.reply("Not authorized to remove green text.");
      return;
    }

    await ctx.reply("Removing green text...");
    try {
      const response = await fetch(
        `${backendBaseUrl}/greentext/update/CAPSTRATEGY_FUN`,
        {
          method: "PATCH",
          headers: {
            accept: "application/json",
            "x-api-key": pollApiKey,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ IsOnline: false }),
        }
      );

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      await ctx.reply("Green text removed successfully.");
    } catch (error) {
      console.error("Failed to remove green text", error);
      await ctx.reply("Failed to remove green text. Check logs for details.");
    }
  });

  bot.command("getcapstrategygreentext", async (ctx) => {
    const chatId = ctx.chat?.id;
    if (!chatId || !allowedChatIds.has(chatId)) {
      await ctx.reply("Not authorized to get green text.");
      return;
    }

    try {
      const response = await fetch(
        `${backendBaseUrl}/greentext/fetch/CAPSTRATEGY_FUN`,
        {
          headers: {
            accept: "application/json",
            "x-api-key": pollApiKey,
          },
        }
      );

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const data = await response.json();
      if (data.success && data.data) {
        await ctx.reply(
          `Current green text: ${data.data.Text}\nOnline: ${data.data.IsOnline}`
        );
      } else {
        await ctx.reply("Failed to retrieve green text data.");
      }
    } catch (error) {
      console.error("Failed to fetch green text", error);
      await ctx.reply("Error fetching green text. Check logs for details.");
    }
  });
}
