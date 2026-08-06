import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { updateQoderModelsCache } from "../models.js";
import { autoLoginQoderFromEnvironment, getCachedCredentials, getQoderPatForMode } from "../oauth.js";
import { credentialsFromPat } from "../pat.js";

vi.mock("@earendil-works/pi-coding-agent", () => ({
  AuthStorage: {
    create: vi.fn(() => ({ set: vi.fn(), get: vi.fn() })),
  },
}));

vi.mock("../pat.js", () => ({
  credentialsFromPat: vi.fn().mockResolvedValue({
    access: "mock-access-token",
    refresh: "mock-refresh-token",
    expires: Date.now() + 3600000,
    userID: "mock-user-123",
    email: "test@example.com",
    name: "Test User",
    machineID: "mock-machine-id",
    type: "oauth",
  }),
  isPatRefresh: vi.fn().mockReturnValue(false),
  decodePatRefresh: vi.fn(),
}));

vi.mock("../models.js", () => ({
  updateQoderModelsCache: vi.fn().mockResolvedValue(undefined),
  getCachedModels: vi.fn().mockReturnValue([]),
  isCacheStale: vi.fn().mockReturnValue(true),
  staticModels: [],
  staticCnModels: [],
}));

describe("oauth autoLoginQoderFromEnvironment", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("extracts PAT correctly from env for global and CN mode", () => {
    delete process.env.QODER_API_KEY;
    delete process.env.QODER_PAT;
    process.env.QODER_PERSONAL_ACCESS_TOKEN = "pt-global-123";
    expect(getQoderPatForMode("global")).toBe("pt-global-123");

    delete process.env.QODERCN_API_KEY;
    delete process.env.QODERCN_PAT;
    process.env.QODERCN_PERSONAL_ACCESS_TOKEN = "pt-cn-456";
    expect(getQoderPatForMode("cn")).toBe("pt-cn-456");
  });

  it("does nothing if no PAT in environment", async () => {
    delete process.env.QODER_PERSONAL_ACCESS_TOKEN;
    delete process.env.QODER_API_KEY;
    delete process.env.QODER_PAT;

    await autoLoginQoderFromEnvironment("qoder-test-provider", "global");
    expect(getCachedCredentials("mock-token", "qoder-test-provider")).toBeNull();
  });

  it("re-exchanges an environment PAT even when cached credentials exist", async () => {
    delete process.env.QODER_API_KEY;
    delete process.env.QODER_PAT;
    process.env.QODER_PERSONAL_ACCESS_TOKEN = "pt-global-new-account";

    await autoLoginQoderFromEnvironment("qoder-test-provider", "global");

    expect(credentialsFromPat).toHaveBeenCalledWith("pt-global-new-account", "global");
    expect(updateQoderModelsCache).toHaveBeenCalledWith(
      "mock-access-token",
      "mock-user-123",
      "Test User",
      "test@example.com",
      "global",
    );
  });
});
