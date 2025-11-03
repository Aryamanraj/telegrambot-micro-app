import { ApiRecord } from "../types";

function normalizeIdentifier(value: unknown): string | number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length > 0) {
      return trimmed;
    }
  }
  return null;
}

export function extractIdentifier(
  record: ApiRecord | null,
  keys: string[]
): string | number | null {
  if (!record) return null;

  const visited = new Set<object>();

  const visit = (candidate: any): string | number | null => {
    if (!candidate || typeof candidate !== "object") {
      return null;
    }
    if (visited.has(candidate)) {
      return null;
    }
    visited.add(candidate);

    for (const key of keys) {
      if (Object.prototype.hasOwnProperty.call(candidate, key)) {
        const value = normalizeIdentifier((candidate as any)[key]);
        if (value !== null) {
          return value;
        }
      }
    }

    for (const value of Object.values(candidate)) {
      const nested = visit(value);
      if (nested !== null) {
        return nested;
      }
    }

    return null;
  };

  const root = (record as any).data ?? record;
  const direct = visit(root);
  if (direct !== null) {
    return direct;
  }

  return visit(record);
}
