const SUPPORTED_COMMANDS = new Set(['compress', 'extract', 'checksum', 'patch']);

export function commandArgsToRunRequest(args, { includeJson = false } = {}) {
  const { command, index: commandIndex, subcommand } = locateCommand(args);
  const parsed = parseCommandTokens(args, commandIndex);
  const output = {};
  if (includeJson && parsed.flags.has('json')) output.json = true;
  const logLevel = readOptionalLogLevel(parsed);
  if (logLevel) output.log_level = logLevel;
  else if (parsed.flags.has('quiet')) output.log_level = 'error';
  else if (readFlagCount(parsed, 'verbose') > 0) {
    output.log_level = ['info', 'debug', 'trace'][Math.min(readFlagCount(parsed, 'verbose'), 3) - 1];
  }
  if (parsed.flags.has('dep-trace')) output.dep_trace = true;
  if (parsed.flags.has('progress')) output.progress = true;
  if (parsed.flags.has('no-progress')) output.progress = false;

  const commandRequest = createCommandRequest(command, subcommand);
  const commandArgs = command === 'patch' ? commandRequest.args.args : commandRequest.args;
  switch (command === 'patch' ? `patch-${subcommand}` : command) {
    case 'compress':
      Object.assign(commandArgs, {
        input: parsed.positionals,
        output: requireOptionValue(parsed, 'output'),
        ...(readOptionalValue(parsed, 'format') ? { format: readOptionalValue(parsed, 'format') } : {}),
        ...(readOptionValues(parsed, 'codec').length ? { codec: readOptionValues(parsed, 'codec') } : {}),
        ...(readOptionalValue(parsed, 'level') ? { level: readOptionalValue(parsed, 'level') } : {}),
      });
      break;
    case 'extract':
      Object.assign(commandArgs, {
        input: requirePositional(parsed, 0, 'extract source'),
        output: requireOptionValue(parsed, 'out-dir'),
        ...(readOptionValues(parsed, 'select').length ? { select: readOptionValues(parsed, 'select') } : {}),
        ...filterFlags(parsed),
        ...(readOptionValues(parsed, 'checksum').length ? { checksum: readOptionValues(parsed, 'checksum') } : {}),
        ...(parsed.flags.has('split-bin') ? { split_bin: true } : {}),
        ...(parsed.flags.has('no-ignore') ? { no_ignore: true } : {}),
        ...(parsed.flags.has('no-nested-extract') ? { no_nested_extract: true } : {}),
        // Old default allowed overwrite; `--no-overwrite` opted into failing.
        // The new wire field inverts that: force overwrite unless opted out.
        force: !parsed.flags.has('no-overwrite'),
      });
      break;
    case 'checksum':
      Object.assign(commandArgs, {
        input: requirePositional(parsed, 0, 'checksum source'),
        algo: readOptionValues(parsed, 'algo'),
        ...(readOptionValues(parsed, 'select').length ? { select: readOptionValues(parsed, 'select') } : {}),
        ...filterFlags(parsed),
        ...(parsed.flags.has('no-extract') ? { no_extract: true } : {}),
        ...(parsed.flags.has('no-ignore') ? { no_ignore: true } : {}),
        ...(parsed.flags.has('strip-header') ? { strip_header: true } : {}),
        ...(parsed.flags.has('no-trim-fix') ? { no_trim_fix: true } : {}),
        ...(readOptionalNumber(parsed, 'start') !== null ? { start: readOptionalNumber(parsed, 'start') } : {}),
        ...(readOptionalNumber(parsed, 'length') !== null ? { length: readOptionalNumber(parsed, 'length') } : {}),
      });
      break;
    case 'patch-create':
      Object.assign(commandArgs, {
        original: requireOptionValue(parsed, 'original'),
        modified: requireOptionValue(parsed, 'modified'),
        format: requireOptionValue(parsed, 'format'),
        output: requireOptionValue(parsed, 'output'),
        ...(parsed.flags.has('ignore-checksum-validation') ? { ignore_checksum_validation: true } : {}),
        ...(readOptionalValue(parsed, 'xdelta-secondary')
          ? { xdelta_secondary: readOptionalValue(parsed, 'xdelta-secondary') }
          : {}),
      });
      break;
    case 'patch-apply':
      Object.assign(commandArgs, {
        input: requireOptionValue(parsed, 'input'),
        patches: readOptionValues(parsed, 'patch'),
        output: requireOptionValue(parsed, 'output'),
        ...(readOptionValues(parsed, 'select').length ? { select: readOptionValues(parsed, 'select') } : {}),
        ...filterFlags(parsed),
        ...(parsed.flags.has('no-extract') ? { no_extract: true } : {}),
        ...(parsed.flags.has('no-ignore') ? { no_ignore: true } : {}),
        ...(parsed.flags.has('no-compress') ? { no_compress: true } : {}),
        ...(readOptionalValue(parsed, 'compress-format')
          ? { compress_format: readOptionalValue(parsed, 'compress-format') }
          : {}),
        ...(readOptionValues(parsed, 'compress-codec').length
          ? { compress_codec: readOptionValues(parsed, 'compress-codec') }
          : {}),
        ...(readOptionalValue(parsed, 'compress-level')
          ? { compress_level: readOptionalValue(parsed, 'compress-level') }
          : {}),
        ...(readOptionValues(parsed, 'checksum-cache').length
          ? { assume_in: readOptionValues(parsed, 'checksum-cache') }
          : {}),
        ...(readOptionValues(parsed, 'validate-with-checksum').length
          ? { expect_in: readOptionValues(parsed, 'validate-with-checksum') }
          : {}),
        ...(parsed.flags.has('strip-header') ? { strip_header: true } : {}),
        ...(parsed.flags.has('add-header') ? { add_header: true } : {}),
        ...(parsed.flags.has('repair-checksum') ? { repair_checksum: true } : {}),
        ...(parsed.flags.has('ignore-checksum-validation') ? { ignore_checksum_validation: true } : {}),
      });
      break;
    case 'patch-validate':
      Object.assign(commandArgs, {
        input: requireOptionValue(parsed, 'input'),
        patches: readOptionValues(parsed, 'patch'),
        ...(readOptionValues(parsed, 'select').length ? { select: readOptionValues(parsed, 'select') } : {}),
        ...filterFlags(parsed),
        ...(parsed.flags.has('no-extract') ? { no_extract: true } : {}),
        ...(parsed.flags.has('no-ignore') ? { no_ignore: true } : {}),
        ...(readOptionValues(parsed, 'checksum-cache').length
          ? { assume_in: readOptionValues(parsed, 'checksum-cache') }
          : {}),
        ...(expectInTokens(parsed).length ? { expect_in: expectInTokens(parsed) } : {}),
        ...(parsed.flags.has('strip-header') ? { strip_header: true } : {}),
        ...(parsed.flags.has('ignore-checksum-validation') ? { ignore_checksum_validation: true } : {}),
      });
      break;
    default:
      throw new Error(`unsupported command: ${command === 'patch' ? `patch ${subcommand}` : command}`);
  }

  const threads = readOptionalThreadBudget(parsed);
  if (threads !== null) commandArgs.threads = threads;

  return Object.keys(output).length > 0 ? { command: commandRequest, output } : commandRequest;
}

