import fs from 'node:fs';
import path from 'node:path';

function arg(flag: string, def: string): string {
  const i = process.argv.indexOf(flag);

  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
}

function parseRegex(input: string): RegExp {
  if (input.startsWith('/') && input.lastIndexOf('/') > 0) {
    const last = input.lastIndexOf('/');

    return new RegExp(input.slice(1, last), input.slice(last + 1));
  }

  return new RegExp(input);
}

const ROOT: string = process.cwd();
const INPUT: string = path.resolve(ROOT, arg('--in', 'docs/typedoc.json'));
const OUTDIR: string = path.resolve(ROOT, arg('--out', 'docs/capabilities'));
const CLASS_RE: RegExp = parseRegex(arg('--classPattern', '/Service$/'));

/* ------------------ TypeDoc typings ------------------ */

interface TextPart {
  kind?: string;
  text?: string;
}

interface BlockTag {
  tag: string;
  content?: TextPart[];
}

interface Comment {
  summary?: TextPart[];
  blockTags?: BlockTag[];
}

interface Flags {
  isPrivate?: boolean;
  isProtected?: boolean;
  isExported?: boolean;
  isReadonly?: boolean;
  isOptional?: boolean;
}

type TDType =
  | { type: 'intrinsic'; name: string }
  | { type: 'reference'; name: string; typeArguments?: TDType[] }
  | { type: 'union' | 'intersection'; types: TDType[] }
  | { type: 'array'; elementType: TDType }
  | { type: 'tuple'; elements?: TDType[] }
  | { type: 'reflection'; declaration?: { children?: Reflection[]; signatures?: SignatureReflection[] } }
  | { type: 'query'; queryType: TDType }
  | { type: 'literal'; value: unknown }
  | { type: 'conditional' }
  | { type: 'indexedAccess'; objectType: TDType; indexType: TDType }
  | { type: 'templateLiteral'; head?: string; tail?: Array<{ text?: string; type: TDType }> };

interface ParameterReflection {
  name: string;
  type?: TDType;
  flags?: { isOptional?: boolean };
}

interface SignatureReflection {
  name: string;
  parameters?: ParameterReflection[];
  type?: TDType;
  comment?: Comment;
}

interface Reflection {
  id?: number;
  name?: string;
  kind?: number;
  kindString?: string; // "Class" | "Function" | "Method" | "Interface" | "Type alias" | "Enum" | "Property" | ...
  flags?: Flags;
  children?: Reflection[]; // members of classes/interfaces/enums/namespaces
  signatures?: SignatureReflection[]; // for function/method/interface-call-signatures
  comment?: Comment;
  type?: TDType; // for type aliases; sometimes properties
  defaultValue?: string; // for enum members
}

interface TypeDocRoot {
  children?: Reflection[];
}

const K = {
  Class: 128,
  Function: 64,
  Method: 2048,
  Interface: 256,
  Property: 1024,
  Enum: 4,
  EnumMember: 16,
  TypeAlias: 4194304, // TypeDoc uses a high bit for type alias
  CallSignature: 4096, // not always used; interface call signatures may be in signatures[]
};

function isClass(n: Reflection): boolean {
  return n.kind === K.Class || n.kindString === 'Class';
}

function isFunction(n: Reflection): boolean {
  return n.kind === K.Function || n.kindString === 'Function';
}

function isMethod(n: Reflection): boolean {
  return n.kind === K.Method || n.kindString === 'Method';
}

function isInterface(n: Reflection): boolean {
  return n.kind === K.Interface || n.kindString === 'Interface';
}

function isProperty(n: Reflection): boolean {
  return n.kind === K.Property || n.kindString === 'Property';
}

function isEnum(n: Reflection): boolean {
  return n.kind === K.Enum || n.kindString === 'Enum';
}

function isEnumMember(n: Reflection): boolean {
  return n.kind === K.EnumMember || n.kindString === 'Enum member' || n.kindString === 'EnumMember';
}

function isTypeAlias(n: Reflection): boolean {
  return n.kind === K.TypeAlias || n.kindString === 'Type alias' || n.kindString === 'TypeAlias';
}

/* ----------------- Text / type helpers ----------------- */

function ensureDir(p: string): void {
  fs.mkdirSync(p, {
    recursive: true,
  });
}

function readJson<T>(p: string): T {
  return JSON.parse(fs.readFileSync(p, 'utf8')) as T;
}

function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function commentText(node?: Reflection | SignatureReflection): string {
  if (!node) {
    return '';
  }

  const c: Comment | undefined = (node as Reflection).comment ?? (node as SignatureReflection).comment;
  const sum: string = (c?.summary ?? []).map((p) => p.text ?? '').join('');
  const rem: string = (c?.blockTags ?? [])
    .filter((t) => t.tag === '@remarks')
    .map((t) => (t.content ?? []).map((c2) => c2.text ?? '').join(''))
    .join(' ');

  const merged = collapse([sum, rem].filter(Boolean).join(' '));

  return merged.length > 300 ? merged.slice(0, 297) + '...' : merged;
}

