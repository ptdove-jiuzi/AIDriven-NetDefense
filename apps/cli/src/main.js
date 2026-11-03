/**
 * main.js — argument parsing, dispatch and the exit-code contract.
 *
 * The CLI has one job and it is deliberately narrow: ask a loopback daemon four
 * read-only questions and render the answers. There is no `--force`, no `--yes`, no
 * endpoint override on the command line, and no verb that changes state. Anything that
 * would need those flags belongs to a different component with different authority.
 *
 * Two contracts are fixed here because scripts depend on them:
 *
 * - **Exit codes** (`CLI_EXIT`): 0 ok, 2 usage, 3 config, 4 unreachable, 5 auth,
 *   6 forbidden, 7 timeout, 8 bad response, 9 response too large, 10 endpoint
 *   unavailable, 11 rate limited, 12 daemon error, 13 unhealthy, 1 internal.
 * - **`--json` output**: exactly one JSON document on stdout, whether the command
 *   succeeded or failed, so a consumer never has to distinguish "prose on stderr" from
 *   "no output". The exit code still carries the cause.
 *
 * Argument parsing uses `node:util.parseArgs` in strict mode rather than a hand-rolled
 * loop: an unknown flag is an error, a flag missing its value is an error, and `--`
 * terminates options. None of that has to be re-derived (or re-broken) here.
 */

import { parseArgs } from 'node:util';

import { CLI_CODES, CLI_EXIT, CliError, exitForCode, toCliError } from './errors.js';
import {
  DEFAULT_LIMIT,
  DEFAULT_MAX_PAGES,
  LIMIT_RANGE,
  MAX_PAGES_RANGE,
  assertAnalysisId,
  fetchAlerts,
  fetchAnalysis,
  fetchHealth,
  fetchStatus,
  parseCursor,
  parseLimit,
  parseMaxPages,
} from './commands.js';
import { TIMEOUT_RANGE, loadCliConfig } from './config.js';
import { createLoopbackClient } from './http-client.js';
import { sanitizeText } from './format.js';
import { CURSOR_MAX_LENGTH } from './routes.js';
import { renderAlerts, renderAnalysis, renderHealth, renderStatus } from './views.js';

/** Output schema version. Bumped only for a breaking change to the JSON envelope. */
export const OUTPUT_SCHEMA_VERSION = '1.0';

/** Commands this build implements. `rescue` is deliberately not one of them. */
const COMMANDS = Object.freeze(['status', 'health', 'alerts', 'analysis']);

export const USAGE = `aegis-cli — read-only AegisHarness daemon client

Usage:
  aegis-cli <command> [options]

Commands:
  status                 lifecycle, health, scheduler, pipeline and store counters
  health                 liveness and readiness probes (no token required)
  alerts [--limit N]     recent alerts, newest first
  analysis [<id>]        analysis jobs, or one job by id; --limit is list-only
  help                   this text

Options:
  --json                 one JSON document on stdout, same exit codes
  --config <path>        client configuration (default: $AEGIS_CLI_CONFIG)
  --timeout <ms>         request deadline, ${TIMEOUT_RANGE.min}..${TIMEOUT_RANGE.max} (default: 5000)
  --limit <n>            page size for the alerts/analysis lists, ${LIMIT_RANGE.min}..${LIMIT_RANGE.max} (default: ${DEFAULT_LIMIT})
  --cursor <opaque>      continue a list from the cursor a previous run printed (max ${CURSOR_MAX_LENGTH} chars)
  --all                  follow next_cursor until the list ends (bounded by --max-pages)
  --max-pages <n>        page cap for --all, ${MAX_PAGES_RANGE.min}..${MAX_PAGES_RANGE.max} (default: ${DEFAULT_MAX_PAGES})
  -h, --help             this text

Exit codes:
   0 ok                      7 timeout              13 unhealthy
   1 internal                8 bad response
   2 usage                   9 response too large
   3 config                 10 endpoint unavailable
   4 unreachable            11 rate limited
   5 auth                   12 daemon error
   6 forbidden

Every command is read-only. This client only ever sends GET, never follows a
redirect, never prints the bearer token or a request header, and never reads the
event store, the database or any file other than its own configuration and token.

A cursor is opaque: this client copies it, never decodes or builds one. It is
bound to one endpoint and to the current token, so a rotated token invalidates
every cursor and --cursor then exits 8 asking you to start from the first page.
`;

