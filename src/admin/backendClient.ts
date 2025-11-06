import BigNumber from "bignumber.js";

import { backendBaseUrl, pollApiKey } from "./config";
import {
  ApiRecord,
  BackendTransactionPayload,
  CapState,
  CapSummary,
  PepeTransactionPayload,
} from "./types";

function mapCapStateToBackend(
  state: CapState
): "BOUGHT" | "LISTED" | "SOLD" | "ERROR" {
  switch (state) {
    case "REJECTED":
    case "SOLD_REJECTED":
      return "ERROR";
    case "APPROVED_SOLD":
    case "SOLD_PUBLISHED":
    case "SOLD_APPROVED":
      return "SOLD";
    case "PARTIAL_PUBLISHED":
      return "BOUGHT";
    case "PUBLISHED":
    case "APPROVED":
      return "LISTED";
    default:
      return "LISTED";
  }
}

export function tonToNano(value: string | null | undefined): string {
  try {
    const amount = new BigNumber(value ?? 0);
    if (!amount.isFinite() || amount.lt(0)) {
      return "0";
    }
    return amount
      .multipliedBy(10 ** 9)
      .integerValue(BigNumber.ROUND_FLOOR)
      .toString(10);
  } catch (_error) {
    return "0";
  }
}

async function sendJson(
  method: "POST" | "PATCH",
  url: string,
  body: unknown
): Promise<ApiRecord> {
  const response = await fetch(url, {
    method,
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "x-api-key": pollApiKey,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `${method} ${url} failed with HTTP ${response.status}: ${text}`
    );
  }

  try {
    return (await response.json()) as ApiRecord;
  } catch (error) {
    throw new Error(`Failed to parse JSON response from ${url}`);
  }
}

async function postJson(url: string, body: unknown): Promise<ApiRecord> {
  return sendJson("POST", url, body);
}

async function patchJson(url: string, body: unknown): Promise<ApiRecord> {
  return sendJson("PATCH", url, body);
}

export async function createBackendTransaction(
  payload: BackendTransactionPayload
): Promise<ApiRecord> {
  console.log(
    `Creating ${payload.txType} transaction record for hash ${payload.txHash}`
  );
  return postJson(`${backendBaseUrl}/capStr/transactions`, payload);
}

export async function createPepeTransaction(
  payload: PepeTransactionPayload
): Promise<ApiRecord> {
  console.log(
    `Creating PepeStr transaction record for gift ${payload.giftId} with hash ${
      payload.txHash ?? "<none>"
    }`
  );
  return postJson(`${backendBaseUrl}/pepeStr/transactions`, payload);
}

export async function createTransactionRecord(
  cap: CapSummary
): Promise<ApiRecord> {
  const payload = {
    txHash: cap.txHash,
    fromWalletAddress: cap.fromWalletAddress,
    toWalletAddress: cap.toWalletAddress,
    giftId: cap.giftId ?? 0,
    currency: "TON",
    amount: tonToNano(cap.buyPriceTon),
    txType: "BUY",
    timeStamp: cap.buyTime,
  };

  return createBackendTransaction(payload);
}

export async function createSellTransactionRecord(
  cap: CapSummary,
  saleTime: number
): Promise<ApiRecord> {
  const payload: BackendTransactionPayload = {
    txHash: cap.txHash,
    fromWalletAddress: cap.fromWalletAddress,
    toWalletAddress: cap.toWalletAddress,
    giftId: cap.giftId ?? 0,
    currency: "TON",
    amount: tonToNano(cap.salePriceTon),
    txType: "SELL",
    timeStamp: saleTime,
  };

  return createBackendTransaction(payload);
}

export async function createCapRecord(
  cap: CapSummary,
  state: CapState,
  buyTransactionId: string | number
): Promise<ApiRecord> {
  const payload = {
    giftId: cap.giftId,
    url: cap.getGemsUrl,
    boughtFor: tonToNano(cap.buyPriceTon),
    listedFor: tonToNano(cap.salePriceTon),
    capStrCapState: mapCapStateToBackend(state),
    buyDate: cap.buyTime,
    sellDate: cap.saleTime ?? null,
    buyTransactionId,
  };

  console.log(
    `Creating cap record for cap ${cap.offchainGetgemsAddress} using transaction ${buyTransactionId}`
  );
  return postJson(`${backendBaseUrl}/capStr/caps`, payload);
}

export async function patchCapSellTransaction(
  capStrCapId: string | number,
  sellTransactionId: string | number,
  sellDate: number
): Promise<ApiRecord> {
  const payload = {
    sellTransactionId,
    sellDate,
    capStrCapState: "SOLD",
  };
  console.log(
    `Updating CapStr cap ${capStrCapId} with sell transaction ${sellTransactionId} at ${sellDate}`
  );
  return patchJson(
    `${backendBaseUrl}/capStr/caps/${capStrCapId}`,
    payload
  );
}

export async function markCapAsSold(
  giftNumber: number,
  soldForNano: string,
  sellDate: number,
  sellTransactionId: string | number
): Promise<ApiRecord> {
  const payload = {
    soldFor: soldForNano,
    capStrCapState: "SOLD",
    sellDate,
    sellTransactionId,
  };
  console.log(
    `Marking cap ${giftNumber} as sold with transaction ${sellTransactionId}`
  );
  return patchJson(
    `${backendBaseUrl}/capStr/capsSold/${giftNumber}`,
    payload
  );
}
