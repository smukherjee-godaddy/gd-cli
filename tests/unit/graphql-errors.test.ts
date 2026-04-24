import * as Exit from "effect/Exit";
import { HttpResponse, graphql } from "msw";
import { describe, expect, test } from "vitest";
import { mapRuntimeError } from "../../src/cli/agent/errors";
import type {
  AuthenticationError,
  CliError,
  ConflictError,
  ForbiddenError,
  NetworkError,
  NotFoundError,
  RateLimitError,
  ValidationError,
} from "../../src/effect/errors";
import { getApplicationEffect } from "../../src/services/applications";
import { extractFailure, runEffectExit } from "../setup/effect-test-utils";
import { server } from "../setup/msw-server";
import { withNoAuth, withValidAuth } from "../setup/test-utils";

type GraphQLMockError = {
  message: string;
  extensions?: Record<string, unknown>;
};

function mockGraphQLErrorResponse(
  error: GraphQLMockError | GraphQLMockError[],
) {
  const errors = Array.isArray(error) ? error : [error];
  server.use(
    graphql.operation(() =>
      HttpResponse.json({ data: null, errors }, { status: 200 }),
    ),
  );
}

describe("GraphQL Error Handling", () => {
  test("handles authentication error", async () => {
    withNoAuth();

    const exit = await runEffectExit(
      getApplicationEffect("test-app-1", { accessToken: null }),
    );
    const err = extractFailure(exit) as { message: string };
    expect(err.message).toContain("Access token is required");
  });

  test("handles validation errors", async () => {
    withValidAuth();

    mockGraphQLErrorResponse({
      message: "Validation failed",
      extensions: {
        code: "VALIDATION_ERROR",
        fieldErrors: { name: ["Name is required"] },
      },
    });

    const exit = await runEffectExit(
      getApplicationEffect("", { accessToken: "test-token-123" }),
    );
    const err = extractFailure(exit) as { message: string };
    expect(err.message).toContain("Validation failed");
  });

  test("handles server errors", async () => {
    withValidAuth();

    mockGraphQLErrorResponse({ message: "Internal server error" });

    const exit = await runEffectExit(
      getApplicationEffect("test-app-1", { accessToken: "test-token-123" }),
    );
    const err = extractFailure(exit) as { message: string };
    expect(err.message).toContain("Internal server error");
  });

  test("handles network errors", async () => {
    withValidAuth();

    server.use(
      graphql.operation(() => {
        return HttpResponse.error();
      }),
    );

    const exit = await runEffectExit(
      getApplicationEffect("test-app-1", { accessToken: "test-token-123" }),
    );
    expect(Exit.isFailure(exit)).toBe(true);
  });
});

