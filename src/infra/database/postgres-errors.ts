export function isUniqueViolation(error: unknown, constraint: string): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const details = error as { code?: unknown; constraint?: unknown; message?: unknown };
  const message = typeof details.message === "string" ? details.message : "";
  const isUnique = details.code === "23505" || message.includes("duplicate key value");

  return isUnique && (details.constraint === constraint || message.includes(constraint));
}