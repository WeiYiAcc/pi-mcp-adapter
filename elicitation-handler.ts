import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  ElicitRequestSchema,
  type ElicitRequest,
  type ElicitRequestFormParams,
  type ElicitRequestURLParams,
  type ElicitResult,
} from "@modelcontextprotocol/sdk/types.js";
import open from "open";

type ElicitationValue = string | number | boolean | string[] | undefined;
type SelectOption = { value: string; label?: string };

export type ElicitationUIContext = ExtensionUIContext;

export interface ElicitationHandlerOptions {
  serverName: string;
  ui: ElicitationUIContext;
  autoOpenUrls: boolean;
}

export type ServerElicitationConfig = Omit<ElicitationHandlerOptions, "serverName">;

export function registerElicitationHandler(client: Client, options: ElicitationHandlerOptions): void {
  client.setRequestHandler(ElicitRequestSchema, (request) => {
    return handleElicitationRequest(options, request as ElicitRequest);
  });
}

export async function handleElicitationRequest(
  options: ElicitationHandlerOptions,
  request: ElicitRequest,
): Promise<ElicitResult> {
  const params = request.params;
  if (params.mode === "url") {
    return handleUrlElicitation(options, params);
  }
  return handleFormElicitation(options, params);
}

export async function handleFormElicitation(
  options: ElicitationHandlerOptions,
  params: ElicitRequestFormParams,
): Promise<ElicitResult> {
  const decision = await options.ui.select(
    `MCP Input Request\nServer: ${options.serverName}\n\n${params.message}`,
    ["Continue", "Decline"],
  );
  if (decision === undefined) return { action: "cancel" };
  if (decision === "Decline") return { action: "decline" };

  const values: Record<string, ElicitationValue> = {};
  const required = new Set(params.requestedSchema.required ?? []);

  for (const [name, schema] of Object.entries(params.requestedSchema.properties)) {
    const label = schema.title ?? humanizeName(name);
    const title = [required.has(name) ? `${label} (required)` : label, schema.description]
      .filter(Boolean)
      .join("\n");

    if (schema.type === "string" && ("enum" in schema || "oneOf" in schema)) {
      const choices = "oneOf" in schema
        ? schema.oneOf.map((option) => ({ display: formatChoice(option.const, option.title), value: option.const }))
        : schema.enum.map((value, index) => ({
            display: formatChoice(value, "enumNames" in schema ? schema.enumNames?.[index] : undefined),
            value,
          }));
      const skip = required.has(name) ? undefined : uniqueActionLabel("Skip", choices.map((choice) => choice.display));
      const selected = await options.ui.select(title, [
        ...choices.map((choice) => choice.display),
        ...(skip ? [skip] : []),
      ]);
      if (selected === undefined) return { action: "cancel" };
      const value = selected === skip ? undefined : choices.find((choice) => choice.display === selected)?.value;
      values[name] = validateFieldValue(params, name, schema, required.has(name), value);
      continue;
    }

    if (schema.type === "boolean") {
      const choices = ["Yes", "No"];
      const skip = required.has(name) ? undefined : uniqueActionLabel("Skip", choices);
      const selected = await options.ui.select(title, [...choices, ...(skip ? [skip] : [])]);
      if (selected === undefined) return { action: "cancel" };
      const value = selected === skip ? undefined : selected === "Yes";
      values[name] = validateFieldValue(params, name, schema, required.has(name), value);
      continue;
    }

    if (schema.type === "array") {
      const choices = extractMultiSelectOptions(schema).map((option) => ({
        display: formatChoice(option.value, option.label),
        value: option.value,
      }));
      const selectedValues = new Set(schema.default ?? []);

      while (true) {
        const displays = choices.map((choice) =>
          selectedValues.has(choice.value) ? `✓ ${choice.display}` : choice.display,
        );
        const done = uniqueActionLabel("Done", displays);
        const selected = await options.ui.select(title, [...displays, done]);
        if (selected === undefined) return { action: "cancel" };
        if (selected === done) {
          try {
            values[name] = validateFieldValue(params, name, schema, required.has(name), [...selectedValues]);
            break;
          } catch (error) {
            options.ui.notify(error instanceof Error ? error.message : String(error), "error");
            continue;
          }
        }

        const choice = choices[displays.indexOf(selected)];
        if (!choice) continue;
        if (selectedValues.has(choice.value)) selectedValues.delete(choice.value);
        else selectedValues.add(choice.value);
      }

      continue;
    }

    const placeholder = schema.default === undefined ? undefined : String(schema.default);
    while (true) {
      const entered = await options.ui.input(title, placeholder);
      if (entered === undefined) return { action: "cancel" };
      const value = entered === "" && schema.default !== undefined ? schema.default : entered;
      try {
        values[name] = validateFieldValue(params, name, schema, required.has(name), value);
        break;
      } catch (error) {
        options.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    }
  }

  const submission = await options.ui.select(`Submit input to ${options.serverName}?`, ["Submit", "Decline"]);
  if (submission === undefined) return { action: "cancel" };
  if (submission === "Decline") return { action: "decline" };

  return {
    action: "accept",
    content: coerceAndValidateFormValues(params, values),
  };
}

export async function handleUrlElicitation(
  options: ElicitationHandlerOptions,
  params: ElicitRequestURLParams,
): Promise<ElicitResult> {
  const browserUrl = getBrowserElicitationUrl(params.url);
  if (!options.autoOpenUrls) {
    const result = await options.ui.select(
      [
        "MCP Browser Request",
        `Server: ${options.serverName}`,
        "",
        params.message,
        "",
        `Domain: ${browserUrl.host}`,
        `URL: ${browserUrl.toString()}`,
        "",
        "Open this URL in your browser?",
      ].join("\n"),
      ["Open", "Decline"],
    );
    if (result === "Decline") return { action: "decline" };
    if (result === undefined) return { action: "cancel" };
  }

  await open(browserUrl.toString());
  options.ui.notify("Opened browser for MCP elicitation.", "info");
  return { action: "accept" };
}

function validateFieldValue(
  params: ElicitRequestFormParams,
  name: string,
  schema: ElicitRequestFormParams["requestedSchema"]["properties"][string],
  required: boolean,
  value: ElicitationValue,
): ElicitationValue {
  const fieldParams = {
    ...params,
    requestedSchema: {
      type: "object",
      properties: { [name]: schema },
      ...(required ? { required: [name] } : {}),
    },
  } as ElicitRequestFormParams;
  return coerceAndValidateFormValues(fieldParams, { [name]: value })[name];
}

export function coerceAndValidateFormValues(
  params: ElicitRequestFormParams,
  values: Record<string, ElicitationValue>,
): Record<string, string | number | boolean | string[]> {
  const output: Record<string, string | number | boolean | string[]> = {};
  const required = new Set(params.requestedSchema.required ?? []);

  for (const [name, schema] of Object.entries(params.requestedSchema.properties)) {
    const raw = values[name] ?? schema.default;
    if (raw === undefined || (raw === "" && schema.type !== "string")) {
      if (required.has(name)) throw new Error(`Missing required elicitation field: ${name}`);
      continue;
    }

    if (schema.type === "string") {
      const stringSchema = schema as { minLength?: number; maxLength?: number };
      const value = String(raw);
      if (stringSchema.minLength !== undefined && value.length < stringSchema.minLength) {
        throw new Error(`Elicitation field ${name} is shorter than minimum length ${stringSchema.minLength}`);
      }
      if (stringSchema.maxLength !== undefined && value.length > stringSchema.maxLength) {
        throw new Error(`Elicitation field ${name} is longer than maximum length ${stringSchema.maxLength}`);
      }
      if ("enum" in schema && Array.isArray(schema.enum) && !schema.enum.includes(value)) {
        throw new Error(`Elicitation field ${name} is not an allowed value`);
      }
      if ("oneOf" in schema && Array.isArray(schema.oneOf) && !schema.oneOf.some((option) => option.const === value)) {
        throw new Error(`Elicitation field ${name} is not an allowed value`);
      }
      if ("format" in schema && schema.format && !isValidStringFormat(value, schema.format)) {
        throw new Error(`Elicitation field ${name} must be a valid ${schema.format}`);
      }
      output[name] = value;
      continue;
    }

    if (schema.type === "number" || schema.type === "integer") {
      const value = typeof raw === "number" ? raw : Number(raw);
      if (!Number.isFinite(value)) throw new Error(`Elicitation field ${name} must be a number`);
      if (schema.type === "integer" && !Number.isInteger(value)) throw new Error(`Elicitation field ${name} must be an integer`);
      if (schema.minimum !== undefined && value < schema.minimum) {
        throw new Error(`Elicitation field ${name} is below minimum ${schema.minimum}`);
      }
      if (schema.maximum !== undefined && value > schema.maximum) {
        throw new Error(`Elicitation field ${name} is above maximum ${schema.maximum}`);
      }
      output[name] = value;
      continue;
    }

    if (schema.type === "boolean") {
      output[name] = typeof raw === "boolean" ? raw : raw === "true";
      continue;
    }

    if (schema.type === "array") {
      if (!Array.isArray(raw)) throw new Error(`Elicitation field ${name} must be a list`);
      const allowed = new Set(extractMultiSelectOptions(schema).map((option) => option.value));
      const value = raw.map(String);
      if (schema.minItems !== undefined && value.length < schema.minItems) {
        throw new Error(`Elicitation field ${name} has fewer than ${schema.minItems} selections`);
      }
      if (schema.maxItems !== undefined && value.length > schema.maxItems) {
        throw new Error(`Elicitation field ${name} has more than ${schema.maxItems} selections`);
      }
      for (const item of value) {
        if (!allowed.has(item)) throw new Error(`Elicitation field ${name} contains an invalid selection`);
      }
      output[name] = value;
    }
  }

  return output;
}

function extractMultiSelectOptions(schema: Extract<ElicitRequestFormParams["requestedSchema"]["properties"][string], { type: "array" }>): SelectOption[] {
  const items = schema.items as { enum?: string[]; anyOf?: Array<{ const: string; title: string }> };
  if (Array.isArray(items.anyOf)) {
    return items.anyOf.map((option) => ({ value: option.const, label: option.title }));
  }
  return (items.enum ?? []).map((value) => ({ value }));
}

function isValidStringFormat(value: string, format: "email" | "uri" | "date" | "date-time"): boolean {
  if (format === "email") return /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value);
  if (format === "uri") {
    try {
      return Boolean(new URL(value).protocol);
    } catch {
      return false;
    }
  }
  if (format === "date") {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
    if (!match) return false;
    const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
    return date.toISOString().slice(0, 10) === value;
  }
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(value)
    && !Number.isNaN(Date.parse(value));
}

function formatChoice(value: string, label?: string): string {
  return label && label !== value ? `${label} (${value})` : value;
}

function uniqueActionLabel(label: string, choices: string[]): string {
  let result = label;
  while (choices.includes(result)) result += "…";
  return result;
}

function humanizeName(name: string): string {
  return name
    .replace(/[_-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/^./, (char) => char.toUpperCase());
}

function getBrowserElicitationUrl(url: string): URL {
  const parsed = new URL(url);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`MCP URL elicitation only supports http/https URLs: ${parsed.protocol}`);
  }
  return parsed;
}
