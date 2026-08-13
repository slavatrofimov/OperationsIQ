/**
 * Dependency-free JSON Schema validation for tool arguments.
 *
 * The agent is told a tool's parameter contract via `tool.parameters` (a JSON
 * Schema). Historically each adapter re-validated by hand, so "what the agent is
 * told" and "what is enforced" could drift as tools multiply. This validator
 * makes the advertised schema authoritative: `dispatchTool` runs it before an
 * adapter's `run`, so structural checks (types, enums, bounds, required fields,
 * defaults) live in one place. Adapters keep only *semantic* checks that a schema
 * cannot express (e.g. "endIso must be after startIso").
 *
 * It supports the subset of JSON Schema the tools actually use:
 *   type (object|string|number|integer|boolean|array), properties, required,
 *   additionalProperties, enum, minimum, maximum, minLength, maxLength, default,
 *   and array `items`. Unknown properties under `additionalProperties: false`
 *   are stripped (forgiving to the model) rather than rejected.
 */

import type { JsonSchema } from './types';

export type ValidationResult =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; errors: string[] };

interface SchemaNode {
  type?: string;
  properties?: Record<string, SchemaNode>;
  required?: string[];
  additionalProperties?: boolean;
  enum?: unknown[];
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  default?: unknown;
  items?: SchemaNode;
}

/** Validate `input` against a tool's parameter schema, applying defaults. */
export function validateArgs(schema: JsonSchema, input: unknown): ValidationResult {
  const errors: string[] = [];
  const value = validateNode(schema as SchemaNode, input, '', errors);
  if (errors.length) return { ok: false, errors };
  return { ok: true, value: (value ?? {}) as Record<string, unknown> };
}

function label(path: string): string {
  return path || 'arguments';
}

function validateNode(
  node: SchemaNode,
  raw: unknown,
  path: string,
  errors: string[],
): unknown {
  const type = node.type;

  if (type === 'object') {
    const obj: Record<string, unknown> =
      raw && typeof raw === 'object' && !Array.isArray(raw)
        ? { ...(raw as Record<string, unknown>) }
        : {};
    if (raw != null && (typeof raw !== 'object' || Array.isArray(raw))) {
      errors.push(`${label(path)} must be an object.`);
      return obj;
    }

    const props = node.properties ?? {};
    const out: Record<string, unknown> = {};

    // Drop unknown keys when additionalProperties is explicitly false.
    for (const key of Object.keys(obj)) {
      if (key in props || node.additionalProperties !== false) {
        out[key] = obj[key];
      }
    }

    for (const [key, childSchema] of Object.entries(props)) {
      const childPath = path ? `${path}.${key}` : key;
      if (out[key] === undefined || out[key] === null) {
        if (childSchema.default !== undefined) {
          out[key] = childSchema.default;
        }
        continue; // absence handled by `required` below
      }
      out[key] = validateNode(childSchema, out[key], childPath, errors);
    }

    for (const req of node.required ?? []) {
      if (out[req] === undefined || out[req] === null || out[req] === '') {
        errors.push(`${req} is required.`);
      }
    }
    return out;
  }

  if (type === 'array') {
    if (!Array.isArray(raw)) {
      errors.push(`${label(path)} must be an array.`);
      return raw;
    }
    if (node.items) {
      return raw.map((el, i) => validateNode(node.items!, el, `${path}[${i}]`, errors));
    }
    return raw;
  }

  // Primitive types
  if (type === 'string') {
    if (typeof raw !== 'string') {
      errors.push(`${label(path)} must be a string.`);
      return raw;
    }
    if (node.minLength != null && raw.length < node.minLength) {
      errors.push(`${label(path)} must be at least ${node.minLength} character(s).`);
    }
    if (node.maxLength != null && raw.length > node.maxLength) {
      errors.push(`${label(path)} must be at most ${node.maxLength} character(s).`);
    }
    checkEnum(node, raw, path, errors);
    return raw;
  }

  if (type === 'number' || type === 'integer') {
    if (typeof raw !== 'number' || !Number.isFinite(raw)) {
      errors.push(`${label(path)} must be a ${type}.`);
      return raw;
    }
    if (type === 'integer' && !Number.isInteger(raw)) {
      errors.push(`${label(path)} must be an integer.`);
    }
    if (node.minimum != null && raw < node.minimum) {
      errors.push(`${label(path)} must be >= ${node.minimum}.`);
    }
    if (node.maximum != null && raw > node.maximum) {
      errors.push(`${label(path)} must be <= ${node.maximum}.`);
    }
    checkEnum(node, raw, path, errors);
    return raw;
  }

  if (type === 'boolean') {
    if (typeof raw !== 'boolean') errors.push(`${label(path)} must be a boolean.`);
    return raw;
  }

  // No/unknown type: pass through but still honor enum if present.
  checkEnum(node, raw, path, errors);
  return raw;
}

function checkEnum(node: SchemaNode, raw: unknown, path: string, errors: string[]): void {
  if (node.enum && !node.enum.includes(raw)) {
    errors.push(`${label(path)} must be one of: ${node.enum.map((v) => JSON.stringify(v)).join(', ')}.`);
  }
}
