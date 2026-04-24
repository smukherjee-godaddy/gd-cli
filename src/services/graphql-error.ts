/**
 * Shared GraphQL error-to-CLI-error mapper.
 *
 * Used by every service module that talks to `app-registry-api`
 * (`applications.ts`, `extension/presigned-url.ts`, future additions).
 * Keeping the classification logic here guarantees every GraphQL call
 * produces envelopes with consistent top-level `code` + `fix` values,
 * and makes it trivial to extend the mapping when the server adds new
 * `errors[].extensions.code` values.
 *
 * Contract summary (see `mapGraphQLError` for the full table):
 *   - `VALIDATION_ERROR`                          -> `ValidationError` (forwards `fields`)
 *   - `AUTH_ERROR`, `UNAUTHORIZED`                -> `AuthenticationError`
 *   - `FORBIDDEN`, `INSUFFICIENT_PERMISSIONS`     -> `ForbiddenError`
 *   - `NOT_FOUND`, `*_NOT_FOUND`                  -> `NotFoundError`
 *   - `*_CONFLICT`                                -> `ConflictError`
 *   - `RATE_LIMIT_EXCEEDED`, `RATE_LIMIT`         -> `RateLimitError`
 *   - unknown / future codes / transport failure  -> `NetworkError` (HTTP context preserved)
 *
 * Defensive posture: every wire-shape assumption is runtime-guarded
 * (`typeof`, `Array.isArray`) so a server-side response reshuffle or
 * minor shape drift surfaces as a `NetworkError` fallback, never as a
 * thrown exception inside the CLI.
 */

import { ClientError } from "graphql-request";
import {
  type ApiErrorContext,
  AuthenticationError,
  type CliError,
  ConflictError,
  type ErrorField,
  ForbiddenError,
  NetworkError,
  NotFoundError,
  RateLimitError,
  ValidationError,
} from "../effect/errors";

/**
 * Shape of the `extensions` object emitted by app-registry-api's
 * `toGraphQLErrorExtensions` helper. Typed loosely because GraphQL
 * extensions are `Record<string, unknown>` at the wire level — only the
 * fields we actually read are declared, and each is validated at runtime
 * before use.
 */
type ServerExtensions = {
  code?: string;
  fields?: ReadonlyArray<ErrorField>;
};

/** Untyped wire shape for a single GraphQL error entry. */
type GraphQLErrorEntry = {
  message?: string;
  extensions?: { code?: unknown; fields?: unknown };
};

/**
 * Normalize an untrusted `errors` value to a safe array. Protects every
 * downstream array method (`find`, `map`, index access) from crashing
 * when the server returns a non-array shape (`null`, a string, an object).
 */
function toErrorArray(
  value: unknown,
): ReadonlyArray<GraphQLErrorEntry | undefined> {
  return Array.isArray(value)
    ? (value as ReadonlyArray<GraphQLErrorEntry | undefined>)
    : [];
}

/**
 * Pick the most informative error entry from a GraphQL response.
 *   1. First error with a string `extensions.code`.
 *   2. First error with a non-empty `extensions.fields` array.
 *   3. `errors[0]` as a last resort.
 *
 * Shared by `extractGraphQLError` and `extractExtensions` so the resulting
 * CLI error's `message`, `code`, and `fields` always refer to the same
 * entry — regardless of where the server places the classified error in
 * the `errors` array.
 */
function pickPrimaryError(
  errors: ReadonlyArray<GraphQLErrorEntry | undefined>,
): GraphQLErrorEntry | undefined {
  const withCode = errors.find((e) => typeof e?.extensions?.code === "string");
  if (withCode) return withCode;
  const withFields = errors.find((e) => {
    const fields = e?.extensions?.fields;
    return Array.isArray(fields) && fields.length > 0;
  });
  return withFields ?? errors[0];
}

/**
 * Developer-facing `message` for the resulting CLI error. Uses
 * `pickPrimaryError` so message and classification always come from the
 * same error entry.
 */
function extractGraphQLError(err: unknown): string {
  if (!(err instanceof ClientError)) return "An unexpected error occurred";
  const primary = pickPrimaryError(toErrorArray(err.response.errors));
  if (!primary) return "An unexpected error occurred";
  const code = primary.extensions?.code;
  const suffix = typeof code === "string" ? ` (${code})` : "";
  return `${primary.message ?? "GraphQL error"}${suffix}`;
}

/**
 * Return a safe, user-facing message for a GraphQL error. Avoids leaking
 * internal server details in the top-level envelope `message`; the raw
 * response is still preserved under `details.response` for agents that
 * want to inspect it.
 */
