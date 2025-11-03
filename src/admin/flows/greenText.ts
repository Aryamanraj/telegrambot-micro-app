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

function buildTargetSelectionKeyboard(prefix = "greentext_target_") {
  return {
    inline_keyboard: GREEN_TEXT_TARGETS.map((target) => [
      {
        text: target.label,
        callback_data: `${prefix}${target.id}`,
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

async function disableGreenText(
  backendBaseUrl: string,
  pollApiKey: string,
  targetId: GreenTextTargetId
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
      body: JSON.stringify({ IsOnline: false }),
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
  const removeGreenTextFlowState = new Map<
    number,
    { chatId: number; helperMessageIds: number[] }
  >();
  const getGreenTextFlowState = new Map<
    number,
    { chatId: number; helperMessageIds: number[] }
  >();

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

  bot.command("removegreentext", async (ctx) => {
    const chatId = ctx.chat?.id;
    const userId = ctx.from?.id;
    if (!chatId || !allowedChatIds.has(chatId)) {
      await ctx.reply("Not authorized to remove green text.");
      return;
    }
    if (!userId) {
      await ctx.reply("Unable to determine user initiating the request.");
      return;
    }

    if (
      removeGreenTextFlowState.has(userId) ||
      updateGreenTextFlowState.has(userId) ||
      getGreenTextFlowState.has(userId)
    ) {
      await ctx.reply(
        "A green text action is already in progress. Please complete it before starting another."
      );
      return;
    }

    const selectionMessage = await ctx.reply(
      "Which green text should be disabled?",
      {
        reply_markup: buildTargetSelectionKeyboard("greentext_remove_"),
      }
    );

    removeGreenTextFlowState.set(userId, {
      chatId,
      helperMessageIds: [selectionMessage.message_id],
    });
  });

  bot.command("getgreentext", async (ctx) => {
    const chatId = ctx.chat?.id;
    const userId = ctx.from?.id;
    if (!chatId || !allowedChatIds.has(chatId)) {
      await ctx.reply("Not authorized to get green text.");
      return;
    }
    if (!userId) {
      await ctx.reply("Unable to determine user initiating the request.");
      return;
    }

    if (
      getGreenTextFlowState.has(userId) ||
      updateGreenTextFlowState.has(userId) ||
      removeGreenTextFlowState.has(userId)
    ) {
      await ctx.reply(
        "A green text action is already in progress. Please complete it before starting another."
      );
      return;
    }

    const selectionMessage = await ctx.reply(
      "Which green text should be fetched?",
      {
        reply_markup: buildTargetSelectionKeyboard("greentext_get_"),
      }
    );

    getGreenTextFlowState.set(userId, {
      chatId,
      helperMessageIds: [selectionMessage.message_id],
    });
  });

  bot.action(/^greentext_remove_(.+)$/, async (ctx) => {
    const match = ctx.match as RegExpExecArray | undefined;
    const targetId = match?.[1];
    const target = targetId ? findTargetById(targetId) : undefined;
    if (!target) {
      await ctx.answerCbQuery("Unknown selection", { show_alert: true });
      return;
    }

    const userId = ctx.from?.id;
    if (!userId) {
      await ctx.answerCbQuery();
      return;
    }

    const state = removeGreenTextFlowState.get(userId);
    if (!state) {
      await ctx.answerCbQuery("Session expired. Use /removegreentext again.", {
        show_alert: true,
      });
      return;
    }

    const helperIds = new Set(state.helperMessageIds);
    const selectionMessageId = ctx.callbackQuery.message?.message_id;
    if (selectionMessageId) {
      helperIds.add(selectionMessageId);
    }

    let cleaned = false;
    await ctx.answerCbQuery(`Removing ${target.label}...`);
    try {
      await disableGreenText(backendBaseUrl, pollApiKey, target.id);
      await cleanupHelperMessages(state.chatId, Array.from(helperIds));
      cleaned = true;
      await ctx.reply(`${target.label} green text removed successfully.`);
    } catch (error) {
      console.error(`Failed to remove green text for ${target.label}`, error);
      if (!cleaned) {
        await cleanupHelperMessages(state.chatId, Array.from(helperIds));
        cleaned = true;
      }
      await ctx.reply(
        `Failed to remove ${target.label} green text. Check logs for details.`
      );
    } finally {
      removeGreenTextFlowState.delete(userId);
    }
  });

  bot.action(/^greentext_get_(.+)$/, async (ctx) => {
    const match = ctx.match as RegExpExecArray | undefined;
    const targetId = match?.[1];
    const target = targetId ? findTargetById(targetId) : undefined;
    if (!target) {
      await ctx.answerCbQuery("Unknown selection", { show_alert: true });
      return;
    }

    const userId = ctx.from?.id;
    if (!userId) {
      await ctx.answerCbQuery();
      return;
    }

    const state = getGreenTextFlowState.get(userId);
    if (!state) {
      await ctx.answerCbQuery("Session expired. Use /getgreentext again.", {
        show_alert: true,
      });
      return;
    }

    const helperIds = new Set(state.helperMessageIds);
    const selectionMessageId = ctx.callbackQuery.message?.message_id;
    if (selectionMessageId) {
      helperIds.add(selectionMessageId);
    }

    let cleaned = false;
    await ctx.answerCbQuery(`Fetching ${target.label}...`);
    try {
      const snapshot = await fetchGreenTextSnapshot(
        backendBaseUrl,
        pollApiKey,
        target.id
      );

      await cleanupHelperMessages(state.chatId, Array.from(helperIds));
      cleaned = true;

      const messageLines = [
        `Current ${target.label} green text:`,
        snapshot.text ?? "<no text set>",
        `Online: ${snapshot.isOnline}`,
      ];

      await ctx.reply(messageLines.join("\n"));
    } catch (error) {
      console.error(`Failed to fetch green text for ${target.label}`, error);
      if (!cleaned) {
        await cleanupHelperMessages(state.chatId, Array.from(helperIds));
        cleaned = true;
      }
      await ctx.reply(
        `Error fetching ${target.label} green text. Check logs for details.`
      );
    } finally {
      getGreenTextFlowState.delete(userId);
    }
  });
}
