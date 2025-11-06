export interface CapSummary {
  onchainAddress: string | null;
  offchainGetgemsAddress: string;
  name: string | null;
  capNumber: number | null;
  collectionAddress: string | null;
  image: string | null;
  saleType: string | null;
  buyPriceTon: string | null;
  salePriceTon: string | null;
  detectedAt: number;
  buyTime: number;
  saleTime?: number | null;
  getGemsUrl: string;
  txHash: string;
  fromWalletAddress: string;
  toWalletAddress: string;
  giftId: number;
}

export interface PollResponse {
  readonly success: boolean;
  message: string;
  data?: {
    ownerAddress: string;
    totalCaps: number;
    hasNew: boolean;
  newCaps: CapSummary[];
  hasNewSales?: boolean;
  newSales?: CapSummary[];
    seenCaps: string[];
    polledAt: number;
  };
}

export interface PepeGiftSummary {
  onchainAddress: string;
  offchainGetgemsAddress: string;
  name: string | null;
  giftNumber: number | null;
  collectionAddress: string | null;
  image: string | null;
  saleType: string | null;
  buyPriceTon: string | null;
  salePriceTon: string | null;
  detectedAt: number;
  buyTime: number;
  getGemsUrl: string;
  txHash: string;
  fromWalletAddress: string;
  toWalletAddress: string;
  giftId: number;
}

export interface PepePollResponse {
  readonly success: boolean;
  message: string;
  data?: {
    ownerAddress: string;
    totalGifts: number;
    hasNew: boolean;
    newGifts: PepeGiftSummary[];
    seenGifts: string[];
    polledAt: number;
  };
}

export type CapState =
  | "PARTIAL_PUBLISHED"
  | "PUBLISHED"
  | "APPROVED"
  | "REJECTED"
  | "APPROVED_SOLD"
  | "SOLD_PUBLISHED"
  | "SOLD_APPROVED"
  | "SOLD_REJECTED";

export type ApiRecord = Record<string, unknown>;

export interface BackendTransactionPayload {
  txHash: string;
  fromWalletAddress: string;
  toWalletAddress: string;
  giftId: number;
  currency: string;
  amount: string;
  txType: string;
  timeStamp: number;
}

export interface PepeTransactionPayload {
  txHash?: string;
  fromWalletAddress?: string;
  toWalletAddress?: string;
  giftId: number;
  currency?: string;
  amount?: string;
  txType?: string;
  timeStamp?: number;
}

export interface StoredCap {
  item: CapSummary;
  state: CapState;
  publishedChatIds: number[];
  messageIds: { [chatId: number]: number };
  isEdited: boolean;
  buyTransactionRecord: ApiRecord | null;
  capStrRecord: ApiRecord | null;
  hasManualChanges?: boolean;
  sellTransactionRecord?: ApiRecord | null;
}

export interface RawCapLogEntry {
  receivedAt: number;
  cap: CapSummary;
}

export interface StoredPepeGift {
  item: PepeGiftSummary;
  state: CapState;
  publishedChatIds: number[];
  messageIds: { [chatId: number]: number };
  isEdited: boolean;
}

export interface RawPepeGiftLogEntry {
  receivedAt: number;
  gift: PepeGiftSummary;
}

export interface TonTransactionDetails {
  fromWalletAddress: string;
  toWalletAddress: string;
  amountNano: string;
  timeStamp: number;
}
