import { defineTool, ToolArgsError, validateJsonSchemaValue } from '@deepseek-ai/dsh-tools';
import { scheduleRuntimeManifest } from './runtime-inspect.js';

export const name = 'defense-tools';
export const inject = ['tools'];
export const DEFENSE_TOOL_NAMES = Object.freeze([
  'evidence.get_summary',
  'analysis.submit_result',
]);

const output = {
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      status: { type: 'string', required: true },
    },
  },
  render(_args, value) {
    return JSON.stringify(value);
  },
};

function unavailable(toolName) {
  const error = new Error(`${toolName}: broker integration is outside WP0-B scope`);
  error.code = 'WP0_BROKER_UNAVAILABLE';
  throw error;
}

function closedTool(options) {
  const definition = defineTool(options);
  definition.parameters = { ...definition.parameters, additionalProperties: false };
  const execute = definition.execute;
  definition.execute = (args, exec) => {
    const violations = validateJsonSchemaValue(definition.parameters, args, '');
    if (violations.length > 0) throw new ToolArgsError(violations);
    return execute(args, exec);
  };
  return definition;
}

export function createDefenseToolDefinitions() {
  return [
    closedTool({
      name: 'evidence.get_summary',
      description: 'Read an allowlisted, redacted evidence summary through the analysis broker.',
      parameters: {
        evidenceRef: { type: 'string', required: true },
        fields: {
          type: 'array',
          required: true,
          items: { type: 'string' },
        },
      },
      output,
      timeoutMs: 5000,
      execute() {
        unavailable('evidence.get_summary');
      },
    }),
    closedTool({
      name: 'analysis.submit_result',
      description: 'Submit a structured analysis report through the analysis broker; never executes a response.',
      parameters: {
        analysisId: { type: 'string', required: true },
        attemptId: { type: 'string', required: true },
        summary: { type: 'string', required: true },
        confidence: { type: 'number', required: true },
        evidenceIds: {
          type: 'array',
          required: true,
          items: { type: 'string' },
        },
        limitations: {
          type: 'array',
          required: true,
          items: { type: 'string' },
        },
      },
      output,
      timeoutMs: 5000,
      execute() {
        unavailable('analysis.submit_result');
      },
    }),
  ];
}

export function apply(ctx) {
  scheduleRuntimeManifest(ctx);
  for (const definition of createDefenseToolDefinitions()) ctx.tools.register(definition);
  ctx.tools.guard((exec) => (
    DEFENSE_TOOL_NAMES.includes(exec.name)
      ? undefined
      : `tool "${exec.name}" is not approved by the Aegis defense profile`
  ));
}
