import { promises as fs } from "fs";

import {
  announcedFilePath,
  announcedPepeFilePath,
  dataDir,
  rawLogFilePath,
  rawPepeLogFilePath,
} from "./config";
import {
  ApiRecord,
  CapSummary,
  RawCapLogEntry,
  StoredCap,
  PepeGiftSummary,
  RawPepeGiftLogEntry,
  StoredPepeGift,
} from "./types";

export const announcedCaps = new Map<string, StoredCap>();
export const announcedPepeGifts = new Map<string, StoredPepeGift>();

function isSellTransactionPending(record: ApiRecord | null): boolean {
  if (!record) return false;
  const data = (record as any).data ?? record;
  if (!data || typeof data !== "object") return false;
  const sellTransaction =
    (data as any).SellTransaction ?? (data as any).sellTransaction ?? null;
  return sellTransaction === null || sellTransaction === undefined;
}

export async function loadAnnouncedCaps(): Promise<void> {
  try {
    const raw = await fs.readFile(announcedFilePath, "utf8");
    const parsed = JSON.parse(raw) as { caps?: StoredCap[] };
    if (Array.isArray(parsed.caps)) {
      parsed.caps.forEach((stored) => {
        stored.messageIds = stored.messageIds ?? {};
        stored.isEdited = stored.isEdited || false;
        stored.buyTransactionRecord = stored.buyTransactionRecord ?? null;
        stored.capStrRecord = stored.capStrRecord ?? null;
        stored.sellTransactionRecord = stored.sellTransactionRecord ?? null;
  stored.hasManualChanges = stored.hasManualChanges || false;
        if (stored.item) {
          (stored.item as any).saleTime =
            (stored.item as any).saleTime ?? null;
        }
        announcedCaps.set(stored.item.offchainGetgemsAddress, stored);
      });
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return;
    console.error("Failed to load announced caps", error);
  }
}

export async function persistAnnouncedAddresses(): Promise<void> {
  try {
    await fs.mkdir(dataDir, { recursive: true });
    const payload = JSON.stringify(
      { caps: Array.from(announcedCaps.values()) },
      null,
      2
    );
    await fs.writeFile(announcedFilePath, payload, "utf8");
  } catch (error) {
    console.error("Failed to persist announced caps", error);
  }
}

export async function appendRawCaps(caps: CapSummary[]): Promise<void> {
  if (caps.length === 0) return;
  try {
    await fs.mkdir(dataDir, { recursive: true });
    let entries: RawCapLogEntry[] = [];
    try {
      const raw = await fs.readFile(rawLogFilePath, "utf8");
      const parsed = JSON.parse(raw) as { entries?: RawCapLogEntry[] };
      if (Array.isArray(parsed.entries)) {
        entries = parsed.entries;
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        console.error("Failed to read raw caps log", error);
      }
    }

    const receivedAt = Date.now();
    const newEntries = caps.map((cap) => ({
      receivedAt,
      cap: JSON.parse(JSON.stringify(cap)) as CapSummary,
    }));
    entries.push(...newEntries);

    const payload = JSON.stringify({ entries }, null, 2);
    await fs.writeFile(rawLogFilePath, payload, "utf8");
  } catch (error) {
    console.error("Failed to append raw caps", error);
  }
}

export async function loadAnnouncedPepeGifts(): Promise<void> {
  try {
    const raw = await fs.readFile(announcedPepeFilePath, "utf8");
    const parsed = JSON.parse(raw) as { gifts?: StoredPepeGift[] };
    if (Array.isArray(parsed.gifts)) {
      parsed.gifts.forEach((stored) => {
        stored.messageIds = stored.messageIds ?? {};
        stored.isEdited = stored.isEdited || false;
        announcedPepeGifts.set(stored.item.offchainGetgemsAddress, stored);
      });
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return;
    console.error("Failed to load announced Pepe gifts", error);
  }
}

export async function persistAnnouncedPepeGifts(): Promise<void> {
  try {
    await fs.mkdir(dataDir, { recursive: true });
    const payload = JSON.stringify(
      { gifts: Array.from(announcedPepeGifts.values()) },
      null,
      2
    );
    await fs.writeFile(announcedPepeFilePath, payload, "utf8");
  } catch (error) {
    console.error("Failed to persist announced Pepe gifts", error);
  }
}

export async function appendRawPepeGifts(
  gifts: PepeGiftSummary[]
): Promise<void> {
  if (gifts.length === 0) return;
  try {
    await fs.mkdir(dataDir, { recursive: true });
    let entries: RawPepeGiftLogEntry[] = [];
    try {
      const raw = await fs.readFile(rawPepeLogFilePath, "utf8");
      const parsed = JSON.parse(raw) as { entries?: RawPepeGiftLogEntry[] };
      if (Array.isArray(parsed.entries)) {
        entries = parsed.entries;
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        console.error("Failed to read raw Pepe gifts log", error);
      }
    }

    const receivedAt = Date.now();
    const newEntries = gifts.map((gift) => ({
      receivedAt,
      gift: JSON.parse(JSON.stringify(gift)) as PepeGiftSummary,
    }));
    entries.push(...newEntries);

    const payload = JSON.stringify({ entries }, null, 2);
    await fs.writeFile(rawPepeLogFilePath, payload, "utf8");
  } catch (error) {
    console.error("Failed to append raw Pepe gifts", error);
  }
}

export async function loadAnnouncedAddresses(): Promise<void> {
  await Promise.all([loadAnnouncedCaps(), loadAnnouncedPepeGifts()]);
}

export function findCapByGiftNumber(
  giftNumber: number
): StoredCap | undefined {
  const matches: StoredCap[] = [];
  for (const stored of announcedCaps.values()) {
    if (
      stored.item.giftId === giftNumber ||
      stored.item.capNumber === giftNumber
    ) {
      matches.push(stored);
    }
  }

  if (matches.length === 0) {
    return undefined;
  }

  const withCapRecord = matches.filter((stored) => stored.capStrRecord);
  const pendingSell = withCapRecord.find((stored) =>
    isSellTransactionPending(stored.capStrRecord)
  );
  if (pendingSell) {
    return pendingSell;
  }

  if (withCapRecord.length > 0) {
    return withCapRecord[0];
  }

  return matches[0];
}

export function findPepeGiftByGiftNumber(
  giftNumber: number
): StoredPepeGift | undefined {
  for (const stored of announcedPepeGifts.values()) {
    if (
      stored.item.giftNumber === giftNumber ||
      stored.item.giftId === giftNumber
    ) {
      return stored;
    }
  }
  return undefined;
}