/** Options accepted by `parseArgs`. */
const OPTIONS = Object.freeze({
  json: { type: 'boolean' },
  config: { type: 'string' },
  timeout: { type: 'string' },
  limit: { type: 'string' },
  cursor: { type: 'string' },
  all: { type: 'boolean' },
  'max-pages': { type: 'string' },
  help: { type: 'boolean', short: 'h' },
});

/**
 * Flags that only mean something for a list command.
 *
 * Used twice: to refuse them in detail mode (one document, no page) and to refuse them on
 * a command that has no list at all. One table, so the two refusals cannot drift apart.
 */
const PAGING_FLAGS = Object.freeze(['limit', 'cursor', 'all', 'max-pages']);

/**
 * Turn a `parseArgs` failure into a usage error without echoing raw argv.
 *
 * @param {unknown} error Thrown value.
 * @returns {CliError} Usage error.
 */
function parseFailure(error) {
  const message = error !== null && typeof error === 'object' && typeof error.message === 'string'
    ? error.message
    : '';
  const match = /(-{1,2}[A-Za-z0-9-]{1,40})/u.exec(message);
  const named = match === null ? '' : `"${sanitizeText(match[1], 40)}" `;
  if (message.includes('Unknown option')) {
    return new CliError(CLI_CODES.USAGE, `unknown option ${named}— run aegis-cli --help`);
  }
  if (message.includes('does not take an argument')) {
    // `--json=true` and friends: a boolean flag given a value is a usage error, and the
    // caller asked for JSON, so it must still get a JSON document.
    return new CliError(CLI_CODES.USAGE, `option ${named}does not take a value — run aegis-cli --help`);
  }
  if (message.includes('requires a value') || message.includes('argument missing')) {
    return new CliError(CLI_CODES.USAGE, `option ${named}requires a value — run aegis-cli --help`);
  }
  return new CliError(CLI_CODES.USAGE, 'arguments could not be parsed — run aegis-cli --help');
}

/**
 * Render a failure.
 *
 * @param {{out: (text: string) => void, err: (text: string) => void}} io Output sinks.
 * @param {boolean} asJson JSON mode.
 * @param {CliError} error Handled error.
 * @param {string|null} command Command that failed, if it was recognised.
 * @param {object} [data] Optional stable view to attach (e.g. an unready health probe).
 * @returns {number} Exit status.
 */
function emitFailure(io, asJson, error, command, data = undefined) {
  const exitCode = exitForCode(error.code);
  if (asJson) {
    const envelope = {
      schema_version: OUTPUT_SCHEMA_VERSION,
      ok: false,
      command,
      // A health probe that answered but is not ready still has a view worth reading;
      // the failure code says why the exit status is non-zero, and `data` says what the
      // daemon actually reported.
      ...(data === undefined ? {} : { data }),
      error: {
        code: error.code,
        message: sanitizeText(error.message, 300),
        exit_code: exitCode,
        ...error.details,
      },
    };
    io.out(`${JSON.stringify(envelope)}\n`);
  } else {
    io.err(`aegis-cli: ${error.code}: ${sanitizeText(error.message, 300)}\n`);
  }
  return exitCode;
}

/**
 * Render a success.
 *
 * @param {{out: (text: string) => void}} io Output sink.
 * @param {boolean} asJson JSON mode.
 * @param {string} command Command name.
 * @param {object} data Stable view.
 * @param {string} human Human rendering.
 * @returns {void}
 */
function emitSuccess(io, asJson, command, data, human) {
  if (asJson) {
    io.out(`${JSON.stringify({
      schema_version: OUTPUT_SCHEMA_VERSION,
      ok: true,
      command,
      data,
    })}\n`);
    return;
  }
  io.out(`${human}\n`);
}

