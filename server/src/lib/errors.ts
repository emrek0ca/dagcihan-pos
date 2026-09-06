/** API hata modeli. Istemciye sizdirilan detay bilincli olarak sinirlidir. */
export type ApiErrorCode =
  | 'BAD_REQUEST' | 'VALIDATION' | 'UNAUTHORIZED' | 'FORBIDDEN' | 'NOT_FOUND'
  | 'CONFLICT' | 'RATE_LIMITED' | 'PAYLOAD_TOO_LARGE' | 'TERMINAL_REVOKED'
  | 'TERMINAL_NOT_ACTIVE' | 'IDEMPOTENCY_MISMATCH' | 'INTERNAL' | 'UNAVAILABLE';

const STATUS: Record<ApiErrorCode, number> = {
  BAD_REQUEST: 400, VALIDATION: 422, UNAUTHORIZED: 401, FORBIDDEN: 403,
  NOT_FOUND: 404, CONFLICT: 409, RATE_LIMITED: 429, PAYLOAD_TOO_LARGE: 413,
  TERMINAL_REVOKED: 403, TERMINAL_NOT_ACTIVE: 403, IDEMPOTENCY_MISMATCH: 409,
  INTERNAL: 500, UNAVAILABLE: 503,
};

export class ApiError extends Error {
  readonly code: ApiErrorCode;
  readonly status: number;
  readonly details: Record<string, unknown> | undefined;

  constructor(code: ApiErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = STATUS[code];
    this.details = details;
  }

  toJSON(): Record<string, unknown> {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.details === undefined ? {} : { details: this.details }),
      },
    };
  }
}

export const badRequest = (m: string, d?: Record<string, unknown>) => new ApiError('BAD_REQUEST', m, d);
export const validation = (m: string, d?: Record<string, unknown>) => new ApiError('VALIDATION', m, d);
export const unauthorized = (m = 'Kimlik dogrulanamadi') => new ApiError('UNAUTHORIZED', m);
export const forbidden = (m = 'Yetkiniz yok') => new ApiError('FORBIDDEN', m);
export const notFound = (m = 'Bulunamadi') => new ApiError('NOT_FOUND', m);
export const conflict = (m: string, d?: Record<string, unknown>) => new ApiError('CONFLICT', m, d);
