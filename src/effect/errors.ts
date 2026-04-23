import * as Data from "effect/Data";

/**
 * Structured per-field validation detail, mirroring app-registry-api's
 * `@repo/errors` `ErrorField` shape. Forwarded from the GraphQL
 * `extensions.fields` entries when a mutation returns a `ValidationError`.
 */
export interface ErrorField {
  readonly code: string;
  readonly message?: string;
  readonly path?: string;
  readonly pathRelated?: string;
  readonly value?: unknown;
}

export class ValidationError extends Data.TaggedError("ValidationError")<{
  readonly message: string;
  readonly userMessage: string;
  readonly fields?: ReadonlyArray<ErrorField>;
}> {}

export interface ApiErrorContext {
  readonly status?: number;
  readonly statusText?: string;
  readonly endpoint?: string;
  readonly method?: string;
  readonly requestId?: string;
  readonly responseBody?: unknown;
}

export class NetworkError extends Data.TaggedError("NetworkError")<
  {
    readonly message: string;
    readonly userMessage: string;
  } & ApiErrorContext
> {}

export class AuthenticationError extends Data.TaggedError(
  "AuthenticationError",
)<
  {
    readonly message: string;
    readonly userMessage: string;
  } & ApiErrorContext
> {}

/**
 * Caller authenticated successfully but is not permitted to perform the
 * requested action. Mirrors app-registry-api's `ForbiddenError` (wire code
 * `FORBIDDEN`, or `INSUFFICIENT_PERMISSIONS` when emitted as a per-field
 * entry). Kept distinct from `AuthenticationError` so the JSON envelope can
 * recommend a permission-fix (not a re-login).
 */
export class ForbiddenError extends Data.TaggedError("ForbiddenError")<
  {
    readonly message: string;
    readonly userMessage: string;
  } & ApiErrorContext
> {}

/**
 * Requested resource does not exist. Mirrors app-registry-api's
 * `NotFoundError` (wire code `NOT_FOUND`, with a per-resource
 * `<RESOURCE>_NOT_FOUND` entry in `extensions.fields`). Thrown by the
 * `update`, `enable`, and `archive` application mutations when the target
 * application (or a related resource) cannot be located.
 */
export class NotFoundError extends Data.TaggedError("NotFoundError")<
  {
    readonly message: string;
    readonly userMessage: string;
  } & ApiErrorContext
> {}

/**
 * Request conflicts with the current state of the resource. Mirrors
 * app-registry-api's `ConflictError`, whose wire code is always of the
 * form `<CONFLICTTYPE>_CONFLICT` (e.g. `DUPLICATE_CONFLICT`,
 * `STATE_CONFLICT`, `VERSION_CONFLICT`). Thrown by `archive` when the
 * application is in an incompatible state for the operation.
 */
export class ConflictError extends Data.TaggedError("ConflictError")<
  {
    readonly message: string;
    readonly userMessage: string;
  } & ApiErrorContext
> {}

/**
 * Request was rate limited. Mirrors app-registry-api's `RateLimitError`
 * (wire code `RATE_LIMIT_EXCEEDED`, with a per-field `RATE_LIMIT` entry).
 * Reachable from the application `create` path when the downstream OAuth
 * client classifier maps a 429 response via `errorForStatus`.
 */
export class RateLimitError extends Data.TaggedError("RateLimitError")<
  {
    readonly message: string;
    readonly userMessage: string;
  } & ApiErrorContext
> {}

export class ConfigurationError extends Data.TaggedError("ConfigurationError")<{
  readonly message: string;
  readonly userMessage: string;
}> {}

export class SecurityError extends Data.TaggedError("SecurityError")<{
  readonly message: string;
  readonly userMessage: string;
}> {}

export type CliError =
  | ValidationError
  | NetworkError
  | AuthenticationError
  | ForbiddenError
  | NotFoundError
  | ConflictError
  | RateLimitError
  | ConfigurationError
  | SecurityError;

export function errorCode(error: CliError): string {
  switch (error._tag) {
    case "ValidationError":
      return "VALIDATION_ERROR";
    case "NetworkError":
      return "NETWORK_ERROR";
    case "AuthenticationError":
      return "AUTH_ERROR";
    case "ForbiddenError":
      return "FORBIDDEN";
    case "NotFoundError":
      return "NOT_FOUND";
    case "ConflictError":
      return "CONFLICT";
    case "RateLimitError":
      return "RATE_LIMITED";
    case "ConfigurationError":
      return "CONFIG_ERROR";
    case "SecurityError":
      return "SECURITY_BLOCKED";
  }
}
