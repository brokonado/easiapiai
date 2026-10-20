// The parts of Python's argparse the client uses, ported so that options are read the same way and help, usage
// and error messages come out letter for letter as the Python client prints them (Python 3.14, without colour):
// an ArgumentParser with RawDescriptionHelpFormatter, store / store_true / help / version actions, typed values
// (int, float), required options, abbreviated long options, and one level of sub-commands.
import { has, ljust, parseFloatArg, parseIntArg, pyLen, pyStr, reprStr, strip, stripChars } from "./py.mjs";

const SUPPRESS = "==SUPPRESS==";
const PARSER = "A...";
const UNRECOGNIZED = Symbol("unrecognized arguments");

// Thrown after help, a version or an error has been printed; .status is the exit status
export class ParserExit extends Error {
  constructor(status) {
    super("exit " + status);
    this.status = status;
  }
}

function actionName(action) {
  if (!action) return null;
  if (action.optionStrings.length) return action.optionStrings.join("/");
  if (action.metavar !== null) return action.metavar;
  if (action.dest !== SUPPRESS) return action.dest;
  return null;
}

class ArgumentError extends Error {
  constructor(action, message) {
    const name = actionName(action);
    super(name === null ? message : `argument ${name}: ${message}`);
  }
}

// ------------------------------------------------------------------ textwrap.wrap (for option help)

// textwrap's chunks: runs of whitespace, and words that may break after a hyphen between letters
const WORDSEP = new RegExp("([\\t\\n\\x0b\\x0c\\r ]+"
  + "|(?<=[\\w!\"'&.,?])-{2,}(?=\\w)"
  + "|[^\\t\\n\\x0b\\x0c\\r ]+?(?:-(?:(?<=[^\\d\\W]{2}-)|(?<=[^\\d\\W]-[^\\d\\W]-))(?=[^\\d\\W]-?[^\\d\\W])"
  + "|(?=[\\t\\n\\x0b\\x0c\\r ]|$)|(?<=[\\w!\"'&.,?])(?=-{2,}\\w)))");

function handleLongWord(chunks, line, lineLen, width) {
  const spaceLeft = width < 1 ? 1 : width - lineLen;
  if (spaceLeft > 0) {
    const chunk = chunks[chunks.length - 1];
    let end = spaceLeft;
    if (pyLen(chunk) > spaceLeft) {
      // break after the last hyphen that fits, if there is something other than hyphens before it
      const hyphen = chunk.lastIndexOf("-", spaceLeft - 1);
      if (hyphen > 0 && /[^-]/.test(chunk.slice(0, hyphen))) end = hyphen + 1;
    }
    line.push(chunk.slice(0, end));
    chunks[chunks.length - 1] = chunk.slice(end);
  } else if (!line.length) {
    line.push(chunks.pop());
  }
}

function wrap(text, width) {
  const chunks = text.replace(/[\t\n\x0b\x0c\r ]/g, " ").split(WORDSEP).filter((c) => c).reverse();
  const lines = [];
  while (chunks.length) {
    const line = [];
    let lineLen = 0;
    if (strip(chunks[chunks.length - 1]) === "" && lines.length) chunks.pop();
    while (chunks.length && lineLen + pyLen(chunks[chunks.length - 1]) <= width) {
      lineLen += pyLen(chunks[chunks.length - 1]);
      line.push(chunks.pop());
    }
    if (chunks.length && pyLen(chunks[chunks.length - 1]) > width) {
      handleLongWord(chunks, line, lineLen, width);
      lineLen = line.reduce((s, c) => s + pyLen(c), 0);
    }
    if (line.length && strip(line[line.length - 1]) === "") line.pop();
    if (line.length) lines.push(line.join(""));
  }
  return lines;
}

// ------------------------------------------------------------------ HelpFormatter (RawDescriptionHelpFormatter)

