import BigNumber from "bignumber.js";
import { Telegraf } from "telegraf";

import {
  findCapByGiftNumber,
  findPepeGiftByGiftNumber,
  persistAnnouncedAddresses,
} from "../storage";
import {
  createBackendTransaction,
  createPepeTransaction,
  patchCapSellTransaction,
} from "../backendClient";
import { fetchTonTransactionDetails } from "../tonClient";
import { extractIdentifier } from "../utils/records";
import { TonTransactionDetails } from "../types";

interface RegisterFlowDeps {
  bot: Telegraf;
  allowedChatIds: Set<number>;
}

type RegisterTarget = "CAPSTRATEGY" | "PEPESTRATEGY";

type RegisterFlowState =
  | {
      stage: "awaitingTarget";
      chatId: number;
      helperMessageIds: number[];
    }
  | {
      stage: "awaitingCapJson";
      chatId: number;
      helperMessageIds: number[];
    }
  | {
      stage: "awaitingPepeJson";
      chatId: number;
      helperMessageIds: number[];
    };

const REGISTER_TARGETS: { id: RegisterTarget; label: string }[] = [
  { id: "CAPSTRATEGY", label: "CapStrategy" },
  { id: "PEPESTRATEGY", label: "PepeStrategy" },
];

function buildRegisterTargetKeyboard() {
  return {
    inline_keyboard: REGISTER_TARGETS.map((target) => [
      {
        text: target.label,
        callback_data: `register_target_${target.id}`,
      },
    ]),
  };
}

function findRegisterTargetById(id: string) {
  return REGISTER_TARGETS.find((target) => target.id === id);
}

async function cleanupHelperMessages(
  bot: Telegraf,
  chatId: number,
  messageIds: number[]
) {
  for (const messageId of messageIds) {
    try {
      await bot.telegram.deleteMessage(chatId, messageId);
    } catch (error) {
      console.warn(
        `Failed to delete register flow helper message ${messageId}`,
        error
      );
    }
  }
}

