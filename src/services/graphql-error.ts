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
 * `toGraphQLErrorExtensions` helper (see
 * `apis/graphql/src/schemas/applications.ts`). Typed loosely because
 * GraphQL extensions are `Record<string, unknown>` at the wire level —
 * only the fields we actually read are declared.
 */
type ServerExtensions = {
  code?: string;
  fields?: ReadonlyArray<ErrorField>;
};

/**
 * Extract a short internal error string from a GraphQL `ClientError`.
 * Used as the (developer-facing) `message` on the resulting CLI error.
 */
function extractGraphQLError(err: unknown): string {
  if (err instanceof ClientError) {
    const graphqlErrors = err.response.errors;
    if (graphqlErrors?.length) {
      const error = graphqlErrors[0];
      const errorCode = error.extensions?.code;
      return errorCode ? `${error.message} (${errorCode})` : error.message;
    }
  }
  return "An unexpected error occurred";
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
    const graphqlErrors = err.response.errors;
    if (graphqlErrors?.length && graphqlErrors[0].message) {
      return graphqlErrors[0].message;
    }
  }
  return "An unexpected error occurred";
}

/**
 * Pick the most informative `extensions` object from a GraphQL response.
 * Prefers the first error that carries a classification code; otherwise
 * falls back to `errors[0]`. Shields us from minor server reshuffles that
 * move the classified error off the head of the list.
 */
function extractExtensions(err: ClientError): ServerExtensions | undefined {
  const errors = err.response.errors ?? [];
  const withCode = errors.find((e) => typeof e?.extensions?.code === "string");
  const extensions = (withCode ?? errors[0])?.extensions;
  return extensions as ServerExtensions | undefined;
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
      errors: err.response.errors ?? [],
      data: err.response.data ?? null,
    },
  };
}

/**
 * Map a GraphQL / transport error to the correct CLI error class.
 *
 * Server-side mutations on app-registry-api classify failures via
 * `errors[].extensions.code`. Each known code is routed to a dedicated
 * CLI tagged-error class so the JSON envelope reports accurate top-level
 * `code` and `fix` strings rather than collapsing every failure into
 * `NETWORK_ERROR`. Unknown / future codes fall through to `NetworkError`
 * with full HTTP context preserved so agents can still discriminate via
 * the server's original `extensions.code` in `details.response`.
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

  if (code === "VALIDATION_ERROR") {
    return new ValidationError({ message, userMessage, fields: ext?.fields });
  }
  if (code === "AUTH_ERROR" || code === "UNAUTHORIZED") {
    return new AuthenticationError({ message, userMessage, ...ctx });
  }
  if (code === "FORBIDDEN" || code === "INSUFFICIENT_PERMISSIONS") {
    return new ForbiddenError({ message, userMessage, ...ctx });
  }
  if (code === "NOT_FOUND" || code?.endsWith("_NOT_FOUND")) {
    return new NotFoundError({ message, userMessage, ...ctx });
  }
  if (code?.endsWith("_CONFLICT")) {
    return new ConflictError({ message, userMessage, ...ctx });
  }
  if (code === "RATE_LIMIT_EXCEEDED" || code === "RATE_LIMIT") {
    return new RateLimitError({ message, userMessage, ...ctx });
  }
  return new NetworkError({ message, userMessage, ...ctx });
}
