import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { guardMcpOutput, resolveMcpOutputGuardOptions } from "../mcp-output-guard.ts";

describe("guardMcpOutput", () => {
  it("leaves small MCP output unchanged while summarizing raw details", async () => {
    const guarded = await guardMcpOutput(
      [{ type: "text", text: "small result" }],
      { rawMcpResult: { content: [{ type: "text", text: "small result" }], isError: false } },
    );

    expect(guarded.content).toEqual([{ type: "text", text: "small result" }]);
    expect(guarded.outputGuard).toBeUndefined();
    expect(guarded.mcpResult).toMatchObject({
      omitted: true,
      isError: false,
      contentBlocks: 1,
      contentSummary: [{ type: "text", bytes: 12, lines: 1, textOmitted: true }],
    });
    expect(JSON.stringify(guarded.mcpResult)).not.toContain("small result");
  });

  it("truncates large text output and saves the full output to a file", async () => {
    const text = Array.from({ length: 20 }, (_, i) => `line-${i} ${"x".repeat(40)}`).join("\n");
    const guarded = await guardMcpOutput(
      [{ type: "text", text }],
      {
        maxBytes: 220,
        maxLines: 8,
        detailsMaxBytes: 200,
        rawMcpResult: { content: [{ type: "text", text }], isError: false, structuredContent: { rows: [text] } },
      },
    );

    expect(guarded.outputGuard).toMatchObject({
      truncated: true,
      originalLines: 20,
    });
    expect(guarded.outputGuard?.fullOutputPath).toBeTruthy();
    expect(guarded.content).toHaveLength(1);
    expect(guarded.content[0]).toMatchObject({ type: "text" });
    const returnedText = guarded.content[0].type === "text" ? guarded.content[0].text : "";
    expect(returnedText).toContain("MCP output truncated");
    expect(returnedText).toContain("Full output saved to:");
    expect(returnedText).not.toContain("line-19");

    const saved = await readFile(guarded.outputGuard!.fullOutputPath!, "utf8");
    expect(saved).toBe(text);
    expect(guarded.mcpResult?.fullResultPath).toBeTruthy();
    expect(JSON.stringify(guarded.mcpResult)).not.toContain("line-19");
  });

  it("keeps prefixes and suffixes inside the saved full output", async () => {
    const guarded = await guardMcpOutput(
      [{ type: "text", text: "body" }],
      { prefix: "Error: ", suffix: "\n\nExpected parameters:\n{}", maxBytes: 10, maxLines: 2 },
    );

    expect(guarded.outputGuard?.fullOutputPath).toBeTruthy();
    const saved = await readFile(guarded.outputGuard!.fullOutputPath!, "utf8");
    expect(saved).toBe("Error: body\n\nExpected parameters:\n{}");
  });

  it("can be disabled to return raw output and raw details", async () => {
    const text = "x".repeat(1000);
    const rawMcpResult = { content: [{ type: "text", text }], isError: false };
    const guarded = await guardMcpOutput(
      [{ type: "text", text }],
      { enabled: false, maxBytes: 10, maxLines: 1, rawMcpResult },
    );

    expect(guarded.content).toEqual([{ type: "text", text }]);
    expect(guarded.outputGuard).toBeUndefined();
    expect(guarded.mcpResult).toBe(rawMcpResult);
  });

  it("resolves config and environment overrides", () => {
    const previous = process.env.MCP_OUTPUT_GUARD;
    const previousBytes = process.env.MCP_OUTPUT_MAX_BYTES;
    try {
      process.env.MCP_OUTPUT_GUARD = "0";
      process.env.MCP_OUTPUT_MAX_BYTES = "1234";

      expect(resolveMcpOutputGuardOptions({ outputGuard: true, outputMaxBytes: 9999 })).toMatchObject({
        enabled: false,
        maxBytes: 1234,
      });
    } finally {
      if (previous === undefined) delete process.env.MCP_OUTPUT_GUARD;
      else process.env.MCP_OUTPUT_GUARD = previous;
      if (previousBytes === undefined) delete process.env.MCP_OUTPUT_MAX_BYTES;
      else process.env.MCP_OUTPUT_MAX_BYTES = previousBytes;
    }
  });
});
