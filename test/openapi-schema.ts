// A small checker for the part of JSON Schema the API description uses, for the contract
// tests (test/openapi-contract.test.ts).
//
// It knows exactly the keywords in KEYWORDS and throws on any other, so the description
// cannot say something this checker would silently ignore: a new keyword fails the tests
// until it is checked here. The contract tests also hold KEYWORDS equal to the set the
// description really uses, so nothing is supported that nothing uses.
//
// A value is what an answer or a request carried: parsed JSON, or a Uint8Array for a
// body the description marks `format: binary`.

type Schema = Record<string, unknown>;

/** Every keyword check() understands. `description` says nothing about a value. */
export const KEYWORDS: readonly string[] = [
  "$ref",
  "additionalProperties",
  "const",
  "description",
  "enum",
  "exclusiveMinimum",
  "format",
  "items",
  "maxItems",
  "maxLength",
  "maximum",
  "minItems",
  "minLength",
  "minimum",
  "oneOf",
  "pattern",
  "properties",
  "required",
  "type",
];

const TYPES = ["array", "boolean", "integer", "null", "number", "object", "string"];

function fail(at: string, message: string): never {
  throw new Error(`schema at ${at}: ${message}`);
}

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v) && !(v instanceof Uint8Array);
}

/** The schema a local reference such as "#/components/schemas/Tour" names. Throws when there is none. */
export function resolveRef(doc: unknown, ref: string): Schema {
  if (!ref.startsWith("#/")) throw new Error(`${ref}: only references into this document are supported`);
  let at: unknown = doc;
  for (const part of ref.slice(2).split("/")) at = isObject(at) && Object.hasOwn(at, part) ? at[part] : undefined;
  if (!isObject(at)) throw new Error(`${ref}: nothing is there`);
  return at;
}

/** Follows `$ref` until the schema is one that says something itself. */
export function deref(doc: unknown, schema: Schema): Schema {
  let s = schema;
  for (let hops = 0; typeof s.$ref === "string"; hops++) {
    if (hops > 20) throw new Error(`${String(schema.$ref)}: a reference that never ends`);
    if (Object.keys(s).some((k) => k !== "$ref" && k !== "description")) throw new Error(`${s.$ref}: a schema with $ref and other keywords is not supported`);
    s = resolveRef(doc, s.$ref);
  }
  return s;
}

function typeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (value instanceof Uint8Array) return "bytes";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  return typeof value; // string, boolean, object (undefined, bigint and the like match no type)
}

function hasType(value: unknown, type: string): boolean {
  const is = typeOf(value);
  return is === type || (type === "number" && is === "integer");
}

function primitive(at: string, keyword: string, v: unknown): string | number | boolean | null {
  if (v === null || typeof v === "string" || typeof v === "number" || typeof v === "boolean") return v;
  return fail(at, `${keyword} with a value that is not a string, a number, a boolean or null is not supported`);
}

function count(at: string, keyword: string, v: unknown): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0) fail(at, `${keyword} must be a whole number`);
  return v as number;
}

function num(at: string, keyword: string, v: unknown): number {
  if (typeof v !== "number" || !Number.isFinite(v)) fail(at, `${keyword} must be a number`);
  return v as number;
}

/** Schemas already found to use known keywords only, all the way down. */
const vetted = new WeakSet<object>();

/**
 * Throws if `schema`, or any schema inside it or behind one of its references, uses a
 * keyword this checker does not know. It looks at the whole schema, also at the parts a
 * given value never reaches (a field the value lacks, the items of an empty list).
 */
function vet(doc: unknown, schema: unknown, at: string): void {
  if (!isObject(schema)) fail(at, "a schema must be an object");
  if (vetted.has(schema)) return;
  vetted.add(schema);
  for (const [k, v] of Object.entries(schema)) {
    if (!KEYWORDS.includes(k)) fail(at, `unknown keyword "${k}"; teach test/openapi-schema.ts to check it, or do not use it`);
    if (k === "$ref" && typeof v === "string") vet(doc, resolveRef(doc, v), v);
    if (k === "properties" && isObject(v)) for (const [name, sub] of Object.entries(v)) vet(doc, sub, `${at}.${name}`);
    if (k === "items") vet(doc, v, `${at}[]`);
    if (k === "oneOf" && Array.isArray(v)) v.forEach((sub, i) => vet(doc, sub, `${at} oneOf[${i}]`));
  }
}

const show = (v: unknown) => (v instanceof Uint8Array ? `${v.byteLength} bytes` : (JSON.stringify(v) ?? String(v)).slice(0, 80));

/**
 * Checks `value` against `schema` and returns what is wrong, one line per problem with
 * the place in the value ("$.tours[0].url"); an empty list means the value fits. Throws
 * (it does not report) when the schema itself uses something this checker does not know.
 */