// shutil.get_terminal_size().columns: $COLUMNS, else the terminal's width, else 80
function terminalColumns() {
  const columns = parseIntArg(process.env.COLUMNS ?? "") ?? 0;
  if (columns > 0) return columns;
  const size = process.stdout.isTTY ? process.stdout.columns : 0;
  return size || 80;
}

function splitLines(text) {
  // str.splitlines(keepends=True)
  const breaks = "\\n\\r\\x0b\\x0c\\x1c-\\x1e\\x85\\u2028\\u2029";
  return text.match(new RegExp(`[^${breaks}]*(?:\\r\\n|[${breaks}]|$)`, "g")).filter((line) => line);
}

function metavarOf(action, fallback) {
  if (action.metavar !== null) return action.metavar;
  if (action.parsers) return "{" + [...action.parsers.keys()].join(",") + "}";
  return fallback;
}

function formatArgs(action, fallback) {
  const metavar = metavarOf(action, fallback);
  return action.nargs === PARSER ? metavar + " ..." : metavar;
}

function formatInvocation(action) {
  if (!action.optionStrings.length) return metavarOf(action, action.dest);
  if (action.nargs === 0) return action.optionStrings.join(", ");
  return action.optionStrings.join(", ") + " " + formatArgs(action, action.dest.toUpperCase());
}

class HelpFormatter {
  constructor(prog) {
    const width = terminalColumns() - 2;
    this.prog = prog;
    this.maxHelpPosition = Math.min(24, Math.max(width - 20, 4));
    this.width = width;
    this.indent = 0;
    this.actionMaxLength = 0;
    this.section = { parent: null, heading: null, items: [] };
  }

  startSection(heading) {
    this.indent += 2;
    const section = { parent: this.section, heading, items: [] };
    this.section.items.push(() => this.formatSection(section));
    this.section = section;
  }

  endSection() {
    this.section = this.section.parent;
    this.indent -= 2;
  }

  addText(text) {
    if (text !== null) this.section.items.push(() => this.formatText(text));
  }

  addUsage(actions) {
    this.section.items.push(() => this.formatUsage(actions));
  }

  addArgument(action) {
    const lengths = [pyLen(formatInvocation(action)) + this.indent];
    if (action.choicesActions) {
      this.indent += 2;
      for (const sub of action.choicesActions) lengths.push(pyLen(formatInvocation(sub)) + this.indent);
      this.indent -= 2;
    }
    this.actionMaxLength = Math.max(this.actionMaxLength, ...lengths);
    this.section.items.push(() => this.formatAction(action));
  }

  formatSection(section) {
    if (section.parent !== null) this.indent += 2;
    const itemHelp = section.items.map((item) => item()).join("");
    if (section.parent !== null) this.indent -= 2;
    if (!itemHelp) return "";
    const heading = section.heading !== null ? " ".repeat(this.indent) + section.heading + ":\n" : "";
    return "\n" + heading + itemHelp + "\n";
  }

  formatHelp() {
    let help = this.formatSection(this.section);
    if (help) help = stripChars(help.replace(/\n\n\n+/g, "\n\n"), "\n") + "\n";
    return help;
  }

