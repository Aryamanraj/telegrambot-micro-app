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
import { createCapRecord, createTransactionRecord } from "../backendClient";
import { CapState, PollResponse, StoredCap } from "../types";

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
    capAddress: string
  ): Promise<void> {
    if (subscribedChats.size === 0) {
      console.warn("No chat subscriptions available; message skipped");
      return;
    }

    console.log("Broadcasting alert to chats:", Array.from(subscribedChats));
    for (const chatId of subscribedChats) {
      try {
        const result = await bot.telegram.sendMessage(chatId, message, {
          parse_mode: "HTML",
          reply_markup: buildActionKeyboard(capAddress),
        });
        const stored = announcedCaps.get(capAddress);
        if (stored) {
          stored.messageIds[chatId] = result.message_id;
        }
        console.log(`Alert sent to chat ${chatId} for cap ${capAddress}`);
      } catch (error) {
        console.error(`Failed to deliver alert to chat ${chatId}`, error);
      }
    }
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
      console.log(
        `Polled at ${new Date(data.polledAt).toISOString()}: totalCaps=${
          data.totalCaps
        }, hasNew=${data.hasNew}, newCaps=${data.newCaps.length}`
      );

      if (!data.hasNew || data.newCaps.length === 0) {
        return;
      }

      const freshCaps = data.newCaps.filter(
        (cap) => !announcedCaps.has(cap.offchainGetgemsAddress)
      );

      if (freshCaps.length === 0) return;

      await appendRawCaps(freshCaps);

      for (const cap of freshCaps) {
        const stored: StoredCap = {
          item: cap,
          state: "PUBLISHED" as CapState,
          publishedChatIds: Array.from(subscribedChats),
          messageIds: {},
          isEdited: false,
          buyTransactionRecord: null,
          capStrRecord: null,
        };
        announcedCaps.set(cap.offchainGetgemsAddress, stored);
        const message = buildAlertMessage(cap, stored.state, stored.isEdited);
        await broadcastMessage(message, cap.offchainGetgemsAddress);
      }

      await persistAnnouncedAddresses();
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

    if (!stored.buyTransactionRecord) {
      stored.buyTransactionRecord = await createTransactionRecord(cap);
      await persistAnnouncedAddresses();
    }

    const buyTransactionId = (stored.buyTransactionRecord as any).data?.TxID as
      | number
      | null;

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

    stored.state = "APPROVED";
    await persistAnnouncedAddresses();
    const message = buildAlertMessage(stored.item, stored.state, stored.isEdited);
    for (const [chatId, messageId] of Object.entries(stored.messageIds)) {
      try {
        await bot.telegram.editMessageText(
          Number(chatId),
          Number(messageId),
          undefined,
          message,
          {
            parse_mode: "HTML",
            reply_markup: { inline_keyboard: [] },
          }
        );
      } catch (error) {
        console.error(
          `Failed to update approved message in chat ${chatId}`,
          error
        );
      }
    }
  }

  async function rejectCap(address: string) {
    const stored = announcedCaps.get(address);
    if (stored) {
      stored.state = "REJECTED";
      await persistAnnouncedAddresses();
      const message = buildAlertMessage(
        stored.item,
        stored.state,
        stored.isEdited
      );
      for (const [chatId, messageId] of Object.entries(stored.messageIds)) {
        try {
          await bot.telegram.editMessageText(
            Number(chatId),
            Number(messageId),
            undefined,
            message,
            {
              parse_mode: "HTML",
              reply_markup: { inline_keyboard: [] },
            }
          );
        } catch (error) {
          console.error(
            `Failed to update rejected message in chat ${chatId}`,
            error
          );
        }
      }
    }
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
        const prop = fieldToProperty[field];
        if (prop === "buyTime") {
          const parsed = Number(newValue);
          if (!Number.isNaN(parsed)) {
            stored.item.buyTime = parsed;
          }
        } else if (prop === "onchainAddress") {
          stored.item.onchainAddress = newValue || null;
        } else {
          (stored.item as any)[prop] = newValue;
        }
        stored.isEdited = true;
        await persistAnnouncedAddresses();
        const newMessage = buildAlertMessage(
          stored.item,
          stored.state,
          stored.isEdited
        );
        const replyMarkup =
          stored.state === "APPROVED" || stored.state === "REJECTED"
            ? { inline_keyboard: [] }
            : buildActionKeyboard(capAddress);
        for (const [chid, mid] of Object.entries(stored.messageIds)) {
          try {
            await ctx.telegram.editMessageText(
              Number(chid),
              Number(mid),
              undefined,
              newMessage,
              {
                parse_mode: "HTML",
                reply_markup: replyMarkup,
              }
            );
          } catch (error) {
            console.error(`Failed to edit message in chat ${chid}`, error);
          }
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
