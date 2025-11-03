import BigNumber from "bignumber.js";
import { Telegraf } from "telegraf";

import {
  findCapByGiftNumber,
  findPepeGiftByGiftNumber,
} from "../storage";
import {
  createBackendTransaction,
  createPepeTransaction,
} from "../backendClient";
import { fetchTonTransactionDetails } from "../tonClient";
import { extractIdentifier } from "../utils/records";
import { TonTransactionDetails } from "../types";

type MultiSellTarget = "CAPSTRATEGY" | "PEPESTRATEGY";

interface MultiSellTargetConfig {
  id: MultiSellTarget;
  label: string;
}

const MULTI_SELL_TARGETS: MultiSellTargetConfig[] = [
  { id: "CAPSTRATEGY", label: "CapStrategy" },
  { id: "PEPESTRATEGY", label: "PepeStrategy" },
];

function buildTargetKeyboard() {
  return {
    inline_keyboard: MULTI_SELL_TARGETS.map((target) => [
      {
        text: target.label,
        callback_data: `multi_sell_target_${target.id}`,
      },
    ]),
  };
}

function findTargetById(id: string) {
  return MULTI_SELL_TARGETS.find((target) => target.id === id);
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
        `Failed to delete multi-sell helper message ${messageId}`,
        error
      );
    }
  }
}

function formatTonAmount(amountNano: string): string {
  try {
    const tons = new BigNumber(amountNano ?? "0").dividedBy(1e9);
    if (!tons.isFinite()) {
      return "0";
    }
    if (tons.isZero()) {
      return "0";
    }
    const precise = tons.toFixed(9);
    return precise.replace(/\.0+$/, "").replace(/(\.[0-9]*?)0+$/, "$1");
  } catch (_error) {
    return "0";
  }
}

interface RegisterMultiSellsDeps {
  bot: Telegraf;
  allowedChatIds: Set<number>;
}

type MultiSellFlowState =
  | {
      stage: "awaitingTarget";
      chatId: number;
      helperMessageIds: number[];
    }
  | {
      stage: "awaitingPayload";
      chatId: number;
      helperMessageIds: number[];
      target: MultiSellTargetConfig;
    };

function normalizeHashes(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const unique = new Set<string>();
  for (const entry of value) {
    if (entry === null || entry === undefined) continue;
    const normalized = String(entry).trim();
    if (normalized.length === 0) continue;
    unique.add(normalized);
  }
  return Array.from(unique);
}

async function registerCapSells(
  hashes: string[],
  giftNumber: number
): Promise<string> {
  const storedCap = findCapByGiftNumber(giftNumber);
  if (!storedCap) {
    throw new Error(
      `Could not find an announced cap with gift number ${giftNumber}.`
    );
  }

  const giftId = storedCap.item.giftId ?? storedCap.item.capNumber;
  if (typeof giftId !== "number" || !Number.isFinite(giftId)) {
    throw new Error(
      "Unable to resolve giftId for this cap. Ensure it has an announced gift identifier."
    );
  }

  const entries: string[] = [];
  let totalNano = new BigNumber(0);

  for (const hash of hashes) {
    const details: TonTransactionDetails = await fetchTonTransactionDetails(
      hash
    );
    const amountNano = details.amountNano ?? "0";
    const amountBn = new BigNumber(amountNano);
    if (!amountBn.isFinite() || amountBn.lte(0)) {
      throw new Error(
        `Transaction ${hash} does not contain a positive TON amount.`
      );
    }

    await createBackendTransaction({
      txHash: hash,
      fromWalletAddress: details.fromWalletAddress,
      toWalletAddress: details.toWalletAddress,
      giftId,
      currency: "TON",
      amount: amountNano,
      txType: "SELL",
      timeStamp: details.timeStamp,
    });

    totalNano = totalNano.plus(amountNano);
    const formattedAmount = formatTonAmount(amountNano);
    entries.push(
      `- <a href="https://tonviewer.com/transaction/${hash}">${hash}</a> • ${formattedAmount} TON`
    );
  }

  const totalFormatted = formatTonAmount(totalNano.toString(10));
  return [
    "CapStrategy sell transactions registered:",
    ...entries,
    `Total TON sold: ${totalFormatted}`,
  ].join("\n");
}

async function registerPepeSells(
  hashes: string[],
  giftNumber: number
): Promise<string> {
  const storedGift = findPepeGiftByGiftNumber(giftNumber);
  if (!storedGift) {
    throw new Error(
      `Could not find an announced Pepe gift with gift number ${giftNumber}.`
    );
  }

  const giftId = storedGift.item.giftId ?? storedGift.item.giftNumber;
  if (typeof giftId !== "number" || !Number.isFinite(giftId)) {
    throw new Error(
      "Unable to resolve giftId for this Pepe gift. Ensure it has an announced gift identifier."
    );
  }

  const entries: string[] = [];
  let totalNano = new BigNumber(0);

  for (const hash of hashes) {
    const details: TonTransactionDetails = await fetchTonTransactionDetails(
      hash
    );
    const amountNano = details.amountNano ?? "0";
    const amountBn = new BigNumber(amountNano);
    if (!amountBn.isFinite() || amountBn.lte(0)) {
      throw new Error(
        `Transaction ${hash} does not contain a positive TON amount.`
      );
    }

    const record = await createPepeTransaction({
      txHash: hash,
      fromWalletAddress: details.fromWalletAddress,
      toWalletAddress: details.toWalletAddress,
      giftId,
      currency: "TON",
      amount: amountNano,
      txType: "SELL",
      timeStamp: details.timeStamp,
    });

    const txId = extractIdentifier(record, [
      "TxID",
      "txId",
      "transactionId",
      "id",
    ]);

    totalNano = totalNano.plus(amountNano);
    const formattedAmount = formatTonAmount(amountNano);
    const idPart = txId !== null ? ` (ID: ${txId})` : "";
    entries.push(
      `- <a href="https://tonviewer.com/transaction/${hash}">${hash}</a> • ${formattedAmount} TON${idPart}`
    );
  }

  const totalFormatted = formatTonAmount(totalNano.toString(10));
  return [
    "PepeStrategy sell transactions registered:",
    ...entries,
    `Total TON sold: ${totalFormatted}`,
  ].join("\n");
}