  formatUsage(actions) {
    const prefix = "usage: ";
    const prog = this.prog;
    const parts = [];
    for (const a of actions.filter((x) => x.optionStrings.length)) {
      let part = a.nargs === 0 ? a.optionStrings[0]
        : a.optionStrings[0] + " " + formatArgs(a, a.dest.toUpperCase());
      if (!a.required) part = "[" + part + "]";
      parts.push(part);
    }
    const posStart = parts.length;
    for (const a of actions.filter((x) => !x.optionStrings.length)) parts.push(formatArgs(a, a.dest));
    let usage = [prog, ...parts].filter((p) => p).join(" ");

    // wrap the usage parts if it's too long
    const textWidth = this.width - this.indent;
    if (prefix.length + pyLen(usage) > textWidth) {
      const optParts = parts.slice(0, posStart);
      const posParts = parts.slice(posStart);
      const getLines = (items, indent, first = null) => {
        const out = [];
        let line = [];
        let lineLen = first !== null ? first.length - 1 : indent.length - 1;
        for (const part of items) {
          if (lineLen + 1 + pyLen(part) > textWidth && line.length) {
            out.push(indent + line.join(" "));
            line = [];
            lineLen = indent.length - 1;
          }
          line.push(part);
          lineLen += pyLen(part) + 1;
        }
        if (line.length) out.push(indent + line.join(" "));
        if (first !== null) out[0] = out[0].slice(indent.length);
        return out;
      };
      let lines;
      if (prefix.length + pyLen(prog) <= 0.75 * textWidth) {
        // a short prog: the parts follow it
        const indent = " ".repeat(prefix.length + pyLen(prog) + 1);
        if (optParts.length) {
          lines = getLines([prog, ...optParts], indent, prefix);
          lines.push(...getLines(posParts, indent));
        } else if (posParts.length) {
          lines = getLines([prog, ...posParts], indent, prefix);
        } else {
          lines = [prog];
        }
      } else {
        // a long prog: on its own line
        const indent = " ".repeat(prefix.length);
        lines = getLines([...optParts, ...posParts], indent);
        if (lines.length > 1) lines = [...getLines(optParts, indent), ...getLines(posParts, indent)];
        lines = [prog, ...lines];
      }
      usage = lines.join("\n");
    }
    return prefix + usage + "\n\n";
  }

  formatText(text) {
    // RawDescriptionHelpFormatter: kept as written, each line indented
    const indent = " ".repeat(this.indent);
    return splitLines(text).map((line) => indent + line).join("") + "\n\n";
  }

  expandHelp(action) {
    if (!action.help.includes("%")) return action.help;
    const params = { default: action.default, dest: action.dest, metavar: action.metavar, prog: this.prog };
    return action.help.replace(/%\((\w+)\)s|%%/g, (m, name) => (m === "%%" ? "%" : pyStr(params[name])));
  }

  formatAction(action) {
    const helpPosition = Math.min(this.actionMaxLength + 2, this.maxHelpPosition);
    const helpWidth = Math.max(this.width - helpPosition, 11);
    const actionWidth = helpPosition - this.indent - 2;
    const invocation = formatInvocation(action);
    let header;
    let indentFirst = 0;
    if (!action.help) {
      header = " ".repeat(this.indent) + invocation + "\n";
    } else if (pyLen(invocation) <= actionWidth) {
      header = " ".repeat(this.indent) + ljust(invocation, actionWidth) + "  ";
    } else {
      header = " ".repeat(this.indent) + invocation + "\n";
      indentFirst = helpPosition;
    }
    const parts = [header];
    if (action.help && strip(action.help)) {
      const helpText = this.expandHelp(action);
      if (helpText) {
        const lines = wrap(strip(helpText.replace(/[ \t\n\r\x0b\x0c]+/g, " ")), helpWidth);
        parts.push(" ".repeat(indentFirst) + lines[0] + "\n");
        for (const line of lines.slice(1)) parts.push(" ".repeat(helpPosition) + line + "\n");
      }
    } else if (!header.endsWith("\n")) {
      parts.push("\n");
    }
    if (action.choicesActions) {
      this.indent += 2;
      for (const sub of action.choicesActions) parts.push(this.formatAction(sub));
      this.indent -= 2;
    }
    return parts.join("");
  }
}

// ------------------------------------------------------------------ ArgumentParser

function nargsPattern(action) {
  const option = action.optionStrings.length > 0;
  if (action.nargs === null) return option ? "([A])" : "(-*A-*)";
  if (action.nargs === PARSER) return option ? "(A[AO]*)" : "(-*A[-AO]*)";
  return option ? "()" : "(-*)"; // nargs 0
}

