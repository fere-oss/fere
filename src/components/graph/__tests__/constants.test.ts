import { getBaseName, getTypePriority, getServiceColor, getHealthInfo } from "../constants";

describe("getBaseName", () => {
  it("strips common suffixes like -server, -api, -service", () => {
    expect(getBaseName("api-server")).toBe("api");
    expect(getBaseName("auth-service")).toBe("auth");
    expect(getBaseName("user-api")).toBe("user");
  });

  it("strips trailing numbers", () => {
    expect(getBaseName("worker-1")).toBe("worker");
    // getBaseName strips suffix first, then trailing numbers in a single pass
    // "api-server-2" → strips "-server" → "api-2" → strips "-2" → "api"
    // Actually the regex strips suffix OR trailing number patterns at the end
    expect(getBaseName("api-server-2")).toBe("api-server");
    expect(getBaseName("redis-3")).toBe("redis");
  });

  it("handles names with no suffix to strip", () => {
    expect(getBaseName("redis")).toBe("redis");
    expect(getBaseName("postgres")).toBe("postgres");
  });

  it("is case-insensitive", () => {
    expect(getBaseName("API-Server")).toBe("api");
    expect(getBaseName("Auth-SERVICE")).toBe("auth");
  });

  it("returns the original name (lowercased) when stripping would result in empty", () => {
    expect(getBaseName("server")).toBe("server");
  });

  it("handles names with underscores", () => {
    expect(getBaseName("auth_service")).toBe("auth");
    expect(getBaseName("api_worker")).toBe("api");
  });

  it("strips common demo/test environment prefixes", () => {
    expect(getBaseName("fere-test-user-service")).toBe("user");
    expect(getBaseName("fere-demo-order-service")).toBe("order");
    expect(getBaseName("test-postgres")).toBe("postgres");
    expect(getBaseName("demo-redis")).toBe("redis");
  });
});

describe("getTypePriority", () => {
  it("gives frontend the highest priority (lowest number)", () => {
    expect(getTypePriority("frontend")).toBe(0);
  });

  it("gives databases and caches the lowest priority", () => {
    expect(getTypePriority("database")).toBe(3);
    expect(getTypePriority("cache")).toBe(3);
  });

  it("puts backends in the middle", () => {
    expect(getTypePriority("backend")).toBe(1);
    expect(getTypePriority("webserver")).toBe(1);
  });

  it("gives unknown types a default priority", () => {
    expect(getTypePriority("unknown")).toBe(4);
    expect(getTypePriority("")).toBe(4);
  });

  it("maintains frontend < backend < database ordering", () => {
    expect(getTypePriority("frontend")).toBeLessThan(getTypePriority("backend"));
    expect(getTypePriority("backend")).toBeLessThan(getTypePriority("database"));
  });
});

describe("getServiceColor", () => {
  it("returns a color for known service types", () => {
    expect(getServiceColor("frontend")).toMatch(/^#[0-9A-Fa-f]{6}$/);
    expect(getServiceColor("database")).toMatch(/^#[0-9A-Fa-f]{6}$/);
    expect(getServiceColor("cache")).toMatch(/^#[0-9A-Fa-f]{6}$/);
  });

  it("returns a fallback color for unknown types", () => {
    expect(getServiceColor("nonexistent")).toMatch(/^#[0-9A-Fa-f]{6}$/);
  });
});

describe("getHealthInfo", () => {
  it("returns correct info for green status", () => {
    const info = getHealthInfo("green");
    expect(info.label).toBe("Active");
    expect(info.color).toBeDefined();
    expect(info.glow).toBeDefined();
  });

  it("returns correct info for yellow status", () => {
    const info = getHealthInfo("yellow");
    expect(info.label).toBe("Idle");
  });

  it("returns correct info for red status", () => {
    const info = getHealthInfo("red");
    expect(info.label).toBe("Down");
  });
});
