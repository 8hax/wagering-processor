import { z } from "zod";
import { DomainError } from "../domain/domain-error";

export class InvalidPayloadError extends DomainError {
  override readonly code = "INVALID_PAYLOAD";

  constructor(message: string) {
    super(message);
  }
}

export function parseInput<T extends z.ZodType>(schema: T, input: unknown): z.infer<T> {
  const result = schema.safeParse(input);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `${issue.path.map(String).join(".")}: ${issue.message}`)
      .join("; ");
    throw new InvalidPayloadError(details);
  }
  return result.data;
}