export function locateCommand(args) {
  for (let index = 0; index < args.length; index += 1) {
    const token = String(args[index] ?? '').trim().toLowerCase();
    if (token === 'patch') {
      const subcommand = String(args[index + 1] ?? '').trim().toLowerCase();
      if (subcommand === 'apply' || subcommand === 'create' || subcommand === 'validate') {
        return { command: 'patch', index, subcommand };
      }
      throw new Error(`unsupported patch subcommand: ${subcommand || '(missing)'}`);
    }
    if (SUPPORTED_COMMANDS.has(token)) {
      return { command: token, index, subcommand: '' };
    }
  }
  throw new Error(`unable to locate supported command in args: ${args.join(' ')}`);
}

function createCommandRequest(command, subcommand) {
  if (command === 'patch') {
    return { type: 'patch', args: { type: subcommand, args: {} } };
  }
  return { type: command, args: {} };
}

function filterFlags(parsed) {
  const filter = [];
  if (parsed.flags.has('rom-filter')) filter.push('rom');
  if (parsed.flags.has('patch-filter')) filter.push('patch');
  return filter.length > 0 ? { filter } : {};
}

function expectInTokens(parsed) {
  const tokens = [...readOptionValues(parsed, 'validate-with-checksum')];
  const size = readOptionalNumber(parsed, 'validate-with-size');
  if (size !== null) tokens.push(`size=${size}`);
  const minSize = readOptionalNumber(parsed, 'validate-with-min-size');
  if (minSize !== null) tokens.push(`min-size=${minSize}`);
  return tokens;
}

