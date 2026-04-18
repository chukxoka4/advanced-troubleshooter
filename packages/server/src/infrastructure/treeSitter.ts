/**
 * Thin wrapper around tree-sitter: parse a buffer, return a flat list of
 * top-level-ish symbols. One responsibility only — no scope resolution, no
 * rendering, no IO. Language is chosen by file extension; unknown extensions
 * return []. Keep under 150 lines.
 */
import Parser from "tree-sitter";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

export type SymbolKind = "class" | "function" | "method" | "const" | "type";

export interface ParsedSymbol {
  symbol: string;
  kind: SymbolKind;
  lineStart: number;
  lineEnd: number;
  signature: string;
}

type GrammarLoader = () => Parser.Language;

const loaders: Record<string, GrammarLoader> = {
  ts: () => (require("tree-sitter-typescript") as { typescript: Parser.Language }).typescript,
  tsx: () => (require("tree-sitter-typescript") as { tsx: Parser.Language }).tsx,
  js: () => require("tree-sitter-javascript") as Parser.Language,
  jsx: () => require("tree-sitter-javascript") as Parser.Language,
  mjs: () => require("tree-sitter-javascript") as Parser.Language,
  cjs: () => require("tree-sitter-javascript") as Parser.Language,
  py: () => require("tree-sitter-python") as Parser.Language,
  php: () => (require("tree-sitter-php") as { php: Parser.Language }).php,
  go: () => require("tree-sitter-go") as Parser.Language,
};

// Per-language node-kind → SymbolKind mapping. Anything unmapped is skipped.
const KIND_MAP: Record<string, Record<string, SymbolKind>> = {
  ts: {
    class_declaration: "class",
    function_declaration: "function",
    method_definition: "method",
    method_signature: "method",
    interface_declaration: "type",
    type_alias_declaration: "type",
    enum_declaration: "type",
  },
  js: {
    class_declaration: "class",
    function_declaration: "function",
    method_definition: "method",
  },
  py: {
    class_definition: "class",
    function_definition: "function",
  },
  php: {
    class_declaration: "class",
    function_definition: "function",
    method_declaration: "method",
    interface_declaration: "type",
  },
  go: {
    function_declaration: "function",
    method_declaration: "method",
    type_declaration: "type",
  },
};

// group extensions under a single kind map key
const KIND_KEY: Record<string, keyof typeof KIND_MAP> = {
  ts: "ts", tsx: "ts",
  js: "js", jsx: "js", mjs: "js", cjs: "js",
  py: "py",
  php: "php",
  go: "go",
};

function extOf(filename: string): string | null {
  const i = filename.lastIndexOf(".");
  if (i < 0) return null;
  return filename.slice(i + 1).toLowerCase();
}

function nameOf(node: Parser.SyntaxNode): string {
  return (
    node.childForFieldName("name")?.text
    ?? node.descendantsOfType("identifier")[0]?.text
    ?? node.descendantsOfType("name")[0]?.text
    ?? "<anonymous>"
  );
}

function firstLine(source: string, node: Parser.SyntaxNode): string {
  const text = source.slice(node.startIndex, node.endIndex);
  const line = text.split(/\r?\n/)[0] ?? "";
  return line.trim().slice(0, 200);
}

export function parse(buffer: Buffer | string, filename: string): ParsedSymbol[] {
  const ext = extOf(filename);
  if (!ext || !loaders[ext] || !KIND_KEY[ext]) return [];
  let language: Parser.Language;
  try {
    language = loaders[ext]!();
  } catch {
    return [];
  }
  const source = typeof buffer === "string" ? buffer : buffer.toString("utf8");
  const parser = new Parser();
  parser.setLanguage(language);
  const tree = parser.parse(source);
  const kinds = KIND_MAP[KIND_KEY[ext]!]!;
  const out: ParsedSymbol[] = [];
  const walk = (node: Parser.SyntaxNode): void => {
    const mapped = kinds[node.type];
    if (mapped) {
      out.push({
        symbol: nameOf(node),
        kind: mapped,
        lineStart: node.startPosition.row + 1,
        lineEnd: node.endPosition.row + 1,
        signature: firstLine(source, node),
      });
    }
    for (let i = 0; i < node.namedChildCount; i += 1) {
      walk(node.namedChild(i) as Parser.SyntaxNode);
    }
  };
  walk(tree.rootNode);
  return out;
}