describe("GraphQL error → CLI error class mapping", () => {
  // Server-side errors carry a classification in extensions.code. The CLI
  // should preserve that classification so the JSON envelope reports a
  // useful code and fix string, rather than collapsing every server error
  // into NETWORK_ERROR.

  test("VALIDATION_ERROR extensions code → ValidationError", async () => {
    withValidAuth();

    mockGraphQLErrorResponse({
      message: "Validation failed: url: Invalid URL",
      extensions: { code: "VALIDATION_ERROR" },
    });

    const exit = await runEffectExit(
      getApplicationEffect("x", { accessToken: "test-token-123" }),
    );
    const err = extractFailure(exit) as CliError;
    expect(err._tag).toBe("ValidationError");
    expect(err.message).toContain("Validation failed");
  });

  test("VALIDATION_ERROR forwards extensions.fields onto ValidationError", async () => {
    withValidAuth();

    const fields = [
      {
        code: "INVALID_FIELD",
        message: "URL must use HTTPS protocol",
        path: "url",
        value: "http://example.com",
      },
      {
        code: "INVALID_FIELD",
        message: "Name must not be empty",
        path: "name",
      },
    ];

    mockGraphQLErrorResponse({
      message: "Validation failed",
      extensions: { code: "VALIDATION_ERROR", fields },
    });

    const exit = await runEffectExit(
      getApplicationEffect("x", { accessToken: "test-token-123" }),
    );
    const err = extractFailure(exit) as ValidationError;
    expect(err._tag).toBe("ValidationError");
    expect(err.fields).toEqual(fields);
  });

  test.each(["AUTH_ERROR", "UNAUTHORIZED"])(
    "%s extensions code → AuthenticationError",
    async (code) => {
      withValidAuth();

      mockGraphQLErrorResponse({
        message: `Denied: ${code}`,
        extensions: { code },
      });

      const exit = await runEffectExit(
        getApplicationEffect("x", { accessToken: "test-token-123" }),
      );
      const err = extractFailure(exit) as AuthenticationError;
      expect(err._tag).toBe("AuthenticationError");
      expect(err.status).toBe(200);
      expect(err.responseBody).toBeDefined();

      const envelope = mapRuntimeError(err);
      expect(envelope.code).toBe("AUTH_REQUIRED");
      expect(envelope.fix).toContain("godaddy auth login");
    },
  );

  test.each(["FORBIDDEN", "INSUFFICIENT_PERMISSIONS"])(
    "%s extensions code → ForbiddenError",
    async (code) => {
      // FORBIDDEN and INSUFFICIENT_PERMISSIONS are authorization failures
      // (the caller is authenticated but lacks the required permission).
      // They must surface as a distinct CLI class so the envelope points at
      // a permission fix, not a re-login.
      withValidAuth();

      mockGraphQLErrorResponse({
        message: `Denied: ${code}`,
        extensions: { code },
      });

      const exit = await runEffectExit(
        getApplicationEffect("x", { accessToken: "test-token-123" }),
      );
      const err = extractFailure(exit) as ForbiddenError;
      expect(err._tag).toBe("ForbiddenError");
      expect(err.status).toBe(200);
      expect(err.responseBody).toBeDefined();

      const envelope = mapRuntimeError(err);
      expect(envelope.code).toBe("FORBIDDEN");
      expect(envelope.fix).toMatch(/permission/i);
    },
  );

  test.each(["NOT_FOUND", "APPLICATION_NOT_FOUND", "RELEASE_NOT_FOUND"])(
    "%s extensions code → NotFoundError",
    async (code) => {
      // app-registry-api's NotFoundError emits `code: "NOT_FOUND"` at the
      // top level and `<RESOURCE>_NOT_FOUND` in fields[].code. We match both
      // on the wire so either representation resolves to NotFoundError.
      withValidAuth();

      mockGraphQLErrorResponse({
        message: "Resource not found",
        extensions: { code },
      });

      const exit = await runEffectExit(
        getApplicationEffect("x", { accessToken: "test-token-123" }),
      );
      const err = extractFailure(exit) as NotFoundError;
      expect(err._tag).toBe("NotFoundError");
      expect(err.status).toBe(200);
      expect(err.responseBody).toBeDefined();

      const envelope = mapRuntimeError(err);
      expect(envelope.code).toBe("NOT_FOUND");
      expect(envelope.fix).toContain("godaddy application list");
    },
  );

  test.each(["DUPLICATE_CONFLICT", "STATE_CONFLICT", "VERSION_CONFLICT"])(
    "%s extensions code → ConflictError",
    async (code) => {
      // ConflictError's wire code is always `<CONFLICTTYPE>_CONFLICT`
      // (see app-registry-api packages/errors/src/conflict-error.ts).
      // `archive` throws these when the app is in an incompatible state.
      withValidAuth();

      mockGraphQLErrorResponse({
        message: `Conflict: ${code}`,
        extensions: { code },
      });

      const exit = await runEffectExit(
        getApplicationEffect("x", { accessToken: "test-token-123" }),
      );
      const err = extractFailure(exit) as ConflictError;
      expect(err._tag).toBe("ConflictError");
      expect(err.status).toBe(200);
      expect(err.responseBody).toBeDefined();

      const envelope = mapRuntimeError(err);
      expect(envelope.code).toBe("CONFLICT");
      expect(envelope.fix).toMatch(/conflict/i);
    },
  );

  test.each(["RATE_LIMIT_EXCEEDED", "RATE_LIMIT"])(
    "%s extensions code → RateLimitError",
    async (code) => {
      // RateLimitError emits `code: "RATE_LIMIT_EXCEEDED"` at top level and
      // `code: "RATE_LIMIT"` in fields[]. Reachable from application `create`
      // when the downstream OAuth client classifier maps a 429 via
      // `errorForStatus`. Match both forms for robustness.
      withValidAuth();

      mockGraphQLErrorResponse({
        message: "Rate limited",
        extensions: { code },
      });

      const exit = await runEffectExit(
        getApplicationEffect("x", { accessToken: "test-token-123" }),
      );
      const err = extractFailure(exit) as RateLimitError;
      expect(err._tag).toBe("RateLimitError");
      expect(err.status).toBe(200);
      expect(err.responseBody).toBeDefined();

      const envelope = mapRuntimeError(err);
      expect(envelope.code).toBe("RATE_LIMITED");
      expect(envelope.fix).toMatch(/rate limit/i);
    },
  );

  test("unknown extensions code → NetworkError with HTTP context preserved", async () => {
    withValidAuth();

    mockGraphQLErrorResponse({
      message: "Something went wrong",
      extensions: { code: "OAUTH_CLIENT_UPSTREAM_ERROR" },
    });

    const exit = await runEffectExit(
      getApplicationEffect("x", { accessToken: "test-token-123" }),
    );
    const err = extractFailure(exit) as NetworkError;
    expect(err._tag).toBe("NetworkError");
    expect(err.status).toBe(200);
    // Original server code is preserved so agents can still discriminate.
    expect(JSON.stringify(err.responseBody)).toContain(
      "OAUTH_CLIENT_UPSTREAM_ERROR",
    );
  });

  test("no extensions code → NetworkError (default) with HTTP context", async () => {
    withValidAuth();

    mockGraphQLErrorResponse({ message: "Internal server error" });

    const exit = await runEffectExit(
      getApplicationEffect("x", { accessToken: "test-token-123" }),
    );
    const err = extractFailure(exit) as NetworkError;
    expect(err._tag).toBe("NetworkError");
    expect(err.status).toBe(200);
    expect(err.responseBody).toBeDefined();
  });

  test("classified error is picked even when errors[0] lacks a code", async () => {
    // Regression: `message` and `_tag` must come from the same error entry.
    // A prior implementation read `message` from `errors[0]` while picking
    // `extensions.code` from a later entry, producing correctly-tagged CLI
    // errors with an unrelated message attached.
    withValidAuth();

    mockGraphQLErrorResponse([
      { message: "Partial failure without a code" },
      {
        message: "Validation failed: url: Invalid URL",
        extensions: { code: "VALIDATION_ERROR" },
      },
    ]);

    const exit = await runEffectExit(
      getApplicationEffect("x", { accessToken: "test-token-123" }),
    );
    const err = extractFailure(exit) as CliError;
    expect(err._tag).toBe("ValidationError");
    expect(err.message).toContain("Validation failed: url: Invalid URL");
    expect(err.message).toContain("VALIDATION_ERROR");
    expect(err.message).not.toContain("Partial failure without a code");
  });

  test("no error carries a code → NetworkError with errors[0].message", async () => {
    // Sub-case of the above: when nothing classifies, fall back to errors[0]
    // consistently for both tag and message.
    withValidAuth();

    mockGraphQLErrorResponse([
      { message: "First failure without a code" },
      { message: "Second failure also without a code" },
    ]);

    const exit = await runEffectExit(
      getApplicationEffect("x", { accessToken: "test-token-123" }),
    );
    const err = extractFailure(exit) as CliError;
    expect(err._tag).toBe("NetworkError");
    expect(err.message).toContain("First failure without a code");
    expect(err.message).not.toContain("Second failure");
  });

  test("non-array extensions.fields does not crash the mapper", async () => {
    // Defensive: if the server sends a malformed `fields` (e.g. string or
    // object instead of array), classification must not throw inside `.map`.
    // Falls through to NetworkError since no classification can be derived.
    withValidAuth();

    mockGraphQLErrorResponse({
      message: "Shape drift from upstream",
      extensions: {
        fields: "not-an-array" as unknown as Record<string, unknown>,
      },
    });

    const exit = await runEffectExit(
      getApplicationEffect("x", { accessToken: "test-token-123" }),
    );
    const err = extractFailure(exit) as CliError;
    expect(err._tag).toBe("NetworkError");
    expect(err.message).toContain("Shape drift from upstream");
  });

  test.each<{ fieldCode: string; expectedTag: CliError["_tag"] }>([
    { fieldCode: "INVALID_FIELD", expectedTag: "ValidationError" },
    { fieldCode: "INSUFFICIENT_PERMISSIONS", expectedTag: "ForbiddenError" },
    { fieldCode: "APPLICATION_NOT_FOUND", expectedTag: "NotFoundError" },
    { fieldCode: "STATE_CONFLICT", expectedTag: "ConflictError" },
    { fieldCode: "RATE_LIMIT", expectedTag: "RateLimitError" },
  ])(
    "field-level code $fieldCode classifies to $expectedTag",
    async ({ fieldCode, expectedTag }) => {
      // app-registry-api emits some classifications only via
      // `extensions.fields[].code`, with no top-level `extensions.code`.
      // The mapper must honor both placements.
      withValidAuth();

      mockGraphQLErrorResponse({
        message: `Field-level ${fieldCode}`,
        extensions: {
          fields: [{ code: fieldCode, message: "details", path: "x" }],
        },
      });

      const exit = await runEffectExit(
        getApplicationEffect("x", { accessToken: "test-token-123" }),
      );
      const err = extractFailure(exit) as CliError;
      expect(err._tag).toBe(expectedTag);
    },
  );

  test("unclassified server code produces GraphQL-aware fix string in envelope", async () => {
    // End-to-end check: the NetworkError fallback branch must carry a
    // responseBody shape that the agent-side `hasGraphqlErrors` detector
    // recognizes (`{ errors: [...] }`), so agents get the tailored GraphQL
    // remediation hint rather than the generic connectivity fallback.
    withValidAuth();

    mockGraphQLErrorResponse({
      message: "Upstream OAuth client failure",
      extensions: { code: "OAUTH_CLIENT_UPSTREAM_ERROR" },
    });

    const exit = await runEffectExit(
      getApplicationEffect("x", { accessToken: "test-token-123" }),
    );
    const err = extractFailure(exit);
    const mapped = mapRuntimeError(err);
    expect(mapped.code).toBe("NETWORK_ERROR");
    expect(mapped.fix).toContain("error.details.response.errors");
    expect(JSON.stringify(mapped.details?.response)).toContain(
      "OAUTH_CLIENT_UPSTREAM_ERROR",
    );
  });

  test("transport failure (no ClientError) → NetworkError without HTTP context", async () => {
    withValidAuth();

    server.use(
      graphql.operation(() => {
        return HttpResponse.error();
      }),
    );

    const exit = await runEffectExit(
      getApplicationEffect("x", { accessToken: "test-token-123" }),
    );
    const err = extractFailure(exit) as NetworkError;
    expect(err._tag).toBe("NetworkError");
    // No HTTP context is available for raw transport failures.
    expect(err.status).toBeUndefined();
    expect(err.responseBody).toBeUndefined();
  });
});
