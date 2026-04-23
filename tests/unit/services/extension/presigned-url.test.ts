import { getUploadTargetEffect } from "@/services/extension/presigned-url";
import * as Effect from "effect/Effect";
import { ClientError } from "graphql-request";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  extractFailure,
  runEffect,
  runEffectExit,
} from "../../../setup/effect-test-utils";

// Mock logger
vi.mock("@/services/logger", () => ({
  getLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

// Shared mock request function used by the fake GraphQLClient
const mockRequest = vi.fn();

// Mock http-helpers to return a fake GraphQLClient
vi.mock("@/services/http-helpers", () => {
  const Effect = require("effect/Effect");
  return {
    getRequestHeaders: (token: string) => ({
      Authorization: `Bearer ${token}`,
      "X-Request-ID": "test-uuid",
    }),
    makeGraphQLClientEffect: () =>
      Effect.succeed({
        request: mockRequest,
      }),
  };
});

describe("presigned-url service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("getUploadTarget", () => {
    it("should request presigned URL from GraphQL API", async () => {
      mockRequest.mockResolvedValue({
        generateReleaseUploadUrl: {
          uploadId: "test-upload-id",
          url: "https://s3.example.com/presigned-url",
          key: "app/release/extension.js",
          expiresAt: "2025-11-14T16:00:00Z",
          maxSizeBytes: 10485760,
          requiredHeaders: ["content-type:application/javascript"],
        },
      });

      const result = await runEffect(
        getUploadTargetEffect(
          {
            applicationId: "app-123",
            releaseId: "release-456",
            contentType: "JS",
          },
          "test-access-token",
        ),
      );

      expect(result).toEqual({
        uploadId: "test-upload-id",
        url: "https://s3.example.com/presigned-url",
        key: "app/release/extension.js",
        expiresAt: "2025-11-14T16:00:00Z",
        maxSizeBytes: 10485760,
        requiredHeaders: {
          "content-type": "application/javascript",
        },
      });
    });

    it("should default to JS content type", async () => {
      mockRequest.mockResolvedValue({
        generateReleaseUploadUrl: {
          uploadId: "test-upload-id",
          url: "https://s3.example.com/presigned-url",
          key: "app/release/extension.js",
          expiresAt: "2025-11-14T16:00:00Z",
          maxSizeBytes: 10485760,
          requiredHeaders: [],
        },
      });

      await runEffect(
        getUploadTargetEffect(
          {
            applicationId: "app-123",
            releaseId: "release-456",
          },
          "test-access-token",
        ),
      );

      expect(mockRequest).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          input: expect.objectContaining({
            contentType: "JS",
          }),
        }),
        expect.anything(),
      );
    });

    it("should parse multiple required headers correctly", async () => {
      mockRequest.mockResolvedValue({
        generateReleaseUploadUrl: {
          uploadId: "test-upload-id",
          url: "https://s3.example.com/presigned-url",
          key: "app/release/extension.js",
          expiresAt: "2025-11-14T16:00:00Z",
          maxSizeBytes: 10485760,
          requiredHeaders: [
            "content-type:application/javascript",
            "x-amz-meta-upload-id:test-upload-id",
            "x-custom-header:value:with:colons",
          ],
        },
      });

      const result = await runEffect(
        getUploadTargetEffect(
          {
            applicationId: "app-123",
            releaseId: "release-456",
          },
          "test-access-token",
        ),
      );

      expect(result.requiredHeaders).toEqual({
        "content-type": "application/javascript",
        "x-amz-meta-upload-id": "test-upload-id",
        "x-custom-header": "value:with:colons",
      });
    });

    it("should throw error if response is empty", async () => {
      mockRequest.mockResolvedValue({
        generateReleaseUploadUrl: null,
      });

      const exit = await runEffectExit(
        getUploadTargetEffect(
          {
            applicationId: "app-123",
            releaseId: "release-456",
          },
          "test-access-token",
        ),
      );

      const err = extractFailure(exit) as { message: string };
      expect(err.message).toContain(
        "Failed to generate upload URL: empty response",
      );
    });

    // Regression guard: the presigned-URL service must route server-side
    // GraphQL errors through `mapGraphQLError` (not collapse everything
    // into a generic NetworkError). See src/services/graphql-error.ts.
    describe("server error classification (via mapGraphQLError)", () => {
      function rejectWithClientError(
        code: string,
        message = "server error",
        status = 200,
      ) {
        mockRequest.mockRejectedValue(
          new ClientError(
            {
              data: null,
              errors: [{ message, extensions: { code } }],
              status,
              headers: new Headers(),
            },
            { query: "mutation {}" },
          ),
        );
      }

      it.each([
        ["NOT_FOUND", "NotFoundError"],
        ["APPLICATION_NOT_FOUND", "NotFoundError"],
        ["DUPLICATE_CONFLICT", "ConflictError"],
        ["STATE_CONFLICT", "ConflictError"],
        ["FORBIDDEN", "ForbiddenError"],
        ["INSUFFICIENT_PERMISSIONS", "ForbiddenError"],
        ["RATE_LIMIT_EXCEEDED", "RateLimitError"],
        ["VALIDATION_ERROR", "ValidationError"],
        ["AUTH_ERROR", "AuthenticationError"],
      ])("routes %s -> %s", async (code, expectedTag) => {
        rejectWithClientError(code);

        const exit = await runEffectExit(
          getUploadTargetEffect(
            { applicationId: "app-123", releaseId: "release-456" },
            "test-access-token",
          ),
        );
        const err = extractFailure(exit) as { _tag: string };
        expect(err._tag).toBe(expectedTag);
      });

      it("falls back to NetworkError for unknown codes", async () => {
        rejectWithClientError("OAUTH_CLIENT_UPSTREAM_ERROR");

        const exit = await runEffectExit(
          getUploadTargetEffect(
            { applicationId: "app-123", releaseId: "release-456" },
            "test-access-token",
          ),
        );
        const err = extractFailure(exit) as { _tag: string };
        expect(err._tag).toBe("NetworkError");
      });
    });
  });
});
