import { Telegraf } from "telegraf";

import {
  buildActionKeyboard,
  buildAlertMessage,
  buildFieldSelectionKeyboard,
  editableFields,
  fieldToProperty,
} from "../messages";
import {
  announcedCaps,
  appendRawCaps,
  persistAnnouncedAddresses,
} from "../storage";
import {
  createCapRecord,
  createSellTransactionRecord,
  createTransactionRecord,
  markCapAsSold,
  tonToNano,
} from "../backendClient";
import { CapState, CapSummary, PollResponse, StoredCap } from "../types";
import { extractIdentifier } from "../utils/records";

interface CapManagementDeps {
  bot: Telegraf;
  pollUrl: string;
  pollApiKey: string;
  pollIntervalMs: number;
  subscribedChats: Set<number>;
}

export function setupCapManagement({
  bot,
  pollUrl,
  pollApiKey,
  pollIntervalMs,
  subscribedChats,
}: CapManagementDeps) {
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
  >();

  async function broadcastMessage(
    message: string,
    capAddress: string,
    options: { disableActions?: boolean } = {}
  ): Promise<void> {
    const disableActions = options.disableActions ?? false;
    const replyMarkup = disableActions
      ? { inline_keyboard: [] as any[] }
      : buildActionKeyboard(capAddress);

    if (subscribedChats.size === 0) {
      console.warn("No chat subscriptions available; message skipped");
      return;
    }

  console.log("Broadcasting alert to chats:", Array.from(subscribedChats));
    for (const chatId of subscribedChats) {
      try {
        const result = await bot.telegram.sendMessage(chatId, message, {
          parse_mode: "HTML",
          reply_markup: replyMarkup,
        });
        const stored = announcedCaps.get(capAddress);
        if (stored) {
          stored.messageIds[chatId] = result.message_id;
          if (!stored.publishedChatIds.includes(chatId)) {
            stored.publishedChatIds.push(chatId);
          }
        }
        console.log(`Alert sent to chat ${chatId} for cap ${capAddress}`);
      } catch (error) {
        console.error(`Failed to deliver alert to chat ${chatId}`, error);
      }
    }
  }

  function shouldDisableActions(state: CapState): boolean {
    switch (state) {
      case "APPROVED":
      case "REJECTED":
      case "SOLD_APPROVED":
      case "SOLD_REJECTED":
        return true;
      default:
        return false;
    }
  }

  function mergeCapSummary(
    base: CapSummary | undefined,
    update: CapSummary
  ): CapSummary {
    return {
      onchainAddress: update.onchainAddress ?? base?.onchainAddress ?? null,
      offchainGetgemsAddress:
        update.offchainGetgemsAddress ?? base?.offchainGetgemsAddress ?? "",
      name: update.name ?? base?.name ?? null,
      capNumber: update.capNumber ?? base?.capNumber ?? null,
      collectionAddress:
        update.collectionAddress ?? base?.collectionAddress ?? null,
      image: update.image ?? base?.image ?? null,
      saleType: update.saleType ?? base?.saleType ?? null,
      buyPriceTon: update.buyPriceTon ?? base?.buyPriceTon ?? null,
      salePriceTon: update.salePriceTon ?? base?.salePriceTon ?? null,
      detectedAt: update.detectedAt ?? base?.detectedAt ?? Date.now(),
      buyTime: update.buyTime ?? base?.buyTime ?? Date.now(),
      saleTime:
        update.saleTime !== undefined
          ? update.saleTime
          : base?.saleTime ?? null,
      getGemsUrl: update.getGemsUrl ?? base?.getGemsUrl ?? "",
      txHash: update.txHash ?? base?.txHash ?? "",
      fromWalletAddress:
        update.fromWalletAddress ?? base?.fromWalletAddress ?? "",
      toWalletAddress: update.toWalletAddress ?? base?.toWalletAddress ?? "",
      giftId: update.giftId ?? base?.giftId ?? 0,
    };
  }

  function determineSaleState(previousState: CapState | undefined): CapState {
    switch (previousState) {
      case "APPROVED":
      case "APPROVED_SOLD":
        return "APPROVED_SOLD";
      case "REJECTED":
      case "SOLD_REJECTED":
        return "SOLD_REJECTED";
      case "SOLD_APPROVED":
        return "SOLD_APPROVED";
      case "SOLD_PUBLISHED":
      case "PUBLISHED":
      default:
        return "SOLD_PUBLISHED";
    }
  }

  function isSoldState(state: CapState | undefined): boolean {
    return (
      state === "SOLD_PUBLISHED" ||
      state === "SOLD_APPROVED" ||
      state === "SOLD_REJECTED" ||
      state === "APPROVED_SOLD"
    );
  }

  async function refreshCapMessage(
    address: string,
    stored: StoredCap
  ): Promise<void> {
    const message = buildAlertMessage(stored.item, stored.state, stored.isEdited);
    const disableActions = shouldDisableActions(stored.state);
    const replyMarkup = disableActions
      ? { inline_keyboard: [] as any[] }
      : buildActionKeyboard(address);

    const targetChats = new Set<number>([
      ...stored.publishedChatIds,
      ...subscribedChats,
    ]);

    for (const chatId of targetChats) {
      const existingMessageId = stored.messageIds[chatId];
      if (existingMessageId) {
        try {
          await bot.telegram.editMessageText(
            chatId,
            existingMessageId,
            undefined,
            message,
            {
              parse_mode: "HTML",
              reply_markup: replyMarkup,
            }
          );
          continue;
        } catch (error) {
          const description = (error as any)?.response?.description ?? "";
          if (
            typeof description === "string" &&
            description.includes("message is not modified")
          ) {
            continue;
          }

          console.error(
            `Failed to update message in chat ${chatId} for cap ${address}`,
            error
          );
        }
      }

      try {
        const result = await bot.telegram.sendMessage(chatId, message, {
          parse_mode: "HTML",
          reply_markup: replyMarkup,
        });
        stored.messageIds[chatId] = result.message_id;
        if (!stored.publishedChatIds.includes(chatId)) {
          stored.publishedChatIds.push(chatId);
        }
      } catch (error) {
        console.error(
          `Failed to send message in chat ${chatId} for cap ${address}`,
          error
        );
      }
    }
  }

  async function processSaleAnnouncements(
    sales: CapSummary[]
  ): Promise<boolean> {
    if (!Array.isArray(sales) || sales.length === 0) {
      return false;
    }

    let updated = false;
    const loggedSales: CapSummary[] = [];

    for (const sale of sales) {
      const saleTimestamp =
        sale.saleTime !== undefined && sale.saleTime !== null
          ? sale.saleTime
          : sale.detectedAt ?? sale.buyTime;
      const normalizedSale: CapSummary = {
        ...sale,
        saleTime: saleTimestamp,
      };

      const address = normalizedSale.offchainGetgemsAddress;
      const existing = announcedCaps.get(address);

      if (existing) {
        const preferExisting = existing.hasManualChanges === true;
        const mergedItem = preferExisting
          ? mergeCapSummary(normalizedSale, existing.item)
          : mergeCapSummary(existing.item, normalizedSale);
        existing.item = mergedItem;
        existing.isEdited = true;
        const nextState = determineSaleState(existing.state);
        if (existing.state !== nextState) {
          existing.state = nextState;
        }
        await refreshCapMessage(address, existing);
      } else {
        const initialState: CapState = "SOLD_PUBLISHED";
        const stored: StoredCap = {
          item: normalizedSale,
          state: initialState,
          publishedChatIds: Array.from(subscribedChats),
          messageIds: {},
          isEdited: false,
          buyTransactionRecord: null,
          capStrRecord: null,
          hasManualChanges: false,
          sellTransactionRecord: null,
        };
        announcedCaps.set(address, stored);
        const message = buildAlertMessage(
          stored.item,
          stored.state,
          stored.isEdited
        );
        await broadcastMessage(message, address, {
          disableActions: shouldDisableActions(stored.state),
        });
      }

      loggedSales.push(normalizedSale);
      updated = true;
    }

    if (loggedSales.length > 0) {
      await appendRawCaps(loggedSales);
    }

    return updated;
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
      const newCaps = Array.isArray(data.newCaps) ? data.newCaps : [];
      const newSales = Array.isArray(data.newSales) ? data.newSales : [];
      const hasNewCaps = Boolean(data.hasNew) && newCaps.length > 0;
      const hasNewSales = Boolean(data.hasNewSales) && newSales.length > 0;

      console.log(
        `Polled at ${new Date(data.polledAt).toISOString()}: totalCaps=${
          data.totalCaps
        }, hasNewCaps=${hasNewCaps}, newCaps=${newCaps.length}, hasNewSales=${hasNewSales}, newSales=${newSales.length}`
      );

      let persistNeeded = false;

      if (hasNewCaps) {
        const freshCaps = newCaps.filter(
          (cap) => !announcedCaps.has(cap.offchainGetgemsAddress)
        );

        if (freshCaps.length > 0) {
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
              hasManualChanges: false,
              sellTransactionRecord: null,
            };
            announcedCaps.set(cap.offchainGetgemsAddress, stored);
            const message = buildAlertMessage(
              cap,
              stored.state,
              stored.isEdited
            );
            await broadcastMessage(message, cap.offchainGetgemsAddress, {
              disableActions: shouldDisableActions(stored.state),
            });
          }

          persistNeeded = true;
        }
      }

      if (hasNewSales) {
        const salesUpdated = await processSaleAnnouncements(newSales);
        if (salesUpdated) {
          persistNeeded = true;
        }
      }

      if (persistNeeded) {
        await persistAnnouncedAddresses();
      }
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

  async function approveCap(address: string) {
    const stored = announcedCaps.get(address);
    if (!stored) {
      throw new Error(`Cap ${address} not found for approval`);
    }

    const cap = stored.item;

    const ensureApprovalPrerequisites = async (): Promise<string | number> => {
      if (!stored.buyTransactionRecord) {
        stored.buyTransactionRecord = await createTransactionRecord(cap);
        await persistAnnouncedAddresses();
      }

      const buyTransactionId = extractIdentifier(stored.buyTransactionRecord, [
        "TxID",
        "txId",
        "transactionId",
        "id",
      ]);

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

      return buyTransactionId;
      return 0;
    };

    if (stored.state === "SOLD_APPROVED") {
      await refreshCapMessage(address, stored);
      return;
    }

    if (
      stored.state === "SOLD_PUBLISHED" ||
      stored.state === "SOLD_REJECTED" ||
      stored.state === "APPROVED_SOLD"
    ) {
      const salePriceNano = tonToNano(cap.salePriceTon);
      if (salePriceNano === "0") {
        throw new Error(
          `Sale price unavailable for ${cap.offchainGetgemsAddress}; cannot approve sale`
        );
      }

      const saleTimeSource =
        cap.saleTime ?? cap.detectedAt ?? cap.buyTime ?? Date.now();
      const saleTime = Number(saleTimeSource);
      if (!Number.isFinite(saleTime)) {
        throw new Error(
          `Sale time unavailable for ${cap.offchainGetgemsAddress}; cannot approve sale`
        );
      }

      if (!stored.sellTransactionRecord) {
        stored.sellTransactionRecord = await createSellTransactionRecord(
          cap,
          saleTime
        );
        await persistAnnouncedAddresses();
      }

      const sellTransactionId = extractIdentifier(
        stored.sellTransactionRecord ?? null,
        ["TxID", "txId", "transactionId", "id"]
      );
      if (sellTransactionId === null) {
        console.error(
          "Sell transaction response missing identifier:",
          JSON.stringify(stored.sellTransactionRecord)
        );
        throw new Error(
          `Sell transaction record for ${cap.offchainGetgemsAddress} missing identifier`
        );
      }

      const giftNumber = cap.giftId ?? cap.capNumber;
      if (typeof giftNumber !== "number" || !Number.isFinite(giftNumber)) {
        throw new Error(
          `Gift number unavailable for ${cap.offchainGetgemsAddress}; cannot approve sale`
        );
      }

      const soldRecord = await markCapAsSold(
        giftNumber,
        salePriceNano,
        saleTime,
        sellTransactionId
      );
      stored.capStrRecord = soldRecord;
      stored.state = "SOLD_APPROVED";
      await persistAnnouncedAddresses();
      await refreshCapMessage(address, stored);
      return;
    }

    if (
      (stored.state === "APPROVED" || stored.state === "REJECTED") &&
      stored.item.saleTime !== null &&
      stored.item.saleTime !== undefined
    ) {
      stored.state = "APPROVED_SOLD";
      await persistAnnouncedAddresses();
      await refreshCapMessage(address, stored);
      return;
    }

    await ensureApprovalPrerequisites();

    if (!stored.buyTransactionRecord) {
      throw new Error("Buy transaction record missing after ensure step");
    }

    stored.state = "APPROVED";
    await persistAnnouncedAddresses();
    await refreshCapMessage(address, stored);
  }

  async function rejectCap(address: string) {
    const stored = announcedCaps.get(address);
    if (!stored) {
      return;
    }

    if (
      stored.state === "SOLD_PUBLISHED" ||
      stored.state === "SOLD_APPROVED" ||
      stored.state === "APPROVED_SOLD"
    ) {
      stored.state = "SOLD_REJECTED";
    } else {
      stored.state = "REJECTED";
    }

    await persistAnnouncedAddresses();
    await refreshCapMessage(address, stored);
  }

  bot.on("callback_query", async (ctx, next) => {
    const data = (ctx.callbackQuery as any).data as string;
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
      return;
    }
    if (data.startsWith("select_field_")) {
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
      return;
    }
    if (data.startsWith("approve_")) {
      const address = data.slice(8);
      try {
        await approveCap(address);
        await ctx.answerCbQuery("Approved");
      } catch (error) {
        console.error(`Approval flow failed for ${address}`, error);
        await ctx.answerCbQuery("Approval failed");
        await ctx.reply("Failed to approve cap. Check logs for details.");
      }
      return;
    }
    if (data.startsWith("reject_")) {
      const address = data.slice(7);
      const stored = announcedCaps.get(address);
      if (isSoldState(stored?.state)) {
        await ctx.answerCbQuery("Sale rejection review coming soon");
        return;
      }
      await rejectCap(address);
      await ctx.answerCbQuery("Rejected");
      return;
    }
    await next();
  });

  bot.on("text", async (ctx, next) => {
    const userId = ctx.from!.id;
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
        const propKey = fieldToProperty[field];
        let previousValue: unknown = undefined;
        if (propKey) {
          previousValue = (stored.item as any)[propKey];
        }

        if (propKey === "buyTime" || propKey === "saleTime") {
          const parsed = Number(newValue);
          if (!Number.isNaN(parsed)) {
            (stored.item as any)[propKey] = parsed;
          }
        } else if (propKey === "onchainAddress") {
          stored.item.onchainAddress = newValue || null;
        } else if (propKey) {
          (stored.item as any)[propKey] = newValue;
        }

        stored.isEdited = true;
        stored.hasManualChanges = true;

        if (propKey) {
          const updatedValue = (stored.item as any)[propKey];
          console.info(
            `Updating ${propKey} for ${capAddress}: ${String(
              previousValue
            )} -> ${String(updatedValue)}`
          );
        }

        await persistAnnouncedAddresses();

        // Use the centralized refresh so all published and subscribed chats
        // receive the same updated message and we avoid per-chat drift.
        try {
          await refreshCapMessage(capAddress, stored);
        } catch (error) {
          console.error(`Failed to refresh cap message for ${capAddress}`, error);
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

  return {
    startPolling,
    stopPolling,
    triggerManualPoll: runPollCycle,
  };
}