export function setupRegisterMultipleSellsFlow({
  bot,
  allowedChatIds,
}: RegisterMultiSellsDeps) {
  const flowState = new Map<number, MultiSellFlowState>();

  bot.command("registersells", async (ctx) => {
    const chatId = ctx.chat?.id;
    const userId = ctx.from?.id;
    if (!chatId || !allowedChatIds.has(chatId)) {
      await ctx.reply("Not authorized to register sell transactions.");
      return;
    }
    if (!userId) {
      await ctx.reply("Unable to determine user initiating the request.");
      return;
    }

    if (flowState.has(userId)) {
      await ctx.reply(
        "A multi-sell registration is already in progress. Please finish or cancel it before starting another."
      );
      return;
    }

    const selectionMessage = await ctx.reply(
      "Select which strategy you want to register sell transactions for:",
      { reply_markup: buildTargetKeyboard() }
    );

    flowState.set(userId, {
      stage: "awaitingTarget",
      chatId,
      helperMessageIds: [selectionMessage.message_id],
    });
  });

  bot.on("callback_query", async (ctx, next) => {
    const data = (ctx.callbackQuery as any)?.data;
    if (typeof data !== "string" || !data.startsWith("multi_sell_target_")) {
      await next();
      return;
    }

    const targetId = data.replace("multi_sell_target_", "");
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

    const state = flowState.get(userId);
    if (!state || state.stage !== "awaitingTarget") {
      await ctx.answerCbQuery("Session expired. Use /registersells again.", {
        show_alert: true,
      });
      return;
    }

    const helperIds = new Set(state.helperMessageIds);
    const selectionMessageId = ctx.callbackQuery.message?.message_id;
    if (selectionMessageId) {
      helperIds.add(selectionMessageId);
    }

    const instructions = [
      `Registering sell transactions for ${target.label}.`,
      "Reply with JSON containing:",
      "- giftNumber",
      "- sellTxHashes (array of TON transaction hashes)",
      "Amounts will be fetched automatically from the blockchain.",
      "Send the payload exactly as in the example below.",
    ].join("\n");

    const instructionsMessage = await ctx.reply(instructions);
    helperIds.add(instructionsMessage.message_id);

    const exampleJson = `{
  "giftNumber": 3387,
  "sellTxHashes": [
    "<ton hash 1>",
    "<ton hash 2>"
  ]
}`;

    const exampleMessage = await ctx.reply(
      `\u0060\u0060\u0060json\n${exampleJson}\n\u0060\u0060\u0060`,
      { parse_mode: "MarkdownV2" }
    );
    helperIds.add(exampleMessage.message_id);

    flowState.set(userId, {
      stage: "awaitingPayload",
      chatId: state.chatId,
      helperMessageIds: Array.from(helperIds),
      target,
    });

    await ctx.answerCbQuery(`Selected ${target.label}`);
  });

  bot.on("text", async (ctx, next) => {
    const userId = ctx.from?.id;
    if (!userId) {
      await next();
      return;
    }

    const state = flowState.get(userId);
    if (!state) {
      await next();
      return;
    }

    if (state.stage === "awaitingTarget") {
      await ctx.reply(
        "Please choose a strategy using the buttons provided before sending JSON."
      );
      return;
    }

    if (state.stage !== "awaitingPayload") {
      await next();
      return;
    }

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
      flowState.delete(userId);
      await cleanupHelperMessages(bot, state.chatId, state.helperMessageIds);
      return;
    }

    const giftNumberRaw =
      parsed.giftNumber ?? parsed.giftNo ?? parsed.gift ?? parsed.GiftNumber;
    const giftNumber = Number(giftNumberRaw);
    if (!Number.isFinite(giftNumber)) {
      await ctx.reply("giftNumber is required and must be numeric.");
      flowState.delete(userId);
      await cleanupHelperMessages(bot, state.chatId, state.helperMessageIds);
      return;
    }

    const hashes = normalizeHashes(
      parsed.sellTxHashes ?? parsed.txHashes ?? parsed.hashes
    );
    if (hashes.length === 0) {
      await ctx.reply(
        "sellTxHashes must be a non-empty array of TON transaction hashes."
      );
      flowState.delete(userId);
      await cleanupHelperMessages(bot, state.chatId, state.helperMessageIds);
      return;
    }

    try {
      let summary: string;
      if (state.target.id === "CAPSTRATEGY") {
        summary = await registerCapSells(hashes, giftNumber);
      } else {
        summary = await registerPepeSells(hashes, giftNumber);
      }

      flowState.delete(userId);
      await cleanupHelperMessages(bot, state.chatId, state.helperMessageIds);
      await ctx.reply(summary, { parse_mode: "HTML" });
    } catch (error) {
      console.error("Failed to register sell transactions", error);
      flowState.delete(userId);
      await cleanupHelperMessages(bot, state.chatId, state.helperMessageIds);
      await ctx.reply(
        `Failed to register sell transactions: ${(error as Error).message}`
      );
    }
  });
}
