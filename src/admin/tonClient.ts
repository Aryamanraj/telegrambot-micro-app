import BigNumber from "bignumber.js";

import { tonApiBaseUrl, tonApiKey } from "./config";
import { TonTransactionDetails } from "./types";

function crc16(buffer: Buffer): number {
  let crc = 0xffff;
  for (let i = 0; i < buffer.length; i += 1) {
    crc ^= buffer[i] << 8;
    for (let j = 0; j < 8; j += 1) {
      if (crc & 0x8000) {
        crc = ((crc << 1) ^ 0x1021) & 0xffff;
      } else {
        crc = (crc << 1) & 0xffff;
      }
    }
  }
  return crc & 0xffff;
}

export function tonFriendlyAddress(
  raw: string | null | undefined
): string {
  if (!raw) return "";
  const trimmed = raw.trim();
  if (!trimmed.includes(":")) {
    return trimmed;
  }

  const [wcPart, hashPart] = trimmed.split(":");
  if (!wcPart || !hashPart) {
    return trimmed;
  }

  const normalizedHash = hashPart.replace(/[^0-9a-fA-F]/g, "").toLowerCase();
  if (normalizedHash.length !== 64) {
    return trimmed;
  }

  const workchain = Number(wcPart);
  if (!Number.isInteger(workchain) || workchain < -128 || workchain > 127) {
    return trimmed;
  }

  const addressBytes = Buffer.alloc(34);
  addressBytes[0] = 0x11;
  addressBytes.writeInt8(workchain, 1);
  Buffer.from(normalizedHash, "hex").copy(addressBytes, 2);

  const crc = crc16(addressBytes);
  const full = Buffer.alloc(36);
  addressBytes.copy(full, 0);
  full[34] = (crc >> 8) & 0xff;
  full[35] = crc & 0xff;

  return full
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export async function fetchTonTransactionDetails(
  txHash: string
): Promise<TonTransactionDetails> {
  const base = tonApiBaseUrl.replace(/\/$/, "");
  const url = `${base}/blockchain/transactions/${txHash}`;
  const headers: Record<string, string> = {
    accept: "application/json",
  };
  if (tonApiKey) {
    headers.Authorization = `Bearer ${tonApiKey}`;
  }

  const response = await fetch(url, { headers });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `Ton API request failed for ${txHash} with HTTP ${response.status}: ${text}`
    );
  }

  const payload = (await response.json()) as any;
  const transaction = payload.transaction ?? payload;
  const inMsg = transaction.in_msg ?? transaction.inMessage ?? null;
  const outMsgs = (transaction.out_msgs ??
    transaction.outMessages ??
    []) as any[];

  const decodedPriorityAmounts: string[] = [];
  const decodedFallbackAmounts: string[] = [];
  let hasPriorityJettonAmount = false;

  const considerAmountCandidate = (
    value: unknown,
    priority: boolean,
    options?: { tag?: string }
  ) => {
    if (value === null || value === undefined) return;
    const normalized = String(value).trim();
    if (!normalized) return;
    try {
      const candidate = new BigNumber(normalized);
      if (!candidate.isFinite() || candidate.lte(0)) return;
      if (priority) {
        if (!decodedPriorityAmounts.includes(candidate.toFixed(0))) {
          decodedPriorityAmounts.push(candidate.toFixed(0));
        }
        if (
          options?.tag === "amount_out" ||
          options?.tag === "jetton_amount"
        ) {
          hasPriorityJettonAmount = true;
        }
      } else if (!decodedFallbackAmounts.includes(candidate.toFixed(0))) {
        decodedFallbackAmounts.push(candidate.toFixed(0));
      }
    } catch (_error) {
      // ignore non-numeric values
    }
  };

  const collectDecodedAmounts = (message: any) => {
    if (!message || typeof message !== "object") return;
    const decoded = message.decoded_body ?? message.decodedBody;
    if (!decoded || typeof decoded !== "object") return;
    const opName = String(message.decoded_op_name ?? message.decodedOpName ?? "");
    const opNameLower = opName.toLowerCase();
    const isSwapOp = /swap/.test(opNameLower);
    const isJettonTransferOp =
      /jetton.*transfer/.test(opNameLower) ||
      /internal_transfer/.test(opNameLower);
    const isPayoutOp = /payout/.test(opNameLower);
    const isJettonBurnOp = /jetton.*burn/.test(opNameLower) ||
      opNameLower === "jetton_burn_notification" ||
      (/burn/.test(opNameLower) && /jetton/.test(opNameLower));

    const stack: any[] = [decoded];
    while (stack.length > 0) {
      const current = stack.pop();
      if (!current || typeof current !== "object") continue;
      for (const [key, raw] of Object.entries(current)) {
        if (raw && typeof raw === "object") {
          stack.push(raw);
        }

        const lowercaseKey = key.toLowerCase();

        if (
          lowercaseKey === "amount_out" ||
          lowercaseKey === "amountout" ||
          lowercaseKey === "amount_out_tokens" ||
          lowercaseKey === "amountouttokens" ||
          lowercaseKey === "amount_out_jetton" ||
          lowercaseKey === "amountoutjetton"
        ) {
          considerAmountCandidate(raw, true, { tag: "amount_out" });
        } else if (
          lowercaseKey === "amount" &&
          (isJettonTransferOp || isPayoutOp || isJettonBurnOp)
        ) {
          considerAmountCandidate(raw, true, { tag: "jetton_amount" });
        } else if (
          lowercaseKey === "amount" &&
          isSwapOp
        ) {
          considerAmountCandidate(raw, false, { tag: "swap_amount" });
        } else if (
          lowercaseKey === "amount_in" ||
          lowercaseKey === "amountin"
        ) {
          considerAmountCandidate(raw, false);
        }
      }
    }
  };

  collectDecodedAmounts(inMsg);
  for (const msg of outMsgs) {
    collectDecodedAmounts(msg);
  }

  let traceAttempted = false;

  const collectDecodedFromTransaction = (tx: any) => {
    if (!tx || typeof tx !== "object") return;
    collectDecodedAmounts(tx.in_msg ?? tx.inMessage ?? null);
    const localOutMsgs = (tx.out_msgs ?? tx.outMessages ?? []) as any[];
    for (const message of localOutMsgs) {
      collectDecodedAmounts(message);
    }
  };

  if (!hasPriorityJettonAmount) {
    const traceUrl = `${base}/traces/${txHash.toUpperCase()}`;
    try {
      traceAttempted = true;
      const traceResponse = await fetch(traceUrl, { headers });
      if (traceResponse.ok) {
        const tracePayload = (await traceResponse.json()) as any;

        const traverseTrace = (node: any) => {
          if (!node) return;
          const txNode = node.transaction ?? node;
          collectDecodedFromTransaction(txNode);

          const children = node.children;
          if (Array.isArray(children)) {
            for (const child of children) {
              traverseTrace(child);
            }
          }
        };

        traverseTrace(tracePayload);
      }
    } catch (_traceError) {
      // ignore trace failures and fall back to existing candidates
    }
  }

  console.log("[tonClient] decoded amounts", {
    txHash,
    priority: [...decodedPriorityAmounts],
    fallback: [...decodedFallbackAmounts],
    traceAttempted,
    hasPriorityJettonAmount,
  });

  const fromAddress =
    inMsg?.source?.address ??
    inMsg?.source ??
    transaction.account?.address ??
    null;

  const toAddressCandidate =
    inMsg?.destination?.address ??
    inMsg?.destination ??
    outMsgs?.[0]?.destination?.address ??
    outMsgs?.[0]?.destination ??
    transaction.account?.address ??
    null;

  const resolvedFrom = fromAddress ?? toAddressCandidate;
  const resolvedTo = toAddressCandidate ?? fromAddress;

  if (!resolvedFrom || !resolvedTo) {
    throw new Error(`Ton transaction ${txHash} missing address details`);
  }

  const friendlyFrom = tonFriendlyAddress(resolvedFrom);
  const friendlyTo = tonFriendlyAddress(resolvedTo);

  const extractValue = (
    candidate: any,
    seen: Set<any> = new Set()
  ): string | null => {
    if (candidate === null || candidate === undefined) {
      return null;
    }
    if (typeof candidate === "string") {
      const trimmed = candidate.trim();
      return trimmed.length > 0 ? trimmed : null;
    }
    if (typeof candidate === "number" && Number.isFinite(candidate)) {
      return Math.trunc(candidate).toString();
    }
    if (typeof candidate !== "object") {
      return null;
    }
    if (seen.has(candidate)) {
      return null;
    }
    seen.add(candidate);

    const directCandidates = [
      candidate.value,
      candidate.Value,
      candidate.amount,
      candidate.Amount,
      candidate.coins,
      candidate.Coins,
    ];
    for (const val of directCandidates) {
      const extracted = extractValue(val, seen);
      if (extracted) {
        return extracted;
      }
    }

    for (const value of Object.values(candidate)) {
      const extracted = extractValue(value, seen);
      if (extracted) {
        return extracted;
      }
    }

    return null;
  };

  const normalizeAmount = (raw: string | null): string | null => {
    if (!raw) return null;
    try {
      const value = new BigNumber(raw);
      if (!value.isFinite() || value.lte(0)) {
        return null;
      }
      return value.integerValue(BigNumber.ROUND_FLOOR).toString(10);
    } catch (_error) {
      return null;
    }
  };

  const pickNonZeroAmount = (candidates: (string | null)[]): string | null => {
    for (const candidate of candidates) {
      const normalized = normalizeAmount(candidate);
      if (normalized) {
        return normalized;
      }
    }
    return null;
  };

  const amountFromIn = normalizeAmount(extractValue(inMsg));

  const collectOutAmounts = (): string | null => {
    if (!Array.isArray(outMsgs)) {
      return null;
    }

    const prioritized: (string | null)[] = [];
    const fallback: (string | null)[] = [];

    for (const msg of outMsgs) {
      const destinationRaw =
        msg?.destination?.address ?? msg?.destination ?? null;
      const friendlyDestination = tonFriendlyAddress(destinationRaw);
      const sourceRaw = msg?.source?.address ?? msg?.source ?? null;
      const friendlySource = tonFriendlyAddress(sourceRaw);
      const valueCandidate = extractValue(msg);

      if (
        friendlyDestination === friendlyTo ||
        friendlySource === friendlyFrom
      ) {
        prioritized.push(valueCandidate);
      } else {
        fallback.push(valueCandidate);
      }
    }

    return pickNonZeroAmount([...prioritized, ...fallback]);
  };

  const amountFromDecodedPriority = pickNonZeroAmount(decodedPriorityAmounts);
  const amountFromDecodedFallback = pickNonZeroAmount(decodedFallbackAmounts);

  let amountNano: string | null = null;
  let amountSource = "";

  if (!amountNano && amountFromDecodedPriority) {
    amountNano = amountFromDecodedPriority;
    amountSource = "decoded_priority";
  }

  if (!amountNano) {
    amountNano = collectOutAmounts();
    if (amountNano) {
      amountSource = "out_messages";
    }
  }

  if (!amountNano) {
    amountNano = amountFromDecodedFallback;
    if (amountNano) {
      amountSource = "decoded_fallback";
    }
  }

  if (!amountNano) {
    amountNano = amountFromIn;
    if (amountNano) {
      amountSource = "input_message";
    }
  }

  if (!amountNano) {
    amountNano = normalizeAmount(extractValue(transaction));
    if (amountNano) {
      amountSource = "transaction";
    }
  }

  console.log("[tonClient] amount selection", {
    txHash,
    amountNano,
    amountSource,
    amountFromIn,
    amountFromDecodedPriority,
    amountFromDecodedFallback,
    hasPriorityJettonAmount,
  });

  const timeStampRaw =
    typeof transaction.utime === "number"
      ? transaction.utime
      : typeof transaction.timestamp === "number"
      ? transaction.timestamp
      : null;

  return {
    fromWalletAddress: friendlyFrom,
    toWalletAddress: friendlyTo,
    amountNano: amountNano ?? "0",
    timeStamp: timeStampRaw !== null ? timeStampRaw * 1000 : Date.now(),
  };
}