export class ArgumentParser {
  constructor({ prog, description = null, epilog = null }) {
    this.prog = prog;
    this.description = description;
    this.epilog = epilog;
    this.actions = [];
    this.optionMap = new Map();
    this.defaults = {};
    this.addArgument(["-h", "--help"], { kind: "help", help: "show this help message and exit" });
  }

  // kind: "store" (default), "store_true", "help" or "version"
  addArgument(optionStrings, {
    kind = "store", dest = null, metavar = null, help = null, required = false, type = null, version = null,
    ...rest
  } = {}) {
    const long = optionStrings.find((s) => s.length > 1 && s[1] === "-");
    const action = {
      optionStrings, kind, metavar, help, required, type, version,
      dest: dest ?? (kind === "help" || kind === "version" ? SUPPRESS
        : stripChars(long ?? optionStrings[0], "-").replaceAll("-", "_")),
      nargs: kind === "store" ? null : 0,
      default: "default" in rest ? rest.default : kind === "store_true" ? false
        : kind === "help" || kind === "version" ? SUPPRESS : null,
    };
    this.actions.push(action);
    for (const s of optionStrings) this.optionMap.set(s, action);
    return action;
  }

  setDefaults(values) {
    Object.assign(this.defaults, values);
  }

  // add_subparsers(dest=..., metavar=...): returns an object whose addParser(name, {help, description}) makes a
  // sub-command parser
  addSubparsers({ dest, metavar }) {
    const action = {
      optionStrings: [], kind: "parsers", dest, metavar, help: null, required: false, type: null,
      nargs: PARSER, default: null, parsers: new Map(), choicesActions: [],
    };
    this.actions.push(action);
    return {
      addParser: (name, { help = null, description = null, epilog = null } = {}) => {
        const parser = new ArgumentParser({ prog: `${this.prog} ${name}`, description, epilog });
        if (help !== null) { // a sub-command without help is not listed
          action.choicesActions.push({
            optionStrings: [], kind: "choice", dest: name, metavar: name, help, nargs: null, required: false,
          });
        }
        action.parsers.set(name, parser);
        return parser;
      },
    };
  }

  formatUsage() {
    const f = new HelpFormatter(this.prog);
    f.addUsage(this.actions);
    return f.formatHelp();
  }

  formatHelp() {
    const f = new HelpFormatter(this.prog);
    f.addUsage(this.actions);
    f.addText(this.description);
    for (const [title, wanted] of [["positional arguments", false], ["options", true]]) {
      f.startSection(title);
      for (const a of this.actions) if ((a.optionStrings.length > 0) === wanted) f.addArgument(a);
      f.endSection();
    }
    f.addText(this.epilog);
    return f.formatHelp();
  }

  error(message) {
    process.stderr.write(this.formatUsage());
    process.stderr.write(`${this.prog}: error: ${message}\n`);
    throw new ParserExit(2);
  }

  parseArgs(args) {
    const [ns, extras] = this.parseKnownArgs(args, {});
    if (extras.length) this.error("unrecognized arguments: " + extras.join(" "));
    return ns;
  }

  parseKnownArgs(args, ns) {
    for (const a of this.actions) {
      if (a.dest !== SUPPRESS && !has(ns, a.dest) && a.default !== SUPPRESS) ns[a.dest] = a.default;
    }
    for (const [k, v] of Object.entries(this.defaults)) if (!has(ns, k)) ns[k] = v;
    let extras;
    try {
      extras = this.parseKnown(args, ns);
    } catch (err) {
      if (err instanceof ArgumentError) this.error(err.message);
      throw err;
    }
    if (ns[UNRECOGNIZED]) {
      extras.push(...ns[UNRECOGNIZED]);
      delete ns[UNRECOGNIZED];
    }
    return [ns, extras];
  }

