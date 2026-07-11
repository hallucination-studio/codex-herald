export type HeraldErrorCode =
  | "CONFIG_INVALID"
  | "CONFIG_NOT_FOUND"
  | "CONFIG_UNSAFE"
  | "DESTINATION_NOT_FOUND"
  | "HOOK_INPUT_INVALID"
  | "HOOK_INPUT_TOO_LARGE"
  | "SECRET_UNAVAILABLE"
  | "SETUP_EXISTS"
  | "UNSUPPORTED";

export class HeraldError extends Error {
  readonly code: HeraldErrorCode;

  constructor(code: HeraldErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "HeraldError";
    this.code = code;
  }
}

export function isHeraldError(error: unknown): error is HeraldError {
  return error instanceof HeraldError;
}
