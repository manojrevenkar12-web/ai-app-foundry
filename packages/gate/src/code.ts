/**
 * What a handler's code asks of the platform, read from its syntax tree. The gate compares this
 * with the manifest so a reviewer reads the manifest and knows what the code can touch. Anything
 * the analysis cannot pin down (a computed connector id, ctx passed around) is reported; the
 * runtime refuses undeclared capabilities either way.
 */
import { type Node, parse } from "acorn";
import { ancestor } from "acorn-walk";
import { block, type Finding, warn } from "./findings.js";

export type UseKind = "connector" | "model" | "collection" | "confirm" | "tool";
export interface Use {
  kind: UseKind;
  /** null when the code computes it */
  id: string | null;
  op: string;
  fn: string | null;
  line: number;
  column: number;
}

export interface CodeFacts {
  exports: string[];
  uses: Use[];
  findings: Finding[];
}

type AnyNode = Node & Record<string, unknown>;
const pos = (n: AnyNode) => ({
  line: (n.loc as { start: { line: number; column: number } }).start.line,
  column: (n.loc as { start: { column: number } }).start.column + 1,
});

/** ctx.connectors.call -> ["ctx", "connectors", "call"]; null if any part is computed */
const chain = (n: AnyNode): string[] | null => {
  if (n.type === "Identifier") return [n.name as string];
  if (n.type === "ThisExpression") return ["this"];
  if (n.type === "MemberExpression") {
    if (n.computed) {
      const p = n.property as AnyNode;
      if (p.type !== "Literal" || typeof p.value !== "string") return null;
      const head = chain(n.object as AnyNode);
      return head ? [...head, p.value] : null;
    }
    const head = chain(n.object as AnyNode);
    return head ? [...head, (n.property as AnyNode).name as string] : null;
  }
  if (n.type === "ChainExpression") return chain(n.expression as AnyNode);
  return null;
};

const literal = (n: AnyNode | undefined): string | null => {
  if (!n) return null;
  if (n.type === "Literal" && typeof n.value === "string") return n.value;
  if (n.type === "TemplateLiteral" && (n.expressions as unknown[]).length === 0)
    return ((n.quasis as AnyNode[])[0]?.value as { cooked: string } | undefined)?.cooked ?? null;
  return null;
};

const prop = (obj: AnyNode | undefined, name: string): AnyNode | undefined => {
  if (!obj || obj.type !== "ObjectExpression") return undefined;
  for (const p of obj.properties as AnyNode[]) {
    if (p.type !== "Property" || p.computed) continue;
    const key = p.key as AnyNode;
    if ((key.type === "Identifier" && key.name === name) || (key.type === "Literal" && key.value === name)) return p.value as AnyNode;
  }
  return undefined;
};

const enclosingFunction = (ancestors: AnyNode[]): string | null => {
  for (let i = ancestors.length - 1; i >= 0; i--) {
    const a = ancestors[i] as AnyNode;
    if (a.type === "FunctionDeclaration" && a.id) return (a.id as AnyNode).name as string;
    if ((a.type === "ArrowFunctionExpression" || a.type === "FunctionExpression") && i > 0) {
      const parent = ancestors[i - 1] as AnyNode;
      if (parent.type === "VariableDeclarator") return ((parent.id as AnyNode).name as string) ?? null;
    }
  }
  return null;
};

const CAPABILITY_ROOTS = new Set(["connectors", "llm", "store"]);