  // Which known options an argument could be: [[action, option string, separator, explicit value]], an empty list
  // for none
  optionTuples(arg) {
    const result = [];
    const eq = arg.indexOf("=");
    const prefix = eq >= 0 ? arg.slice(0, eq) : arg;
    const sep = eq >= 0 ? "=" : null;
    const explicit = eq >= 0 ? arg.slice(eq + 1) : null;
    if (arg[1] === "-") {
      for (const [s, action] of this.optionMap) if (s.startsWith(prefix)) result.push([action, s, sep, explicit]);
    } else {
      // a single-dash option can carry its value directly: -n5
      for (const [s, action] of this.optionMap) {
        if (s === arg.slice(0, 2)) result.push([action, s, "", arg.slice(2)]);
        else if (s.startsWith(prefix)) result.push([action, s, sep, explicit]);
      }
    }
    return result;
  }

  // null for a positional argument, else the option tuples (one with action null for an unknown option)
  parseOptional(arg) {
    if (!arg || arg[0] !== "-") return null;
    if (this.optionMap.has(arg)) return [[this.optionMap.get(arg), arg, null, null]];
    if (pyLen(arg) === 1) return null;
    const eq = arg.indexOf("=");
    if (eq >= 0 && this.optionMap.has(arg.slice(0, eq))) {
      return [[this.optionMap.get(arg.slice(0, eq)), arg.slice(0, eq), "=", arg.slice(eq + 1)]];
    }
    const tuples = this.optionTuples(arg);
    if (tuples.length) return tuples;
    if (/^-\.?\p{Nd}/u.test(arg)) return null; // looks like a negative number
    if (arg.includes(" ")) return null;
    return [[null, arg, null, null]];
  }

  matchArgument(action, pattern) {
    const m = new RegExp("^" + nargsPattern(action)).exec(pattern);
    if (!m) throw new ArgumentError(action, "expected one argument");
    return m[1].length;
  }

  matchPartial(actions, pattern) {
    for (let i = actions.length; i > 0; i--) {
      const m = new RegExp("^" + actions.slice(0, i).map(nargsPattern).join("")).exec(pattern);
      if (m) {
        const result = m.slice(1).map((s) => s.length);
        if (m[0].length < pattern.length && pattern[m[0].length] === "O") {
          while (result.length && !result[result.length - 1]) result.pop();
        }
        return result;
      }
    }
    return [];
  }

  getValue(action, s) {
    if (action.type === "int" || action.type === "float") {
      const v = action.type === "int" ? parseIntArg(s) : parseFloatArg(s);
      if (v === null) throw new ArgumentError(action, `invalid ${action.type} value: ${reprStr(s)}`);
      return v;
    }
    return s;
  }

  takeAction(action, args, ns) {
    if (action.nargs === PARSER) {
      const [name, ...rest] = args;
      if (!action.parsers.has(name)) {
        throw new ArgumentError(action, `invalid choice: ${reprStr(name)} `
          + `(choose from ${[...action.parsers.keys()].join(", ")})`);
      }
      ns[action.dest] = name;
      const [sub, extras] = action.parsers.get(name).parseKnownArgs(rest, {});
      Object.assign(ns, sub);
      if (extras.length) ns[UNRECOGNIZED] = [...(ns[UNRECOGNIZED] ?? []), ...extras];
    } else if (action.kind === "store") {
      ns[action.dest] = this.getValue(action, args[0]);
    } else if (action.kind === "store_true") {
      ns[action.dest] = true;
    } else if (action.kind === "help") {
      process.stdout.write(this.formatHelp());
      throw new ParserExit(0);
    } else if (action.kind === "version") {
      process.stdout.write(action.version + "\n");
      throw new ParserExit(0);
    }
  }