function safeGraphQLUserMessage(err: unknown): string {
  if (err instanceof ClientError) {
    const status = err.response.status;
    if (status === 401)
      return "Authentication failed. Run 'godaddy auth login'.";
    if (status === 403)
      return "Access denied. You may not have permission for this operation in the current environment.";
    if (status === 404) return "The requested resource was not found.";
    if (status && status >= 500)
      return "The server encountered an error. Please try again later.";
    // For 4xx with GraphQL-level error messages, allow the first message
    // through — these are validation-style errors the user can act on.
    const errors = toErrorArray(err.response.errors);
    const first = errors[0]?.message;
    if (typeof first === "string" && first.length > 0) return first;
  }
  return "An unexpected error occurred";
}

/** Same selection as `extractGraphQLError` — see `pickPrimaryError`. */
function extractExtensions(err: ClientError): ServerExtensions | undefined {
  const primary = pickPrimaryError(toErrorArray(err.response.errors));
  return primary?.extensions as ServerExtensions | undefined;
}

/**
 * Populate `ApiErrorContext` from a graphql-request `ClientError`.
 * Surfacing `status` + `responseBody` lets `cli/agent/errors.ts` →
 * `fixForNetworkError` produce tailored GraphQL fix hints and preserves
 * the server's original `extensions.code` in `details.response` for
 * agents that want finer-grained classification than the CLI's
 * tagged-error taxonomy.
 *
 * `responseBody` is shaped as `{ errors, data }` (matching a standard
 * GraphQL response body) rather than as the raw errors array, because
 * the agent-side `hasGraphqlErrors` detector looks for `.errors` under
 * `details.response`. Headers and other non-body fields are intentionally
 * excluded to avoid `Headers`-instance serialization quirks.
 */
function networkContextFromClientError(err: ClientError): ApiErrorContext {
  return {
    status: err.response.status,
    responseBody: {
      errors: toErrorArray(err.response.errors),
      data: err.response.data ?? null,
    },
  };
}

/**
 * Map a GraphQL / transport error to the correct CLI error class.
 *
 * Classification is driven by (a) the top-level `extensions.code` on the
 * selected error entry and (b) any `code` values inside `extensions.fields[]`
 * — app-registry-api emits some classifications only at the field level
 * (e.g. `INVALID_FIELD`, `RATE_LIMIT`). Unknown / future codes fall through
 * to `NetworkError` with full HTTP context preserved so agents can still
 * discriminate via the server's original `extensions.code` in
 * `details.response`.
 */
export function mapGraphQLError(err: unknown): CliError {
  const message = extractGraphQLError(err);
  const userMessage = safeGraphQLUserMessage(err);

  if (!(err instanceof ClientError)) {
    return new NetworkError({ message, userMessage });
  }

  const ctx = networkContextFromClientError(err);
  const ext = extractExtensions(err);
  const code = ext?.code;
  // Runtime guard: `ext.fields` is typed but untrusted at the wire
  // boundary; a non-array value here would crash the subsequent `.map`.
  const fields = Array.isArray(ext?.fields) ? ext.fields : undefined;
  const fieldCodes = (fields ?? [])
    .map((field) => field.code)
    .filter((value): value is string => typeof value === "string");

  if (code === "VALIDATION_ERROR" || fieldCodes.includes("INVALID_FIELD")) {
    return new ValidationError({ message, userMessage, fields });
  }
  if (code === "AUTH_ERROR" || code === "UNAUTHORIZED") {
    return new AuthenticationError({ message, userMessage, ...ctx });
  }
  if (
    code === "FORBIDDEN" ||
    code === "INSUFFICIENT_PERMISSIONS" ||
    fieldCodes.includes("INSUFFICIENT_PERMISSIONS")
  ) {
    return new ForbiddenError({ message, userMessage, ...ctx });
  }
  if (
    code === "NOT_FOUND" ||
    code?.endsWith("_NOT_FOUND") ||
    fieldCodes.some((value) => value.endsWith("_NOT_FOUND"))
  ) {
    return new NotFoundError({ message, userMessage, ...ctx });
  }
  if (
    code?.endsWith("_CONFLICT") ||
    fieldCodes.some((value) => value.endsWith("_CONFLICT"))
  ) {
    return new ConflictError({ message, userMessage, ...ctx });
  }
  if (
    code === "RATE_LIMIT_EXCEEDED" ||
    code === "RATE_LIMIT" ||
    fieldCodes.includes("RATE_LIMIT")
  ) {
    return new RateLimitError({ message, userMessage, ...ctx });
  }
  return new NetworkError({ message, userMessage, ...ctx });
}
