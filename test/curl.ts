// Reads the `curl` commands of the documentation page's guides the way a shell and curl
// would, so test/docs-guides.test.ts can send each one to the real routes. Only the small
// subset the guides use is understood; anything else throws, so a guide cannot grow a
// command this file would misread in silence.
//
// The subset: one command, `curl`, with -X <method>, -H "<name>: <value>", -d <text>,
// --data-binary @<file> and exactly one address. Words are split as a POSIX shell splits
// them: single quotes keep everything as it is, double quotes keep everything but allow
// \" and \\, and no word may hold anything the shell would expand or act on.

export type Curl = {
  method: string;
  url: string;
  /** Header names in lower case. */
  headers: Record<string, string>;
  /** The body: text given on the command line, a file to read, or none. */
  data: { kind: "text"; text: string } | { kind: "file"; name: string } | null;
};

/** Characters a shell acts on outside quotes; none may appear there. */
const SHELL_ACTIVE = /[|&;<>()$`\\!*?[\]{}~#\n\r]/;
/** Inside double quotes these still do something in a shell. */
const ACTIVE_IN_DOUBLE = /[$`!\n\r]/;

/** The command's words, as a shell would hand them to curl. Throws on a quote left open or anything a shell would expand. */
export function shellWords(command: string): string[] {
  const words: string[] = [];
  let word: string | null = null;
  let i = 0;
  while (i < command.length) {
    const ch = command[i];
    if (ch === " " || ch === "\t") {
      if (word !== null) words.push(word);
      word = null;
      i++;
    } else if (ch === "'") {
      const end = command.indexOf("'", i + 1);
      if (end < 0) throw new Error(`a single quote is left open: ${command}`);
      word = (word ?? "") + command.slice(i + 1, end);
      i = end + 1;
    } else if (ch === '"') {
      let text = "";
      i++;
      for (;;) {
        if (i >= command.length) throw new Error(`a double quote is left open: ${command}`);
        const c = command[i];
        if (c === '"') break;
        if (c === "\\") {
          const next = command[i + 1];
          if (next !== '"' && next !== "\\") throw new Error(`a backslash inside double quotes before ${JSON.stringify(next)}: ${command}`);
          text += next;
          i += 2;
          continue;
        }
        if (ACTIVE_IN_DOUBLE.test(c)) throw new Error(`${JSON.stringify(c)} inside double quotes, which a shell would act on: ${command}`);
        text += c;
        i++;
      }
      word = (word ?? "") + text;
      i++;
    } else {
      if (SHELL_ACTIVE.test(ch)) throw new Error(`${JSON.stringify(ch)} outside quotes, which a shell would act on: ${command}`);
      word = (word ?? "") + ch;
      i++;
    }
  }
  if (word !== null) words.push(word);
  return words;
}

/** What curl would send for `command`. Throws on anything outside the subset. */
export function parseCurl(command: string): Curl {
  const words = shellWords(command);
  if (words[0] !== "curl") throw new Error(`not a curl command: ${command}`);
  let method: string | null = null;
  let url: string | null = null;
  let data: Curl["data"] = null;
  const headers: Record<string, string> = {};
  const value = (i: number, option: string): string => {
    const v = words[i];
    if (v === undefined) throw new Error(`${option} without a value: ${command}`);
    return v;
  };
  for (let i = 1; i < words.length; i++) {
    const w = words[i];
    if (w === "-X") {
      if (method !== null) throw new Error(`-X given twice: ${command}`);
      method = value(++i, "-X");
      if (!/^[A-Z]+$/.test(method)) throw new Error(`not a method: ${method}`);
    } else if (w === "-H") {
      const header = value(++i, "-H");
      const m = /^([A-Za-z0-9-]+): (.+)$/.exec(header);
      if (m === null) throw new Error(`not a header: ${header}`);
      const name = m[1].toLowerCase();
      if (Object.hasOwn(headers, name)) throw new Error(`the header ${name} is given twice: ${command}`);
      headers[name] = m[2];
    } else if (w === "-d") {
      if (data !== null) throw new Error(`a body is given twice: ${command}`);
      const text = value(++i, "-d");
      // curl reads a file for -d @name and strips its line ends; the guides do not use that.
      if (text.startsWith("@")) throw new Error(`-d with a file; the guides use --data-binary for files: ${command}`);
      data = { kind: "text", text };
    } else if (w === "--data-binary") {
      if (data !== null) throw new Error(`a body is given twice: ${command}`);
      const from = value(++i, "--data-binary");
      if (!/^@[A-Za-z0-9._-]+$/.test(from)) throw new Error(`--data-binary must name a file as @name: ${command}`);
      data = { kind: "file", name: from.slice(1) };
    } else if (w.startsWith("-")) {
      throw new Error(`an option this reader does not know: ${w}`);
    } else {
      if (url !== null) throw new Error(`more than one address: ${command}`);
      url = w;
    }
  }
  if (url === null) throw new Error(`no address: ${command}`);
  // As curl does: a body without -X is a POST, and a body without a Content-Type gets the form type.
  if (data !== null && !Object.hasOwn(headers, "content-type")) headers["content-type"] = "application/x-www-form-urlencoded";
  return { method: method ?? (data === null ? "GET" : "POST"), url, headers, data };
}
