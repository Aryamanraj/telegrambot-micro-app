import { CapState, CapSummary, PepeGiftSummary } from "./types";

export const editableFields = [
  "Getgems Address",
  "Name",
  "Record Type",
  "Buy Price",
  "Sale Price",
  "Buy Time (UTC)",
  "GetGems URL",
  "Link to Gift",
  "Tx Hash",
  "Seller Wallet",
  "Buyer Wallet",
];

export const fieldToProperty: { [key: string]: string } = {
  "Getgems Address": "offchainGetgemsAddress",
  Name: "name",
  "Record Type": "saleType",
  "Buy Price": "buyPriceTon",
  "Sale Price": "salePriceTon",
  "Buy Time (UTC)": "buyTime",
  "GetGems URL": "getGemsUrl",
  "Link to Gift": "onchainAddress",
  "Tx Hash": "txHash",
  "Seller Wallet": "fromWalletAddress",
  "Buyer Wallet": "toWalletAddress",
};

function saleTypeFormatter(saleType: string): string {
  switch (saleType.toLowerCase()) {
    case "auction":
      return "Auction";
    case "nftsalefixprice":
    case "fixpricesale":
      return "Sale";
    case "putupforsale":
      return "Listed";
    case "transfer":
      return "Transferred";
    default:
      return saleType;
  }
}

function knownAddressFormatter(address: string): string {
  if (
    address === "EQDp00TOpFDpJ0IvBgIn6rOUiCQeNZQSAPzI7kNPT65pjyr2" ||
    address === "UQDp00TOpFDpJ0IvBgIn6rOUiCQeNZQSAPzI7kNPT65pj3cz"
  ) {
    return "capstrategy.ton";
  }
  return address;
}

export function buildActionKeyboard(capAddress: string) {
  return {
    inline_keyboard: [
      [
        { text: "Approve", callback_data: `approve_${capAddress}` },
        { text: "Edit", callback_data: `edit_${capAddress}` },
        { text: "Reject", callback_data: `reject_${capAddress}` },
      ],
    ],
  };
}

export function buildFieldSelectionKeyboard() {
  const keyboard: { text: string; callback_data: string }[][] = [];
  for (let i = 0; i < editableFields.length; i += 3) {
    const row: { text: string; callback_data: string }[] = [];
    for (let j = i; j < Math.min(i + 3, editableFields.length); j += 1) {
      row.push({ text: editableFields[j], callback_data: `select_field_${j}` });
    }
    keyboard.push(row);
  }
  return keyboard;
}

export function buildAlertMessage(
  cap: CapSummary,
  state: CapState,
  isEdited: boolean = false
): string {
  const saleDate = new Date(cap.buyTime)
    .toISOString()
    .replace("T", " ")
    .replace(/\.\d{3}Z$/, " UTC");
  let heading = "<b>🚨 New Cap Detected</b>";
  const headerLines: string[] = [];
  if (state === "APPROVED") {
    heading = "<b>✅ Cap Published</b>";
    headerLines.push(
      '<b>Live at:</b> <a href="https://capstrategy.fun">capstrategy.fun</a>'
    );
  } else if (state === "REJECTED") {
    heading = "<b>⛔ Rejected Cap</b>";
  } else if (isEdited) {
    heading = "<b>✏️ Edited Cap</b>";
  }

  const lines: string[] = [heading, ...headerLines, ""];

  lines.push(
    `<b>Getgems Address:</b> <code>${cap.offchainGetgemsAddress}</code>`,
    `<b>Name:</b> ${cap.name ?? "N/A"}`,
    "",
    `<b>Record Type:</b> ${saleTypeFormatter(cap.saleType) ?? "N/A"}`,
    `<b>Buy Price:</b> ${cap.buyPriceTon ?? "N/A"} TON`,
    `<b>Sale Price:</b> ${cap.salePriceTon ?? "N/A"} TON`,
    "",
    `<b>Buy Time (UTC):</b> ${saleDate} (${cap.buyTime / 1000})`,
    `<b>GetGems URL:</b> <a href="${cap.getGemsUrl}">View on GetGems</a>`,
    `<b>Link to Gift:</b> ${
      cap.onchainAddress
        ? `<a href="https://tonviewer.com/${cap.onchainAddress}">View on Tonviewer</a>`
        : "Offchain Gift"
    }`,
    "",
    `<b>Tx Hash:</b> <code>${cap.txHash}</code>`,
    `<b>Seller Wallet:</b> <code>${knownAddressFormatter(
      cap.fromWalletAddress
    )}</code>`,
    `<b>Buyer Wallet:</b> <code>${knownAddressFormatter(
      cap.toWalletAddress
    )}</code>`
  );

  return lines.join("\n");
}

export function buildPepeAlertMessage(gift: PepeGiftSummary): string {
  const saleDate = new Date(gift.buyTime)
    .toISOString()
    .replace("T", " ")
    .replace(/\.\d{3}Z$/, " UTC");

  const lines: string[] = ["<b>🐸 New Pepe Gift Detected</b>", ""];

  lines.push(
    `<b>Getgems Address:</b> <code>${gift.offchainGetgemsAddress}</code>`,
    `<b>Name:</b> ${gift.name ?? "N/A"}`,
    `<b>Gift Number:</b> ${
      gift.giftNumber !== null && gift.giftNumber !== undefined
        ? gift.giftNumber
        : "N/A"
    }`,
    "",
    `<b>Record Type:</b> ${gift.saleType ? saleTypeFormatter(gift.saleType) : "N/A"}`,
    `<b>Buy Price:</b> ${gift.buyPriceTon ?? "N/A"} TON`,
    `<b>Sale Price:</b> ${gift.salePriceTon ?? "N/A"} TON`,
    "",
    `<b>Buy Time (UTC):</b> ${saleDate} (${gift.buyTime / 1000})`,
    `<b>GetGems URL:</b> <a href="${gift.getGemsUrl}">View on GetGems</a>`,
    `<b>Link to Gift:</b> <a href="https://tonviewer.com/${gift.onchainAddress}">View on Tonviewer</a>`,
    "",
    `<b>Tx Hash:</b> <code>${gift.txHash}</code>`,
    `<b>Seller Wallet:</b> <code>${knownAddressFormatter(
      gift.fromWalletAddress
    )}</code>`,
    `<b>Buyer Wallet:</b> <code>${knownAddressFormatter(
      gift.toWalletAddress
    )}</code>`
  );

  return lines.join("\n");
}
