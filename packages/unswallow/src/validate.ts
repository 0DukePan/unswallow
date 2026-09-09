import type { ToolEnvelope, ToolSchema } from './types';

export interface ToolValidationResult {
  /** The recovered call has the minimum shape required by OpenAI-compatible tool calls. */
  structurallyValid: boolean;
  /** Whether the recovered name appears in the supplied tool schemas. */
  nameKnown: 'yes' | 'no' | 'unknown';
  /** Whether arguments satisfy the supplied tool's supported JSON Schema subset. */
  schemaValid: 'yes' | 'no' | 'unknown';
  errors: string[];
}

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function schemaFor(tool: ToolSchema): JsonObject | null {
  const parameters = tool.function?.parameters ?? tool.parameters;
  return isObject(parameters) ? parameters : null;
}

function nameFor(tool: ToolSchema): string | undefined {
  const name = tool.function?.name ?? tool.name;
  return typeof name === 'string' && name.trim() ? name.trim() : undefined;
}

function typeMatches(value: unknown, type: string): boolean {
  switch (type) {
    case 'object': return isObject(value);
    case 'array': return Array.isArray(value);
    case 'string': return typeof value === 'string';
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'integer': return typeof value === 'number' && Number.isInteger(value);
    case 'boolean': return typeof value === 'boolean';
    case 'null': return value === null;
    default: return true;
  }
}

function validateValue(value: unknown, schema: JsonObject, path: string, errors: string[]): void {
  const type = schema.type;
  if (typeof type === 'string' && !typeMatches(value, type)) {
    errors.push(`${path} must be ${type}`);
    return;
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((candidate) => Object.is(candidate, value))) {
    errors.push(`${path} must be one of the allowed values`);
  }
  if ('const' in schema && !Object.is(schema.const, value)) errors.push(`${path} must equal the required value`);

  if (isObject(value)) {
    const properties = schema.properties;
    if (properties !== undefined && !isObject(properties)) {
      errors.push(`${path} schema has non-object properties`);
      return;
    }
    if (Array.isArray(schema.required)) {
      for (const key of schema.required) {
        if (typeof key === 'string' && !(key in value)) errors.push(`${path}.${key} is required`);
      }
    }
    if (isObject(properties)) {
      for (const [key, childSchema] of Object.entries(properties)) {
        if (key in value && isObject(childSchema)) validateValue(value[key], childSchema, `${path}.${key}`, errors);
      }
      if (schema.additionalProperties === false) {
        for (const key of Object.keys(value)) {
          if (!(key in properties)) errors.push(`${path}.${key} is not allowed`);
        }
      }
    }
  }

  if (Array.isArray(value) && isObject(schema.items)) {
    value.forEach((item, index) => validateValue(item, schema.items as JsonObject, `${path}[${index}]`, errors));
  }
}

/**
 * Validate a recovered tool envelope without attempting to repair it. Only a
 * conservative JSON Schema subset is evaluated; unsupported or malformed
 * schemas produce an `unknown` result rather than a false validation claim.
 */
export function validateEnvelope(
  envelope: Pick<ToolEnvelope, 'name' | 'arguments'> | null | undefined,
  toolSchemas?: ToolSchema[]
): ToolValidationResult {
  if (!envelope || typeof envelope.name !== 'string' || !envelope.name.trim() || !isObject(envelope.arguments)) {
    return { structurallyValid: false, nameKnown: 'unknown', schemaValid: 'unknown', errors: ['tool envelope must have a name and object arguments'] };
  }
  if (!toolSchemas || toolSchemas.length === 0) {
    return { structurallyValid: true, nameKnown: 'unknown', schemaValid: 'unknown', errors: [] };
  }
  const matching = toolSchemas.filter((tool) => nameFor(tool) === envelope.name);
  if (matching.length === 0) {
    return { structurallyValid: true, nameKnown: 'no', schemaValid: 'unknown', errors: [`recovered tool name "${envelope.name}" not found in provided toolSchemas`] };
  }
  const schema = schemaFor(matching[0]);
  if (!schema) {
    return { structurallyValid: true, nameKnown: 'yes', schemaValid: 'unknown', errors: [`tool schema for "${envelope.name}" has no object parameters schema`] };
  }
  if (schema.properties !== undefined && !isObject(schema.properties)) {
    return { structurallyValid: true, nameKnown: 'yes', schemaValid: 'unknown', errors: [`tool schema for "${envelope.name}" has non-object properties`] };
  }
  if (schema.required !== undefined && !Array.isArray(schema.required)) {
    return { structurallyValid: true, nameKnown: 'yes', schemaValid: 'unknown', errors: [`tool schema for "${envelope.name}" has non-array required`] };
  }
  const errors: string[] = [];
  validateValue(envelope.arguments, schema, 'arguments', errors);
  return { structurallyValid: true, nameKnown: 'yes', schemaValid: errors.length === 0 ? 'yes' : 'no', errors };
}
