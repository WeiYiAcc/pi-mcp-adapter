import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ElicitRequest } from "@modelcontextprotocol/sdk/types.js";
import { coerceAndValidateFormValues, handleElicitationRequest } from "../elicitation-handler.ts";

const mocks = vi.hoisted(() => ({
  open: vi.fn(async () => undefined),
}));

vi.mock("open", () => ({ default: mocks.open }));

function formRequest(params: ElicitRequest["params"]): ElicitRequest {
  return { method: "elicitation/create", params } as ElicitRequest;
}

describe("elicitation handler", () => {
  beforeEach(() => {
    mocks.open.mockClear();
  });

  it("collects form elicitation fields with stock Pi dialogs and returns accepted content", async () => {
    const ui = {
      select: vi
        .fn()
        .mockResolvedValueOnce("Continue")
        .mockResolvedValueOnce("Medium (medium)")
        .mockResolvedValueOnce("Yes")
        .mockResolvedValueOnce("Submit"),
      input: vi.fn(async () => "Bug in auth flow"),
    };

    const result = await handleElicitationRequest(
      { serverName: "github", ui: ui as any, autoOpenUrls: false },
      formRequest({
        mode: "form",
        message: "Create a new issue",
        requestedSchema: {
          type: "object",
          properties: {
            title: {
              type: "string",
              title: "Title",
              description: "Issue title",
              minLength: 1,
            },
            priority: {
              type: "string",
              title: "Priority",
              oneOf: [
                { const: "low", title: "Low" },
                { const: "medium", title: "Medium" },
                { const: "high", title: "High" },
              ],
              default: "medium",
            },
            assignToMe: {
              type: "boolean",
              title: "Assign to me",
              default: false,
            },
          },
          required: ["title"],
        },
      }),
    );

    expect(ui.select).toHaveBeenNthCalledWith(
      1,
      "MCP Input Request\nServer: github\n\nCreate a new issue",
      ["Continue", "Decline"],
    );
    expect(ui.input).toHaveBeenCalledWith("Title (required)\nIssue title", undefined);
    expect(ui.select).toHaveBeenNthCalledWith(2, "Priority", [
      "Low (low)",
      "Medium (medium)",
      "High (high)",
      "Skip",
    ]);
    expect(ui.select).toHaveBeenNthCalledWith(3, "Assign to me", ["Yes", "No", "Skip"]);
    expect(ui.select).toHaveBeenNthCalledWith(4, "Submit input to github?", ["Submit", "Decline"]);
    expect(result).toEqual({
      action: "accept",
      content: {
        title: "Bug in auth flow",
        priority: "medium",
        assignToMe: true,
      },
    });
  });

  it("prompts for URL elicitations with stock Pi dialogs and opens accepted URLs", async () => {
    const ui = {
      select: vi.fn(async () => "Open"),
      notify: vi.fn(),
    };

    const result = await handleElicitationRequest(
      { serverName: "stripe", ui: ui as any, autoOpenUrls: false },
      formRequest({
        mode: "url",
        message: "Confirm payment authorization",
        elicitationId: "elicit_123",
        url: "https://checkout.stripe.com/c/pay/cs_test_123",
      }),
    );

    expect(ui.select).toHaveBeenCalledWith(
      [
        "MCP Browser Request",
        "Server: stripe",
        "",
        "Confirm payment authorization",
        "",
        "Domain: checkout.stripe.com",
        "URL: https://checkout.stripe.com/c/pay/cs_test_123",
        "",
        "Open this URL in your browser?",
      ].join("\n"),
      ["Open", "Decline"],
    );
    expect(mocks.open).toHaveBeenCalledWith("https://checkout.stripe.com/c/pay/cs_test_123");
    expect(ui.notify).toHaveBeenCalledWith("Opened browser for MCP elicitation.", "info");
    expect(result).toEqual({ action: "accept" });
  });

  it("rejects non-browser URL elicitation schemes before prompting or opening", async () => {
    const ui = {
      select: vi.fn(async () => "Open"),
      notify: vi.fn(),
    };

    await expect(
      handleElicitationRequest(
        { serverName: "demo", ui: ui as any, autoOpenUrls: true },
        formRequest({
          mode: "url",
          message: "Open local file",
          elicitationId: "elicit_file",
          url: "file:///etc/passwd",
        }),
      ),
    ).rejects.toThrow("MCP URL elicitation only supports http/https URLs: file:");

    expect(ui.select).not.toHaveBeenCalled();
    expect(mocks.open).not.toHaveBeenCalled();
    expect(ui.notify).not.toHaveBeenCalled();
  });

  it("collects multi-select fields with stock Pi selectors", async () => {
    const ui = {
      select: vi
        .fn()
        .mockResolvedValueOnce("Continue")
        .mockResolvedValueOnce("urgent")
        .mockResolvedValueOnce("Done")
        .mockResolvedValueOnce("Submit"),
      input: vi.fn(),
    };

    const result = await handleElicitationRequest(
      { serverName: "github", ui: ui as any, autoOpenUrls: false },
      formRequest({
        mode: "form",
        message: "Choose labels",
        requestedSchema: {
          type: "object",
          properties: {
            labels: {
              type: "array",
              title: "Labels",
              items: { type: "string", enum: ["bug", "urgent"] },
              minItems: 1,
            },
          },
          required: ["labels"],
        },
      }),
    );

    expect(ui.select).toHaveBeenNthCalledWith(2, "Labels (required)", ["bug", "urgent", "Done"]);
    expect(result).toEqual({ action: "accept", content: { labels: ["urgent"] } });
  });

  it("collects numeric fields and applies advertised defaults", async () => {
    const ui = {
      select: vi.fn().mockResolvedValueOnce("Continue").mockResolvedValueOnce("Submit"),
      input: vi.fn().mockResolvedValueOnce("").mockResolvedValueOnce("4"),
    };

    const result = await handleElicitationRequest(
      { serverName: "demo", ui: ui as any, autoOpenUrls: false },
      formRequest({
        mode: "form",
        message: "Set limits",
        requestedSchema: {
          type: "object",
          properties: {
            minimum: { type: "number", title: "Minimum", default: 2.5 },
            retries: { type: "integer", title: "Retries", minimum: 1 },
          },
          required: ["retries"],
        },
      }),
    );

    expect(ui.input).toHaveBeenNthCalledWith(1, "Minimum", "2.5");
    expect(ui.input).toHaveBeenNthCalledWith(2, "Retries (required)", undefined);
    expect(result).toEqual({ action: "accept", content: { minimum: 2.5, retries: 4 } });
  });

  it("reprompts when a field value does not satisfy the requested schema", async () => {
    const ui = {
      select: vi.fn().mockResolvedValueOnce("Continue").mockResolvedValueOnce("Submit"),
      input: vi.fn().mockResolvedValueOnce("not-a-number").mockResolvedValueOnce("4"),
      notify: vi.fn(),
    };

    const result = await handleElicitationRequest(
      { serverName: "demo", ui: ui as any, autoOpenUrls: false },
      formRequest({
        mode: "form",
        message: "Set retries",
        requestedSchema: {
          type: "object",
          properties: { retries: { type: "integer", title: "Retries" } },
          required: ["retries"],
        },
      }),
    );

    expect(ui.notify).toHaveBeenCalledWith("Elicitation field retries must be a number", "error");
    expect(result).toEqual({ action: "accept", content: { retries: 4 } });
  });

  it("preserves empty strings for string fields unless schema constraints reject them", async () => {
    const params = {
      mode: "form",
      message: "Collect note",
      requestedSchema: {
        type: "object",
        properties: {
          note: { type: "string", title: "Note" },
          summary: { type: "string", title: "Summary", minLength: 1 },
        },
        required: ["note"],
      },
    } as const;

    expect(coerceAndValidateFormValues(params, { note: "", summary: "ok" })).toEqual({
      note: "",
      summary: "ok",
    });
    expect(() => coerceAndValidateFormValues(params, { note: "ok", summary: "" })).toThrow(
      "Elicitation field summary is shorter than minimum length 1",
    );
  });

  it("validates formatted string fields before accepting elicited content", () => {
    const params = {
      mode: "form",
      message: "Contact details",
      requestedSchema: {
        type: "object",
        properties: {
          email: { type: "string", format: "email" },
        },
      },
    } as const;

    expect(() => coerceAndValidateFormValues(params, { email: "not-an-email" })).toThrow(
      "Elicitation field email must be a valid email",
    );
    expect(coerceAndValidateFormValues(params, { email: "user@example.com" })).toEqual({
      email: "user@example.com",
    });
  });

  it("cancels when a stock Pi field dialog is dismissed", async () => {
    const ui = {
      select: vi.fn(async () => "Continue"),
      input: vi.fn(async () => undefined),
    };

    await expect(
      handleElicitationRequest(
        { serverName: "demo", ui: ui as any, autoOpenUrls: false },
        formRequest({
          mode: "form",
          message: "Why?",
          requestedSchema: {
            type: "object",
            properties: { reason: { type: "string", title: "Reason" } },
          },
        }),
      ),
    ).resolves.toEqual({ action: "cancel" });
    expect(ui.select).toHaveBeenCalledTimes(1);
  });

  it("maps stock Pi decline and cancel choices to MCP actions", async () => {
    const makeRequest = () =>
      formRequest({
        mode: "form",
        message: "Continue?",
        requestedSchema: {
          type: "object",
          properties: {
            reason: { type: "string", title: "Reason" },
          },
        },
      });

    const declineUi = { select: vi.fn(async () => "Decline") };
    const cancelUi = { select: vi.fn(async () => undefined) };

    await expect(
      handleElicitationRequest({ serverName: "demo", ui: declineUi as any, autoOpenUrls: false }, makeRequest()),
    ).resolves.toEqual({ action: "decline" });
    await expect(
      handleElicitationRequest({ serverName: "demo", ui: cancelUi as any, autoOpenUrls: false }, makeRequest()),
    ).resolves.toEqual({ action: "cancel" });
  });

  it("maps stock Pi URL decline and dismissal choices to MCP actions", async () => {
    const request = formRequest({
      mode: "url",
      message: "Authorize",
      elicitationId: "elicit_123",
      url: "https://example.com/authorize",
    });

    await expect(
      handleElicitationRequest(
        { serverName: "demo", ui: { select: vi.fn(async () => "Decline") } as any, autoOpenUrls: false },
        request,
      ),
    ).resolves.toEqual({ action: "decline" });
    await expect(
      handleElicitationRequest(
        { serverName: "demo", ui: { select: vi.fn(async () => undefined) } as any, autoOpenUrls: false },
        request,
      ),
    ).resolves.toEqual({ action: "cancel" });
    expect(mocks.open).not.toHaveBeenCalled();
  });
});