function parseCommandTokens(args, commandIndex) {
  const flags = new Set();
  const flagCounts = new Map();
  const options = new Map();
  const positionals = [];

  for (let index = 0; index < args.length; index += 1) {
    if (index === commandIndex) {
      if (String(args[index] ?? '').trim().toLowerCase() === 'patch') index += 1;
      continue;
    }
    const raw = String(args[index] ?? '');
    const shortFlags = /^-([vq]+)$/.exec(raw);
    if (shortFlags) {
      for (const shortFlag of shortFlags[1]) {
        const name = shortFlag === 'v' ? 'verbose' : 'quiet';
        flags.add(name);
        flagCounts.set(name, (flagCounts.get(name) ?? 0) + 1);
      }
      continue;
    }
    if (!raw.startsWith('--')) {
      if (index > commandIndex) positionals.push(raw);
      continue;
    }

    const withoutPrefix = raw.slice(2);
    const equalsIndex = withoutPrefix.indexOf('=');
    const name = equalsIndex >= 0 ? withoutPrefix.slice(0, equalsIndex) : withoutPrefix;
    let value = equalsIndex >= 0 ? withoutPrefix.slice(equalsIndex + 1) : null;
    if (
      value === null &&
      (index > commandIndex || name === 'log-level') &&
      !['json', 'progress', 'no-progress', 'dep-trace', 'verbose', 'quiet'].includes(name) &&
      index + 1 < args.length &&
      !String(args[index + 1] ?? '').startsWith('--')
    ) {
      value = String(args[index + 1]);
      index += 1;
    }
    if (value === null) {
      flags.add(name);
      flagCounts.set(name, (flagCounts.get(name) ?? 0) + 1);
      continue;
    }
    const values = options.get(name) ?? [];
    values.push(value);
    options.set(name, values);
  }

  return { flags, flagCounts, options, positionals };
}

function readOptionValues(parsed, name) {
  return parsed.options.get(name) ?? [];
}

function readOptionalValue(parsed, name) {
  return readOptionValues(parsed, name)[0] ?? null;
}

function readFlagCount(parsed, name) {
  return parsed.flagCounts.get(name) ?? 0;
}

function readOptionalLogLevel(parsed) {
  const value = readOptionalValue(parsed, 'log-level');
  if (value === null) return null;
  if (!['off', 'error', 'warn', 'info', 'debug', 'trace'].includes(value)) {
    throw new Error('log-level must be one of off, error, warn, info, debug, trace');
  }
  return value;
}

function readOptionalNumber(parsed, name) {
  const value = readOptionalValue(parsed, name);
  if (value === null) return null;
  const parsedNumber = Number.parseInt(value, 10);
  if (!Number.isFinite(parsedNumber) || parsedNumber < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return parsedNumber;
}

function readOptionalThreadBudget(parsed) {
  const value = readOptionalValue(parsed, 'threads');
  if (value === null) return null;
  const normalized = String(value).trim().toLowerCase();
  if (normalized === 'auto') return 'auto';
  const parsedNumber = Number.parseInt(normalized, 10);
  if (!Number.isInteger(parsedNumber) || parsedNumber <= 0) {
    throw new Error('threads must be auto or a positive integer');
  }
  return parsedNumber;
}

function requireOptionValue(parsed, name) {
  const value = readOptionalValue(parsed, name);
  if (!value) throw new Error(`missing required --${name}`);
  return value;
}

function requirePositional(parsed, index, label) {
  const value = parsed.positionals[index];
  if (!value) throw new Error(`missing ${label}`);
  return value;
}
