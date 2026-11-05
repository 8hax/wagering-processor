import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  Logger,
} from "@nestjs/common";
import { DomainError } from "../domain/domain-error";

interface HttpResponse {
  status(code: number): { json(body: unknown): void };
}

const STATUS_BY_CODE: Readonly<Record<string, number>> = {
  INVALID_MONEY: 400,
  INVALID_PAYLOAD: 400,
  CURRENCY_MISMATCH: 422,
  INVALID_WALLET_OPERATION: 422,
  INSUFFICIENT_FUNDS: 422,
  WALLET_NOT_FOUND: 404,
  WALLET_ALREADY_EXISTS: 409,
};

const TRANSIENT_ERROR_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "57P01",
  "53300",
  "40001",
  "40P01",
]);

@Catch()
export class HttpErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpErrorFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<HttpResponse>();

    if (exception instanceof DomainError) {
      const status = STATUS_BY_CODE[exception.code] ?? 500;
      response.status(status).json({ code: exception.code, message: exception.message });
      return;
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const payload = exception.getResponse();
      const body = typeof payload === "object" && payload !== null ? payload : { message: payload };
      response.status(status).json({ code: `HTTP_${status}`, ...body });
      return;
    }

    if (isTransientInfrastructureError(exception)) {
      this.logger.warn("transient infrastructure failure");
      response.status(503).json({
        code: "SERVICE_UNAVAILABLE",
        message: "temporary infrastructure failure, retry later",
      });
      return;
    }

    this.logger.error(
      "unexpected error",
      exception instanceof Error ? exception.stack : undefined,
    );
    response.status(500).json({ code: "INTERNAL_ERROR", message: "unexpected internal error" });
  }
}

function isTransientInfrastructureError(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return false;
  }
  const code = (error as { code: unknown }).code;
  return typeof code === "string" && TRANSIENT_ERROR_CODES.has(code);
}