  // _parse_known_args: options and positionals in turn; returns the arguments nobody took
  parseKnown(argStrings, ns) {
    const optionIndices = new Map();
    const pat = [];
    for (let i = 0; i < argStrings.length; i++) {
      if (argStrings[i] === "--") {
        pat.push("-");
        for (i++; i < argStrings.length; i++) pat.push("A");
        break;
      }
      const tuples = this.parseOptional(argStrings[i]);
      if (tuples === null) {
        pat.push("A");
      } else {
        optionIndices.set(i, tuples);
        pat.push("O");
      }
    }
    const pattern = pat.join("");
    const seen = new Set();
    const extras = [];
    const take = (action, args) => {
      seen.add(action);
      this.takeAction(action, args, ns);
    };

    const consumeOptional = (startIndex) => {
      const tuples = optionIndices.get(startIndex);
      if (tuples.length > 1) {
        throw new ArgumentError(null, `ambiguous option: ${argStrings[startIndex]} could match `
          + tuples.map((t) => t[1]).join(", "));
      }
      let [action, optionString, sep, explicit] = tuples[0];
      const taken = [];
      let stop;
      for (;;) {
        if (action === null) {
          extras.push(argStrings[startIndex]);
          return startIndex + 1;
        }
        if (explicit !== null) {
          const count = this.matchArgument(action, "A");
          if (count === 0 && optionString[1] !== "-" && explicit !== "") {
            // -xyz: more single-dash flags in the same argument
            const chars = Array.from(explicit);
            if (sep || chars[0] === "-") throw new ArgumentError(action, `ignored explicit argument ${reprStr(explicit)}`);
            taken.push([action, []]);
            optionString = optionString[0] + chars[0];
            if (this.optionMap.has(optionString)) {
              action = this.optionMap.get(optionString);
              explicit = chars.slice(1).join("");
              if (!explicit) {
                sep = null;
                explicit = null;
              } else if (explicit[0] === "=") {
                sep = "=";
                explicit = explicit.slice(1);
              } else {
                sep = "";
              }
            } else {
              extras.push(optionString[0] + explicit);
              stop = startIndex + 1;
              break;
            }
          } else if (count === 1) {
            stop = startIndex + 1;
            taken.push([action, [explicit]]);
            break;
          } else {
            throw new ArgumentError(action, `ignored explicit argument ${reprStr(explicit)}`);
          }
        } else {
          const start = startIndex + 1;
          stop = start + this.matchArgument(action, pattern.slice(start));
          taken.push([action, argStrings.slice(start, stop)]);
          break;
        }
      }
      for (const [a, args] of taken) take(a, args);
      return stop;
    };

    let positionals = this.actions.filter((a) => !a.optionStrings.length);
    const consumePositionals = (startIndex) => {
      const counts = this.matchPartial(positionals, pattern.slice(startIndex));
      counts.forEach((count, k) => {
        const action = positionals[k];
        const args = argStrings.slice(startIndex, startIndex + count);
        // the first "--" is not an argument
        if (action.nargs === PARSER ? pattern[startIndex] === "-"
          : pattern.slice(startIndex, startIndex + count).includes("-")) {
          args.splice(args.indexOf("--"), 1);
        }
        startIndex += count;
        take(action, args);
      });
      positionals = positionals.slice(counts.length);
      return startIndex;
    };

    let start = 0;
    const maxOption = optionIndices.size ? Math.max(...optionIndices.keys()) : -1;
    while (start <= maxOption) {
      let next = start;
      while (next <= maxOption && !optionIndices.has(next)) next++;
      if (start !== next) {
        const end = consumePositionals(start);
        if (end > start) {
          start = end;
          continue;
        }
        start = end;
      }
      if (!optionIndices.has(start)) {
        extras.push(...argStrings.slice(start, next));
        start = next;
      }
      start = consumeOptional(start);
    }
    extras.push(...argStrings.slice(consumePositionals(start)));

    const required = this.actions.filter((a) => a.required && !seen.has(a)).map(actionName);
    if (required.length) throw new ArgumentError(null, "the following arguments are required: " + required.join(", "));
    return extras;
  }
}
