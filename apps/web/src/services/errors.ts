export type ServiceErrorCode =
  | "permission_denied"
  | "not_found"
  | "unavailable"
  | "invalid_data"
  | "conflict"
  | "invalid_input"
  | "out_of_scope";

export class ServiceError extends Error {
  constructor(
    readonly code: ServiceErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ServiceError";
  }
}

export const errorCode = (e: unknown): ServiceErrorCode =>
  e instanceof ServiceError ? e.code : "unavailable";