function examples(node?: Reflection | SignatureReflection): string[] {
  if (!node) {
    return [];
  }

  const c: Comment | undefined = (node as Reflection).comment ?? (node as SignatureReflection).comment;

  return (c?.blockTags ?? [])
    .filter((t) => t.tag === '@example')
    .map((t) => collapse((t.content ?? []).map((c2) => c2.text ?? '').join('')))
    .filter(Boolean);
}

function typeStr(t?: TDType): string {
  if (!t) {
    return 'unknown';
  }

  switch (t.type) {
    case 'intrinsic':
      return t.name;

    case 'reference':
      return t.name + (t.typeArguments?.length ? `<${t.typeArguments.map(typeStr).join(', ')}>` : '');

    case 'union':
      return t.types.map(typeStr).join(' | ');

    case 'intersection':
      return t.types.map(typeStr).join(' & ');

    case 'array':
      return `${typeStr(t.elementType)}[]`;

    case 'tuple':
      return `[${(t.elements ?? []).map(typeStr).join(', ')}]`;

    case 'reflection': {
      // For LLM planning, keep “object”; if there are inline signatures we can try to compact them:

      const sigs = t.declaration?.signatures ?? [];

      if (sigs.length) {
        // Function type like (a: A) => B
        const s = sigs[0];
        const params = (s.parameters ?? [])
          .map((p) => `${p.name}${p.flags?.isOptional ? '?' : ''}: ${typeStr(p.type)}`)
          .join(', ');

        return `(${params}) => ${typeStr(s.type)}`;
      }

      // Could also expand children into { k: T; ... }, but that can explode tokens.

      return 'object';
    }

    case 'query':
      return typeStr(t.queryType);

    case 'literal':
      return JSON.stringify(t.value);

    case 'conditional':
      return 'Conditional';

    case 'indexedAccess':
      return `${typeStr(t.objectType)}[${typeStr(t.indexType)}]`;

    case 'templateLiteral': {
      const tail = (t.tail ?? []).map((part) => `${typeStr(part.type)}${part.text ?? ''}`).join('');

      return '`' + (t.head ?? '') + tail + '`';
    }

    default:
      return 'unknown';
  }
}

function buildSignature(owner: Reflection | SignatureReflection): string {
  const sig: SignatureReflection = (owner as Reflection).signatures?.[0] ?? (owner as SignatureReflection);
  const name: string = (owner as Reflection).name ?? sig.name ?? 'anonymous';
  const params: string[] = (sig.parameters ?? []).map(
    (p) => `${p.name}${p.flags?.isOptional ? '?' : ''}: ${typeStr(p.type)}`,
  );

  return `${name}(${params.join(', ')}): ${typeStr(sig.type)}`;
}

/* -------------------- Output types -------------------- */

interface CapabilityMethod {
  name: string;
  signature: string;
  summary: string;
  examples: string[];
}

interface CapabilityService {
  kind: 'service';
  name: string;
  fqdn: string;
  summary: string;
  methods: CapabilityMethod[];
}

interface CapabilityFunction {
  kind: 'function';
  name: string;
  fqdn: string;
  summary: string;
  signature: string;
  examples: string[];
}

interface CapabilityInterfaceMember {
  name: string;
  kind: 'property' | 'method';
  optional: boolean;
  readonly: boolean;
  typeOrSignature: string;
  summary: string;
}

interface CapabilityInterface {
  kind: 'interface';
  name: string;
  fqdn: string;
  summary: string;
  members: CapabilityInterfaceMember[];
}

interface CapabilityTypeAlias {
  kind: 'type';
  name: string;
  fqdn: string;
  summary: string;
  type: string;
}

interface CapabilityEnumMember {
  name: string;
  value?: string;
  summary: string;
}

interface CapabilityEnum {
  kind: 'enum';
  name: string;
  fqdn: string;
  summary: string;
  members: CapabilityEnumMember[];
}

type CapabilityItem =
  CapabilityService | CapabilityFunction | CapabilityInterface | CapabilityTypeAlias | CapabilityEnum;

/* -------------------- Collector -------------------- */