export function setupRegisterSellBuyBurnFlow({
  bot,
  allowedChatIds,
}: RegisterFlowDeps) {
  const registerFlowState = new Map<number, RegisterFlowState>();

  async function handleCapRegisterMessage(
    ctx: any,
    state: Extract<RegisterFlowState, { stage: "awaitingCapJson" }>
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
      await cleanupHelperMessages(bot, state.chatId, state.helperMessageIds);
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
        `Missing required field(s): ${missingFields.join(", ")}.
Please resend the payload.`
      );
      registerFlowState.delete(userId);
      await cleanupHelperMessages(bot, state.chatId, state.helperMessageIds);
      return;
    }

    const giftNumber = Number(giftNumberRaw);
    if (!Number.isFinite(giftNumber)) {
      await ctx.reply("giftNumber must be a valid number.");
      registerFlowState.delete(userId);
      await cleanupHelperMessages(bot, state.chatId, state.helperMessageIds);
      return;
    }

    const targetCap = findCapByGiftNumber(giftNumber);
    if (!targetCap) {
      await ctx.reply(
        `Could not find an announced cap with gift number ${giftNumber}.`
      );
      registerFlowState.delete(userId);
      await cleanupHelperMessages(bot, state.chatId, state.helperMessageIds);
      return;
    }

    if (!targetCap.capStrRecord) {
      await ctx.reply(
        "CapStr record not found for this cap. Approve the cap before registering sell/buy/burn transactions."
      );
      registerFlowState.delete(userId);
      await cleanupHelperMessages(bot, state.chatId, state.helperMessageIds);
      return;
    }

    const giftId = targetCap.item.giftId ?? targetCap.item.capNumber;
    if (typeof giftId !== "number") {
      await ctx.reply(
        "Unable to resolve giftId for this cap. Ensure the cap has been announced with a gift identifier."
      );
      registerFlowState.delete(userId);
      await cleanupHelperMessages(bot, state.chatId, state.helperMessageIds);
      return;
    }

    let capstrAmount: string;
    try {
      capstrAmount = new BigNumber(capstrValueRaw).multipliedBy(1e9).toString();
    } catch (error) {
      await ctx.reply("capstrValue must be numeric.");
      registerFlowState.delete(userId);
      await cleanupHelperMessages(bot, state.chatId, state.helperMessageIds);
      return;
    }

    try {
      const [capSellDetails, capstrBuyDetails, capstrBurnDetails]: [
        TonTransactionDetails,
        TonTransactionDetails,
        TonTransactionDetails
      ] = await Promise.all([
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

      await cleanupHelperMessages(bot, state.chatId, state.helperMessageIds);

      await ctx.reply(
        [
          "Sell/buy/burn registration complete:",
          `- TON sell transaction: <a href="https://tonviewer.com/transaction/${capSellTxHash}">${capSellTxHash}</a>`,
          `- CAPSTR buy transaction: <a href="https://tonviewer.com/transaction/${capstrBuyTxHash}">${capstrBuyTxHash}</a>`,
          `- CAPSTR burn transaction: <a href="https://tonviewer.com/transaction/${capstrBurnTxHash}">${capstrBurnTxHash}</a>`,
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
      await cleanupHelperMessages(bot, state.chatId, state.helperMessageIds);
    }
  }

  async function handlePepeRegisterMessage(
    ctx: any,
    state: Extract<RegisterFlowState, { stage: "awaitingPepeJson" }>
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
      await cleanupHelperMessages(bot, state.chatId, state.helperMessageIds);
      return;
    }

    const pepeSellTxHash = String(
      parsed.pepeSellTxHash ??
        parsed.pepeSellTxhash ??
        parsed.pepeselltxhash ??
        parsed.sellTxHash ??
        ""
    ).trim();
    const pepestrBuyTxHash = String(
      parsed.pepestrBuyTxHash ??
        parsed.pepeStrBuyTxHash ??
        parsed.pepeBuyTxHash ??
        parsed.buyTxHash ??
        ""
    ).trim();
    const pepestrBurnTxHash = String(
      parsed.pepestrBurnTxHash ??
        parsed.pepeStrBurnTxHash ??
        parsed.pepeBurnTxHash ??
        parsed.burnTxHash ??
        ""
    ).trim();
    const pepestrValueRaw =
      parsed.pepestrValue ??
      parsed.pepeStrValue ??
      parsed.value ??
      parsed.amount;
    const giftNumberRaw =
      parsed.giftNumber ??
      parsed.giftNo ??
      parsed.gift_num ??
      parsed.gift;

    const missingFields: string[] = [];
    if (!pepeSellTxHash) missingFields.push("pepeSellTxHash");
    if (!pepestrBuyTxHash) missingFields.push("pepestrBuyTxHash");
    if (!pepestrBurnTxHash) missingFields.push("pepestrBurnTxHash");
    if (pepestrValueRaw === undefined || pepestrValueRaw === null) {
      missingFields.push("pepestrValue");
    }
    if (giftNumberRaw === undefined || giftNumberRaw === null) {
      missingFields.push("giftNumber");
    }

    if (missingFields.length > 0) {
      await ctx.reply(
        `Missing required field(s): ${missingFields.join(", ")}.
Please resend the payload.`
      );
      registerFlowState.delete(userId);
      await cleanupHelperMessages(bot, state.chatId, state.helperMessageIds);
      return;
    }

    const giftNumber = Number(giftNumberRaw);
    if (!Number.isFinite(giftNumber)) {
      await ctx.reply("giftNumber must be a valid number.");
      registerFlowState.delete(userId);
      await cleanupHelperMessages(bot, state.chatId, state.helperMessageIds);
      return;
    }

    const targetGift = findPepeGiftByGiftNumber(giftNumber);
    if (!targetGift) {
      await ctx.reply(
        `Could not find an announced Pepe gift with gift number ${giftNumber}.`
      );
      registerFlowState.delete(userId);
      await cleanupHelperMessages(bot, state.chatId, state.helperMessageIds);
      return;
    }

    const giftId = targetGift.item.giftId ?? targetGift.item.giftNumber;
    if (typeof giftId !== "number" || !Number.isFinite(giftId)) {
      await ctx.reply(
        "Unable to resolve giftId for this Pepe gift. Ensure it has an announced gift identifier."
      );
      registerFlowState.delete(userId);
      await cleanupHelperMessages(bot, state.chatId, state.helperMessageIds);
      return;
    }

    let pepestrAmount: string;
    try {
      pepestrAmount = new BigNumber(pepestrValueRaw).multipliedBy(1e9).toString();
    } catch (error) {
      await ctx.reply("pepestrValue must be numeric.");
      registerFlowState.delete(userId);
      await cleanupHelperMessages(bot, state.chatId, state.helperMessageIds);
      return;
    }

    try {
      const [
        pepeSellDetails,
        pepestrBuyDetails,
        pepestrBurnDetails,
      ]: [
        TonTransactionDetails,
        TonTransactionDetails,
        TonTransactionDetails
      ] = await Promise.all([
        fetchTonTransactionDetails(pepeSellTxHash),
        fetchTonTransactionDetails(pepestrBuyTxHash),
        fetchTonTransactionDetails(pepestrBurnTxHash),
      ]);

      const sellRecord = await createPepeTransaction({
        txHash: pepeSellTxHash,
        fromWalletAddress: pepeSellDetails.fromWalletAddress,
        toWalletAddress: pepeSellDetails.toWalletAddress,
        giftId,
        currency: "TON",
        amount: pepeSellDetails.amountNano,
        txType: "SELL",
        timeStamp: pepeSellDetails.timeStamp,
      });

      await createPepeTransaction({
        txHash: pepestrBuyTxHash,
        fromWalletAddress: pepestrBuyDetails.fromWalletAddress,
        toWalletAddress: pepestrBuyDetails.toWalletAddress,
        giftId,
        currency: "PEPESTR",
        amount: pepestrAmount,
        txType: "BUY",
        timeStamp: pepestrBuyDetails.timeStamp,
      });

      await createPepeTransaction({
        txHash: pepestrBurnTxHash,
        fromWalletAddress: pepestrBurnDetails.fromWalletAddress,
        toWalletAddress: pepestrBurnDetails.toWalletAddress,
        giftId,
        currency: "PEPESTR",
        amount: pepestrAmount,
        txType: "BURN",
        timeStamp: pepestrBurnDetails.timeStamp,
      });

      registerFlowState.delete(userId);
      await cleanupHelperMessages(bot, state.chatId, state.helperMessageIds);

      const sellTransactionId = extractIdentifier(sellRecord, [
        "TxID",
        "txId",
        "transactionId",
        "id",
      ]);

      const messageParts = [
        "PepeStr sell/buy/burn registration complete:",
  `- TON sell transaction: <a href="https://tonviewer.com/transaction/${pepeSellTxHash}">${pepeSellTxHash}</a>`,
  `- PEPESTR buy transaction: <a href="https://tonviewer.com/transaction/${pepestrBuyTxHash}">${pepestrBuyTxHash}</a>`,
  `- PEPESTR burn transaction: <a href="https://tonviewer.com/transaction/${pepestrBurnTxHash}">${pepestrBurnTxHash}</a>`,
        `- Gift ID: ${giftId}`,
        `- Gift number: ${giftNumber}`,
        `- PEPESTR amount (nano): ${pepestrAmount}`,
      ];

      if (sellTransactionId !== null) {
        messageParts.push(`- Sell transaction ID: ${sellTransactionId}`);
      }

      await ctx.reply(messageParts.join("\n"), { parse_mode: "HTML" });
    } catch (error) {
      console.error("Pepe transaction registration failed", error);
      registerFlowState.delete(userId);
      await cleanupHelperMessages(bot, state.chatId, state.helperMessageIds);
      await ctx.reply(
        `Failed to register Pepe sell/buy/burn transactions: ${(error as Error).message}`
      );
    }
  }

  bot.on("text", async (ctx, next) => {
    const userId = ctx.from?.id;
    if (!userId) {
      await next();
      return;
    }

    const state = registerFlowState.get(userId);
    if (!state) {
      await next();
      return;
    }

    if (state.stage === "awaitingTarget") {
      await ctx.reply(
        "Please choose CapStrategy or PepeStrategy using the buttons above."
      );
      return;
    }

    if (state.stage === "awaitingCapJson") {
      await handleCapRegisterMessage(ctx, state);
      return;
    }

    if (state.stage === "awaitingPepeJson") {
      await handlePepeRegisterMessage(ctx, state);
      return;
    }

    await next();
  });

  bot.on("callback_query", async (ctx, next) => {
    const data = (ctx.callbackQuery as any)?.data;
    if (typeof data !== "string" || !data.startsWith("register_target_")) {
      await next();
      return;
    }

    const targetIdRaw = data.replace("register_target_", "");
    const target = findRegisterTargetById(targetIdRaw);
    if (!target) {
      await ctx.answerCbQuery("Unknown selection", { show_alert: true });
      return;
    }

    const userId = ctx.from?.id;
    if (!userId) {
      await ctx.answerCbQuery();
      return;
    }

    const state = registerFlowState.get(userId);
    if (!state || state.stage !== "awaitingTarget") {
      await ctx.answerCbQuery("Session expired. Use /registersellbuyburn again.", {
        show_alert: true,
      });
      return;
    }

    const helperIds = new Set(state.helperMessageIds);
    const selectionMessageId = ctx.callbackQuery.message?.message_id;
    if (selectionMessageId) {
      helperIds.add(selectionMessageId);
    }

    if (target.id === "CAPSTRATEGY") {
      const instructions = [
        "Please reply with the CapStrategy registration payload as JSON (single message).",
        "Required fields:",
        "- capSellTxHash",
        "- capstrBuyTxHash",
        "- capstrBurnTxHash",
        "- capstrValue in TON",
        "- giftNumber",
        "Send the JSON exactly as in the example below.",
      ].join("\n");

      const promptMessage = await ctx.reply(instructions);
      helperIds.add(promptMessage.message_id);

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
      helperIds.add(exampleMessage.message_id);

      registerFlowState.set(userId, {
        stage: "awaitingCapJson",
        chatId: state.chatId,
        helperMessageIds: Array.from(helperIds),
      });

      await ctx.answerCbQuery("CapStrategy selected");
      return;
    }

    if (target.id === "PEPESTRATEGY") {
      const instructions = [
        "Please reply with the PepeStrategy registration payload as JSON (single message).",
        "Required fields:",
        "- pepeSellTxHash",
        "- pepestrBuyTxHash",
        "- pepestrBurnTxHash",
        "- pepestrValue in TON",
        "- giftNumber",
        "Send the JSON exactly as in the example below.",
      ].join("\n");

      const promptMessage = await ctx.reply(instructions);
      helperIds.add(promptMessage.message_id);

      const exampleJson = `{
  "pepeSellTxHash": "<TON hash>",
  "pepestrBuyTxHash": "<PEPESTR buy hash>",
  "pepestrBurnTxHash": "<PEPESTR burn hash>",
  "pepestrValue": "1500",
  "giftNumber": 1950
}`;

      const exampleMessage = await ctx.reply(
        `\u0060\u0060\u0060json\n${exampleJson}\n\u0060\u0060\u0060`,
        {
          parse_mode: "MarkdownV2",
        }
      );
      helperIds.add(exampleMessage.message_id);

      registerFlowState.set(userId, {
        stage: "awaitingPepeJson",
        chatId: state.chatId,
        helperMessageIds: Array.from(helperIds),
      });

      await ctx.answerCbQuery("PepeStrategy selected");
      return;
    }

    await ctx.answerCbQuery();
  });

  bot.command("registersellbuyburn", async (ctx) => {
    const chatId = ctx.chat?.id;
    const userId = ctx.from?.id;
    if (!chatId || !allowedChatIds.has(chatId)) {
      await ctx.reply("Not authorized to register transactions.");
      return;
    }
    if (!userId) {
      await ctx.reply("Unable to determine user initiating the request.");
      return;
    }

    if (registerFlowState.has(userId)) {
      await ctx.reply(
        "A transaction registration is already in progress. Please complete or cancel it before starting another."
      );
      return;
    }

    const selectionMessage = await ctx.reply(
      "Select which strategy you want to register a transaction for:",
      {
        reply_markup: buildRegisterTargetKeyboard(),
      }
    );

    registerFlowState.set(userId, {
      stage: "awaitingTarget",
      chatId,
      helperMessageIds: [selectionMessage.message_id],
    });
  });
}
