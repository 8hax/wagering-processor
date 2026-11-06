import { DomainError } from "../domain/domain-error";

export class InvalidCursorError extends DomainError {
  override readonly code = "INVALID_CURSOR";

  constructor() {
    super("cursor is invalid");
  }
}

export interface PageCursor {
  createdAt: string;
  id: string;
}

export function encodeCursor(cursor: PageCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

export function decodeCursor(raw: string): PageCursor {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "createdAt" in parsed &&
      "id" in parsed &&
      typeof parsed.createdAt === "string" &&
      typeof parsed.id === "string" &&
      !Number.isNaN(Date.parse(parsed.createdAt))
    ) {
      return { createdAt: parsed.createdAt, id: parsed.id };
    }
  } catch {
    // cai no erro abaixo
  }
  throw new InvalidCursorError();
}