export const analyse = (code: string): CodeFacts => {
  const findings: Finding[] = [];
  let program: AnyNode;
  try {
    program = parse(code, { ecmaVersion: 2024, sourceType: "module", locations: true }) as unknown as AnyNode;
  } catch (e) {
    const err = e as { message: string; loc?: { line: number; column: number } };
    findings.push(
      block("code.syntax", `the code does not parse: ${err.message}`, err.loc ? { line: err.loc.line, column: err.loc.column + 1 } : {}),
    );
    return { exports: [], uses: [], findings };
  }

  const exports: string[] = [];
  const uses: Use[] = [];
  const consumed = new Set<AnyNode>();

  for (const st of program.body as AnyNode[]) {
    if (st.type === "ImportDeclaration")
      findings.push(block("code.import", "apps cannot import modules; the platform's ctx is the only library", pos(st)));
    if (st.type === "ExportDefaultDeclaration")
      findings.push(warn("code.default-export", "a default export cannot be called; export named handler functions", pos(st)));
    if (st.type === "ExportAllDeclaration") findings.push(block("code.import", "apps cannot re-export modules", pos(st)));
    if (st.type === "ExportNamedDeclaration") {
      const d = st.declaration as AnyNode | null;
      if (d?.type === "FunctionDeclaration") exports.push((d.id as AnyNode).name as string);
      if (d?.type === "VariableDeclaration")
        for (const v of d.declarations as AnyNode[]) {
          const init = v.init as AnyNode | null;
          if (init && (init.type === "ArrowFunctionExpression" || init.type === "FunctionExpression"))
            exports.push((v.id as AnyNode).name as string);
        }
      if (st.source) findings.push(block("code.import", "apps cannot re-export modules", pos(st)));
      for (const s of (st.specifiers as AnyNode[]) ?? [])
        exports.push(((s.exported as AnyNode).name as string) ?? String((s.exported as AnyNode).value));
    }
  }

  const visitors: Record<string, (n: AnyNode, s: unknown, anc: AnyNode[]) => void> = {
    ImportExpression(n: AnyNode) {
      findings.push(block("code.import", "apps cannot load modules at run time", pos(n)));
    },
    CallExpression(n: AnyNode, _s: unknown, anc: AnyNode[]) {
      const callee = n.callee as AnyNode;
      if (callee.type === "Identifier" && (callee.name === "eval" || callee.name === "Function"))
        findings.push(
          warn(
            "code.dynamic",
            `${callee.name} builds code the reviewer cannot read; it runs with the same limits, but the review tier rises`,
            pos(n),
          ),
        );
      const c = chain(callee);
      if (!c) return;
      const args = n.arguments as AnyNode[];
      const fn = enclosingFunction(anc);
      const at = pos(n);
      const tail = c.slice(-2).join(".");
      const record = (kind: UseKind, id: string | null, op: string) => {
        uses.push({ kind, id, op, fn, ...at });
        consumed.add(callee);
      };
      if (tail === "connectors.call") {
        const id = literal(args[0]);
        record("connector", id, "call");
        if (id === null)
          findings.push(
            warn("code.computed-capability", "the connector id is computed, so the reviewer cannot see which data this reads", at),
          );
      } else if (tail === "llm.chat" || tail === "llm.stream") {
        const opts = args[0];
        const model = literal(prop(opts, "model"));
        record("model", model, c[c.length - 1] as string);
        if (model === null)
          findings.push(warn("code.computed-capability", "the model alias is computed; declare and name it directly", at));
        const tools = prop(opts, "tools");
        if (tools) {
          if (tools.type !== "ArrayExpression")
            findings.push(warn("code.computed-capability", "the tools list is computed; list connector ids directly", at));
          else for (const t of tools.elements as AnyNode[]) record("tool", literal(t), "tool");
        }
      } else if (c.length >= 2 && c[c.length - 2] === "store" && ["get", "put", "list", "delete"].includes(c[c.length - 1] as string)) {
        const id = literal(args[0]);
        record("collection", id, c[c.length - 1] as string);
        if (id === null) findings.push(warn("code.computed-capability", "the collection name is computed", at));
      } else if (c[c.length - 1] === "confirm" && c.length >= 2) {
        const id = literal(prop(args[0], "connector"));
        record("confirm", id, "confirm");
        if (id === null) findings.push(warn("code.computed-capability", "the confirmed connector is computed", at));
      }
    },
    NewExpression(n: AnyNode) {
      const callee = n.callee as AnyNode;
      if (callee.type === "Identifier" && callee.name === "Function")
        findings.push(warn("code.dynamic", "new Function builds code the reviewer cannot read", pos(n)));
    },
    MemberExpression(n: AnyNode, _s: unknown, anc: AnyNode[]) {
      const p = n.property as AnyNode;
      if (!n.computed && p.name === "constructor")
        findings.push(warn("code.dynamic", "reaching for .constructor is a way to build code at run time", pos(n)));
      // ctx.connectors (or llm, store) used other than by calling it directly: aliasing hides uses
      if (!n.computed && CAPABILITY_ROOTS.has(p.name as string)) {
        const parent = anc[anc.length - 2];
        const direct = parent?.type === "MemberExpression" && parent.object === n;
        if (!direct)
          findings.push(
            warn("code.indirect-capability", `ctx.${p.name as string} is passed around, so the analysis cannot see every use`, pos(n)),
          );
      }
    },
  };
  ancestor(program as never, visitors as never);
  void consumed;
  return { exports, uses, findings };
};