/**
 * Run one CLI invocation.
 *
 * Returns the exit status instead of calling `process.exit`: the process wrapper stays
 * trivial, and tests can exercise the whole path in-process.
 *
 * @param {readonly string[]} argv Arguments after the executable.
 * @param {{
 *   out?: (text: string) => void,
 *   err?: (text: string) => void,
 *   env?: Record<string, string|undefined>
 * }} [options] Injectable output sinks and environment.
 * @returns {Promise<number>} Exit status.
 */
export async function run(argv, options = {}) {
  const io = {
    out: options.out ?? ((text) => process.stdout.write(text)),
    err: options.err ?? ((text) => process.stderr.write(text)),
  };
  const env = options.env ?? process.env;
  // Peeked before parsing so a parse failure still honours the caller's output mode.
  const asJson = argv.some((argument) => argument === '--json' || argument.startsWith('--json='));

  let parsed;
  try {
    parsed = parseArgs({ args: [...argv], options: OPTIONS, allowPositionals: true, strict: true });
  } catch (error) {
    return emitFailure(io, asJson, parseFailure(error), null);
  }

  const values = parsed.values;
  const positionals = parsed.positionals;

  if (values.help === true || positionals[0] === 'help') {
    // `--json` is a promise about the output stream, not about one command: usage text is
    // prose, so it is wrapped rather than printed raw. A consumer that passed --json must
    // never have to special-case which command produced non-JSON output.
    if (asJson) {
      io.out(`${JSON.stringify({
        schema_version: OUTPUT_SCHEMA_VERSION,
        ok: true,
        command: 'help',
        data: { usage: USAGE },
      })}\n`);
      return CLI_EXIT.OK;
    }
    io.out(USAGE);
    return CLI_EXIT.OK;
  }

  const command = positionals[0] ?? null;
  if (command === null) {
    return emitFailure(
      io,
      asJson,
      new CliError(CLI_CODES.USAGE, `no command given; expected one of: ${COMMANDS.join(', ')}`),
      null,
    );
  }
  if (!COMMANDS.includes(command)) {
    return emitFailure(
      io,
      asJson,
      new CliError(
        CLI_CODES.USAGE,
        `unknown command "${sanitizeText(command, 40)}"; expected one of: ${COMMANDS.join(', ')}`,
        { command: 'unknown' },
      ),
      null,
    );
  }

  const allowedPositionals = command === 'analysis' ? 2 : 1;
  if (positionals.length > allowedPositionals) {
    // Naming the expected shape beats reporting a count: "no more than 0 argument(s)"
    // describes the parser's arithmetic, not the command, and reads like an off-by-one.
    const message = command === 'analysis'
      ? 'analysis accepts one optional <id> and nothing after it — run aegis-cli --help'
      : `${command} accepts no positional arguments — run aegis-cli --help`;
    return emitFailure(io, asJson, new CliError(CLI_CODES.USAGE, message, { command }), command);
  }

  // The identifier is validated with the rest of the arguments, before the configuration
  // is loaded. Same class of mistake, same exit code: an unsafe id is a usage error
  // whether or not a readable configuration happens to exist on this machine.
  let analysisId = null;
  if (command === 'analysis' && positionals[1] !== undefined) {
    try {
      analysisId = assertAnalysisId(positionals[1]);
    } catch (error) {
      return emitFailure(io, asJson, toCliError(error), command);
    }
  }

  // Detail mode reads one job from `/api/v1/analysis/<id>`, which has no page size and no
  // page at all. A paging flag used to be accepted here and then silently dropped, so a
  // script that meant to page the list instead got a plausible-looking single document.
  // Refuse every one of them while still on usage errors, before the configuration is
  // loaded: the flag is wrong whether or not this machine has a readable config.
  if (analysisId !== null) {
    for (const flag of PAGING_FLAGS) {
      if (values[flag] !== undefined) {
        return emitFailure(
          io,
          asJson,
          new CliError(
            CLI_CODES.USAGE,
            `analysis <id> is detail mode and does not accept --${flag}; omit --${flag}, or drop the id to list jobs`,
            { command },
          ),
          command,
        );
      }
    }
  }

  // Usage validation happens before configuration loading on purpose: "you typed a bad
  // flag" must not be reported as "your configuration is broken", and a usage error must
  // not require a readable config file to be diagnosed.
  let timeoutOverride = null;
  if (values.timeout !== undefined) {
    const candidate = Number(values.timeout);
    if (!Number.isInteger(candidate) || candidate < TIMEOUT_RANGE.min || candidate > TIMEOUT_RANGE.max) {
      return emitFailure(
        io,
        asJson,
        new CliError(
          CLI_CODES.USAGE,
          `--timeout must be an integer in ${TIMEOUT_RANGE.min}..${TIMEOUT_RANGE.max}`,
          { command },
        ),
        command,
      );
    }
    timeoutOverride = candidate;
  }

  const acceptsPaging = command === 'alerts' || command === 'analysis';
  if (!acceptsPaging) {
    for (const flag of PAGING_FLAGS) {
      if (values[flag] !== undefined) {
        return emitFailure(
          io,
          asJson,
          new CliError(CLI_CODES.USAGE, `--${flag} is only accepted by alerts and analysis`, { command }),
          command,
        );
      }
    }
  }
  let limit = DEFAULT_LIMIT;
  if (values.limit !== undefined) {
    try {
      limit = parseLimit(values.limit);
    } catch (error) {
      return emitFailure(io, asJson, toCliError(error), command);
    }
  }

  let cursor = null;
  if (values.cursor !== undefined) {
    try {
      cursor = parseCursor(values.cursor);
    } catch (error) {
      return emitFailure(io, asJson, toCliError(error), command);
    }
  }

  const follow = values.all === true;
  let maxPages = DEFAULT_MAX_PAGES;
  if (values['max-pages'] !== undefined) {
    // Refused rather than ignored. `--max-pages` describes how far a walk may go, and a
    // command that is not walking has no answer to that question; accepting the flag
    // would let a script believe it had bounded a read it never started.
    if (!follow) {
      return emitFailure(
        io,
        asJson,
        new CliError(
          CLI_CODES.USAGE,
          '--max-pages bounds --all and is meaningless without it; pass --all, or omit --max-pages',
          { command },
        ),
        command,
      );
    }
    try {
      maxPages = parseMaxPages(values['max-pages']);
    } catch (error) {
      return emitFailure(io, asJson, toCliError(error), command);
    }
  }

  let config;
  try {
    config = loadCliConfig({ configPath: values.config ?? null, env });
  } catch (error) {
    return emitFailure(io, asJson, toCliError(error), command);
  }
  const timeoutMs = timeoutOverride ?? config.timeoutMs;

  const client = createLoopbackClient({
    endpoint: config.endpoint,
    timeoutMs,
    maxResponseBytes: config.maxResponseBytes,
  });

  try {
    if (command === 'status') {
      const view = await fetchStatus(client, config.loadToken());
      emitSuccess(io, asJson, command, view, renderStatus(view));
      return CLI_EXIT.OK;
    }

    if (command === 'health') {
      const view = await fetchHealth(client);
      if (view.ok) {
        emitSuccess(io, asJson, command, view, renderHealth(view));
        return CLI_EXIT.OK;
      }
      // A daemon that answers but cannot serve is a real, actionable state: report it
      // with its own exit code instead of pretending the probe succeeded.
      const unready = new CliError(
        CLI_CODES.UNHEALTHY,
        'the daemon answered but is not ready to serve; see the reported reasons',
      );
      if (asJson) {
        return emitFailure(io, asJson, unready, command, view);
      }
      io.err(`${renderHealth(view)}\n`);
      return emitFailure(io, asJson, unready, command);
    }

    if (command === 'alerts') {
      const view = await fetchAlerts(client, {
        token: config.loadToken(),
        limit,
        cursor,
        follow,
        maxPages,
      });
      emitSuccess(io, asJson, command, view, renderAlerts(view));
      return CLI_EXIT.OK;
    }

    const view = await fetchAnalysis(client, {
      token: config.loadToken(),
      limit,
      cursor,
      follow,
      maxPages,
      id: analysisId,
    });
    emitSuccess(io, asJson, command, view, renderAnalysis(view));
    return CLI_EXIT.OK;
  } catch (error) {
    return emitFailure(io, asJson, toCliError(error), command);
  }
}
