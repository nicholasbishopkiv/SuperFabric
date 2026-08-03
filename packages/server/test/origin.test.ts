import { describe, it, expect } from "vitest";
import { allowedOrigins, isOriginAllowed } from "../src/origin.js";

const PORT = 4620;

describe("isOriginAllowed", () => {
  it("allows the server's own origin on both loopback spellings", () => {
    expect(isOriginAllowed(`http://127.0.0.1:${PORT}`, PORT)).toBe(true);
    expect(isOriginAllowed(`http://localhost:${PORT}`, PORT)).toBe(true);
  });

  it("allows the Vite dev origins", () => {
    expect(isOriginAllowed("http://localhost:5173", PORT)).toBe(true);
    expect(isOriginAllowed("http://127.0.0.1:5173", PORT)).toBe(true);
  });

  it("rejects any other website — this is the drive-by vector", () => {
    for (const origin of [
      "https://evil.example.com",
      "http://evil.example.com",
      "http://localhost:5174",
      `http://127.0.0.1:${PORT + 1}`,
      "https://localhost:5173",              // scheme must match too
      "http://localhost.evil.com:5173",
      "null",                                 // sandboxed iframe / file:// page: still a browser
    ]) {
      expect(isOriginAllowed(origin, PORT), origin).toBe(false);
    }
  });

  it("allows a missing or empty Origin, which browsers never send", () => {
    expect(isOriginAllowed(undefined, PORT)).toBe(true);
    expect(isOriginAllowed(null, PORT)).toBe(true);
    expect(isOriginAllowed("", PORT)).toBe(true);
    expect(isOriginAllowed("   ", PORT)).toBe(true);
  });

  it("honours SUPERFABRIC_ALLOWED_ORIGINS as a comma-separated list", () => {
    const extra = "https://fabrica.example.com, http://localhost:4200 ,";
    expect(isOriginAllowed("https://fabrica.example.com", PORT, extra)).toBe(true);
    expect(isOriginAllowed("http://localhost:4200", PORT, extra)).toBe(true);
    expect(isOriginAllowed("https://other.example.com", PORT, extra)).toBe(false);
    // an empty trailing entry must not become a wildcard
    expect(isOriginAllowed("", PORT, extra)).toBe(true);
    expect(isOriginAllowed("https://", PORT, extra)).toBe(false);
  });

  it("compares case-insensitively and tolerates surrounding whitespace", () => {
    expect(isOriginAllowed(` HTTP://LocalHost:${PORT} `, PORT)).toBe(true);
  });

  it("tracks the port the server is actually listening on", () => {
    expect(isOriginAllowed("http://127.0.0.1:4711", 4711)).toBe(true);
    expect(isOriginAllowed("http://127.0.0.1:4620", 4711)).toBe(false);
    expect(allowedOrigins(4711)).toContain("http://localhost:5173");
  });
});
