import { Telegraf } from "telegraf";

import { buildPepeAlertMessage } from "../messages";
import {
  announcedPepeGifts,
  appendRawPepeGifts,
  persistAnnouncedPepeGifts,
} from "../storage";
import { CapState, PepePollResponse, StoredPepeGift } from "../types";

interface PepeManagementDeps {
  bot: Telegraf;
  pepePollUrl: string;
  pollApiKey: string;
  pollIntervalMs: number;
  subscribedChats: Set<number>;
}

export function setupPepeManagement({
  bot,
  pepePollUrl,
  pollApiKey,
  pollIntervalMs,
  subscribedChats,
}: PepeManagementDeps) {
  async function broadcastMessage(
    message: string,
    giftAddress: string
  ): Promise<void> {
    if (subscribedChats.size === 0) {
      console.warn("No chat subscriptions available; Pepe message skipped");
      return;
    }

    console.log(
      "Broadcasting Pepe alert to chats:",
      Array.from(subscribedChats)
    );
    for (const chatId of subscribedChats) {
      try {
        const result = await bot.telegram.sendMessage(chatId, message, {
          parse_mode: "HTML",
        });
        const stored = announcedPepeGifts.get(giftAddress);
        if (stored) {
          stored.messageIds[chatId] = result.message_id;
        }
        console.log(`Pepe alert sent to chat ${chatId} for gift ${giftAddress}`);
      } catch (error) {
        console.error(
          `Failed to deliver Pepe alert to chat ${chatId}`,
          error
        );
      }
    }
  }

  async function pollOnce(): Promise<void> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    try {
      const response = await fetch(pepePollUrl, {
        method: "GET",
        headers: {
          accept: "application/json",
          "x-api-key": pollApiKey,
        },
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`Pepe poll failed with HTTP ${response.status}`);
      }

      const payload = (await response.json()) as PepePollResponse;
      if (!payload.success || !payload.data) {
        console.warn(
          "Pepe poll succeeded but response flagged as unsuccessful",
          payload
        );
        return;
      }

      const { data } = payload;
      console.log(
        `Pepe poll at ${new Date(data.polledAt).toISOString()}: totalGifts=${
          data.totalGifts
        }, hasNew=${data.hasNew}, newGifts=${data.newGifts.length}`
      );

      if (!data.hasNew || data.newGifts.length === 0) {
        return;
      }

      const freshGifts = data.newGifts.filter(
        (gift) => !announcedPepeGifts.has(gift.offchainGetgemsAddress)
      );

      if (freshGifts.length === 0) return;

      await appendRawPepeGifts(freshGifts);

      for (const gift of freshGifts) {
        const stored: StoredPepeGift = {
          item: gift,
          state: "PUBLISHED" as CapState,
          publishedChatIds: Array.from(subscribedChats),
          messageIds: {},
          isEdited: false,
        };
        announcedPepeGifts.set(gift.offchainGetgemsAddress, stored);
        const message = buildPepeAlertMessage(gift);
        await broadcastMessage(message, gift.offchainGetgemsAddress);
      }

      await persistAnnouncedPepeGifts();
    } catch (error) {
      if ((error as Error).name === "AbortError") {
        console.error("Pepe poll request timed out");
        return;
      }

      console.error("Pepe polling failed", error);
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
    console.log("Initial Pepe poll cycle starting...");
    runPollCycle().catch((error) => {
      console.error("Initial Pepe poll failed", error);
    });

    pollTimer = setInterval(() => {
      runPollCycle().catch((error) => {
        console.error("Scheduled Pepe poll failed", error);
      });
    }, pollIntervalMs);
  }

  function stopPolling(): void {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  return {
    startPolling,
    stopPolling,
    triggerManualPoll: runPollCycle,
  };
}