export function check(doc: unknown, schema: unknown, value: unknown, path = "$"): string[] {
  vet(doc, schema, path);
  if (!isObject(schema)) throw new Error(`schema at ${path}: a schema must be an object`);
  const s = deref(doc, schema);
  const problems: string[] = [];

  // `format: binary` is the one format: a body of bytes, written as a string type.
  let binary = false;
  if (Object.hasOwn(s, "format")) {
    if (s.format !== "binary" || s.type !== "string") fail(path, `format ${JSON.stringify(s.format)} is not supported (only "binary" on type "string")`);
    binary = true;
    if (!(value instanceof Uint8Array)) return [`${path}: expected bytes, got ${typeOf(value)}`];
  } else if (value instanceof Uint8Array) {
    return [`${path}: got bytes where the description has no binary format`];
  }

  if (Object.hasOwn(s, "type") && !binary) {
    const types = Array.isArray(s.type) ? s.type : [s.type];
    for (const t of types) if (typeof t !== "string" || !TYPES.includes(t)) fail(path, `unknown type ${JSON.stringify(t)}`);
    if (types.length === 0) fail(path, "an empty type list");
    if (!types.some((t) => hasType(value, t as string))) problems.push(`${path}: expected ${types.join(" or ")}, got ${typeOf(value)} ${show(value)}`);
  }

  if (Object.hasOwn(s, "const")) {
    const want = primitive(path, "const", s.const);
    if (value !== want) problems.push(`${path}: expected exactly ${JSON.stringify(want)}, got ${show(value)}`);
  }
  if (Object.hasOwn(s, "enum")) {
    if (!Array.isArray(s.enum) || s.enum.length === 0) fail(path, "enum must be a list with something in it");
    const allowed = (s.enum as unknown[]).map((v) => primitive(path, "enum", v));
    if (!allowed.some((v) => v === value)) problems.push(`${path}: expected one of ${JSON.stringify(allowed)}, got ${show(value)}`);
  }

  if (Object.hasOwn(s, "oneOf")) {
    if (!Array.isArray(s.oneOf) || s.oneOf.length === 0) fail(path, "oneOf must be a list with something in it");
    const results = (s.oneOf as unknown[]).map((branch) => check(doc, branch, value, path));
    const fitting = results.filter((r) => r.length === 0).length;
    if (fitting > 1) problems.push(`${path}: fits ${fitting} of the oneOf shapes, must fit exactly one`);
    if (fitting === 0) problems.push(`${path}: fits none of the ${results.length} oneOf shapes: ${results.map((r, i) => `[${i}] ${r.join("; ")}`).join(" | ")}`);
  }

  // Each of the following says something about one kind of value only, as in JSON Schema.
  for (const k of ["minLength", "maxLength"] as const) {
    if (!Object.hasOwn(s, k)) continue;
    const limit = count(path, k, s[k]);
    if (typeof value !== "string") continue;
    const length = [...value].length;
    if (k === "minLength" ? length < limit : length > limit) problems.push(`${path}: ${length} characters, ${k} is ${limit}`);
  }
  if (Object.hasOwn(s, "pattern")) {
    if (typeof s.pattern !== "string") fail(path, "pattern must be text");
    let re: RegExp;
    try {
      re = new RegExp(s.pattern as string, "u");
    } catch {
      return fail(path, `pattern ${JSON.stringify(s.pattern)} is not a regular expression`);
    }
    if (typeof value === "string" && !re.test(value)) problems.push(`${path}: ${show(value)} does not match ${s.pattern}`);
  }
  for (const k of ["minimum", "maximum", "exclusiveMinimum"] as const) {
    if (!Object.hasOwn(s, k)) continue;
    const limit = num(path, k, s[k]);
    if (typeof value !== "number") continue;
    const ok = k === "minimum" ? value >= limit : k === "maximum" ? value <= limit : value > limit;
    if (!ok) problems.push(`${path}: ${value} breaks ${k} ${limit}`);
  }
  for (const k of ["minItems", "maxItems"] as const) {
    if (!Object.hasOwn(s, k)) continue;
    const limit = count(path, k, s[k]);
    if (!Array.isArray(value)) continue;
    if (k === "minItems" ? value.length < limit : value.length > limit) problems.push(`${path}: ${value.length} items, ${k} is ${limit}`);
  }
  if (Object.hasOwn(s, "items")) {
    if (!isObject(s.items)) fail(path, "items must be a schema");
    if (Array.isArray(value)) value.forEach((item, i) => problems.push(...check(doc, s.items, item, `${path}[${i}]`)));
  }

  let properties: Record<string, unknown> = {};
  if (Object.hasOwn(s, "properties")) {
    if (!isObject(s.properties)) fail(path, "properties must be an object");
    properties = s.properties as Record<string, unknown>;
    for (const [name, sub] of Object.entries(properties)) {
      if (!isObject(sub)) fail(`${path}.${name}`, "a property's schema must be an object");
      if (isObject(value) && Object.hasOwn(value, name)) problems.push(...check(doc, sub, value[name], `${path}.${name}`));
    }
  }
  if (Object.hasOwn(s, "required")) {
    if (!Array.isArray(s.required) || s.required.some((r) => typeof r !== "string")) fail(path, "required must be a list of names");
    for (const name of s.required as string[]) {
      if (!Object.hasOwn(properties, name)) fail(path, `required names "${name}", which properties does not describe`);
      if (isObject(value) && !Object.hasOwn(value, name)) problems.push(`${path}: the required field "${name}" is missing`);
    }
  }
  if (Object.hasOwn(s, "additionalProperties")) {
    if (typeof s.additionalProperties !== "boolean") fail(path, "additionalProperties is supported as true or false only");
    if (s.additionalProperties === false && isObject(value)) {
      for (const name of Object.keys(value)) if (!Object.hasOwn(properties, name)) problems.push(`${path}: the field "${name}" is not in the description`);
    }
  }
  return problems;
}

/** Every keyword `schema` and the schemas inside it use, references not followed. */
export function keywordsOf(schema: unknown, into = new Set<string>()): Set<string> {
  if (!isObject(schema)) throw new Error("a schema must be an object");
  for (const [k, v] of Object.entries(schema)) {
    into.add(k);
    if (k === "properties" && isObject(v)) for (const sub of Object.values(v)) keywordsOf(sub, into);
    if (k === "items" || (k === "additionalProperties" && isObject(v))) keywordsOf(v, into);
    if (k === "oneOf" && Array.isArray(v)) for (const sub of v) keywordsOf(sub, into);
  }
  return into;
}
