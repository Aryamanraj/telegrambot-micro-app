import BigNumber from "bignumber.js";

import { backendBaseUrl, pollApiKey } from "./config";
import {
  ApiRecord,
  BackendTransactionPayload,
  CapState,
  CapSummary,
  PepeTransactionPayload,
} from "./types";

function mapCapStateToBackend(state: CapState): "BOUGHT" | "LISTED" | "SOLD" | "ERROR" {
  switch (state) {
    case "REJECTED":
      return "ERROR";
    case "PARTIAL_PUBLISHED":
    case "PUBLISHED":
    case "APPROVED":
      return "LISTED";
    default:
      return "LISTED";
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
    amount:
      new BigNumber(cap.buyPriceTon).multipliedBy(10 ** 9).toString() ??
      new BigNumber(0).toString(),
    txType: "BUY",
    timeStamp: cap.buyTime,
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
    boughtFor: new BigNumber(cap.buyPriceTon).multipliedBy(10 ** 9).toString(),
    listedFor: new BigNumber(cap.salePriceTon).multipliedBy(10 ** 9).toString(),
    capStrCapState: mapCapStateToBackend(state),
    buyDate: cap.buyTime,
    sellDate: null,
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