function collect(root: TypeDocRoot, classPattern: RegExp): CapabilityItem[] {
  const out: CapabilityItem[] = [];

  function walk(n: Reflection | undefined, stack: string[]): void {
    if (!n) {
      return;
    }

    const name: string = n.name ?? '';
    const fqdn: string = [...stack, name].filter(Boolean).join('.');
    const isExported: boolean = n.flags?.isExported ?? true;

    // Services (classes)

    if (isExported && isClass(n) && classPattern.test(name)) {
      const methods: CapabilityMethod[] = (n.children ?? [])
        .filter((c) => isMethod(c) && !c.flags?.isPrivate && !c.flags?.isProtected)
        .map((m) => ({
          name: m.name ?? '',
          signature: buildSignature(m),
          summary: commentText(m),
          examples: examples(m),
        }));

      out.push({
        kind: 'service',
        name,
        fqdn,
        summary: commentText(n),
        methods,
      });
    }

    // Exported functions

    if (isExported && isFunction(n)) {
      out.push({
        kind: 'function',
        name,
        fqdn,
        summary: commentText(n),
        signature: buildSignature(n),
        examples: examples(n),
      });
    }

    // Interfaces

    if (isExported && isInterface(n)) {
      const members: CapabilityInterfaceMember[] = (n.children ?? [])
        .filter((c) => isProperty(c) || isMethod(c))
        .map((c) => {
          const optional = !!c.flags?.isOptional;
          const readonly = !!c.flags?.isReadonly;

          if (isProperty(c)) {
            const propType: string = typeStr(c.type);

            return {
              name: c.name ?? '',
              kind: 'property',
              optional,
              readonly,
              typeOrSignature: `${c.name}${optional ? '?' : ''}: ${propType}`,
              summary: commentText(c),
            };
          }

          // method

          const sig = buildSignature(c);

          return {
            name: c.name ?? '',
            kind: 'method',
            optional,
            readonly,
            typeOrSignature: sig,
            summary: commentText(c),
          };
        });

      // Include callable signature if the interface itself has signatures (e.g., type is a function shape)

      for (const s of n.signatures ?? []) {
        const sigText = buildSignature(s);

        members.unshift({
          name: s.name || 'call',
          kind: 'method',
          optional: false,
          readonly: false,
          typeOrSignature: sigText,
          summary: commentText(s),
        });
      }

      out.push({ kind: 'interface', name, fqdn, summary: commentText(n), members });
    }

    // Type aliases

    if (isExported && isTypeAlias(n)) {
      out.push({
        kind: 'type',
        name,
        fqdn,
        summary: commentText(n),
        type: typeStr(n.type),
      });
    }

    // Enums

    if (isExported && isEnum(n)) {
      const members: CapabilityEnumMember[] = (n.children ?? []).filter(isEnumMember).map((m) => ({
        name: m.name ?? '',
        value: m.defaultValue,
        summary: commentText(m),
      }));

      out.push({
        kind: 'enum',
        name,
        fqdn,
        summary: commentText(n),
        members,
      });
    }

    for (const c of n.children ?? []) {
      walk(c, [...stack, name]);
    }
  }

  for (const c of root.children ?? []) {
    walk(c, []);
  }

  return out;
}

/* --------------------- Emitters --------------------- */

function writeOutputs(items: CapabilityItem[], outDir: string): void {
  ensureDir(outDir);

  const jsonPath: string = path.join(outDir, 'capability-map.json');

  fs.writeFileSync(jsonPath, JSON.stringify(items, null, 2), 'utf8');

  const mdParts: string[] = items.map((i) => {
    switch (i.kind) {
      case 'service': {
        const methods = i.methods
          .map((m) => ` - \`${m.signature}\`${m.summary ? ` — ${m.summary}` : ''}`)
          .join('\n');

        return `## ${i.name}\n${i.summary ? i.summary + '\n' : ''}\n**Methods**:\n${methods}\n`;
      }

      case 'function':
        return `## ${i.name}\n\`${i.signature}\`${i.summary ? ` — ${i.summary}` : ''}\n`;

      case 'interface': {
        const members = i.members
          .map((m) => ` - \`${m.typeOrSignature}\`${m.summary ? ` — ${m.summary}` : ''}`)
          .join('\n');

        return `## ${i.name} (interface)\n${i.summary ? i.summary + '\n' : ''}\n**Members**:\n${members}\n`;
      }

      case 'type':
        return `## ${i.name} (type)\n\`type ${i.name} = ${i.type}\`${i.summary ? ` — ${i.summary}` : ''}\n`;

      case 'enum': {
        const members = i.members
          .map(
            (m) =>
              ` - \`${m.name}${m.value !== undefined ? ` = ${m.value}` : ''}\`${m.summary ? ` — ${m.summary}` : ''}`,
          )
          .join('\n');

        return `## ${i.name} (enum)\n${i.summary ? i.summary + '\n' : ''}\n**Members**:\n${members}\n`;
      }
    }
  });

  const mdPath: string = path.join(outDir, 'capability-map.md');

  fs.writeFileSync(mdPath, mdParts.join('\n'), 'utf8');

  console.log(`Wrote:\n - ${path.relative(ROOT, jsonPath)}\n - ${path.relative(ROOT, mdPath)}`);
}

/* ----------------------- Main ----------------------- */

(function () {
  if (!fs.existsSync(INPUT)) {
    console.error(`Missing TypeDoc JSON: ${INPUT}\nRun: yarn typedoc --json ${path.relative(ROOT, INPUT)}`);

    process.exit(1);
  }

  const model: TypeDocRoot = readJson<TypeDocRoot>(INPUT);
  const items: CapabilityItem[] = collect(model, CLASS_RE);

  writeOutputs(items, OUTDIR);

  const counts = items.reduce<Record<string, number>>((acc, it) => {
    acc[it.kind] = (acc[it.kind] ?? 0) + 1;

    return acc;
  }, {});

  console.log(`Counts →`, counts, `Pattern: ${CLASS_RE}`);
})();
