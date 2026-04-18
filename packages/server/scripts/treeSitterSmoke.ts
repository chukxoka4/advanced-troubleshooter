/**
 * Smoke test: load every grammar we install, parse a tiny fixture, and assert
 * we can walk the tree and find at least one named symbol-ish node.
 *
 * No business logic lives here — this exists to confirm the native modules
 * build cleanly on the current Node/toolchain before we build the wrapper.
 */
import Parser from "tree-sitter";

type GrammarSpec = {
  name: string;
  module: string;
  pick?: (mod: unknown) => unknown;
  source: string;
};

const grammars: GrammarSpec[] = [
  {
    name: "typescript",
    module: "tree-sitter-typescript",
    pick: (mod) => (mod as { typescript: unknown }).typescript,
    source: "function greet(name: string): string { return `hi ${name}`; }\n",
  },
  {
    name: "javascript",
    module: "tree-sitter-javascript",
    source: "function greet(name) { return `hi ${name}`; }\n",
  },
  {
    name: "python",
    module: "tree-sitter-python",
    source: "def greet(name):\n    return f'hi {name}'\n",
  },
  {
    name: "php",
    module: "tree-sitter-php",
    pick: (mod) => (mod as { php: unknown }).php,
    source: "<?php\nfunction greet($name) { return \"hi $name\"; }\n",
  },
  {
    name: "go",
    module: "tree-sitter-go",
    source: "package main\nfunc greet(name string) string { return \"hi \" + name }\n",
  },
];

async function main(): Promise<void> {
  let totalSymbols = 0;
  for (const g of grammars) {
    const loaded = await import(g.module);
    const language = g.pick ? g.pick(loaded.default ?? loaded) : (loaded.default ?? loaded);
    const parser = new Parser();
    parser.setLanguage(language as Parser.Language);
    const tree = parser.parse(g.source);
    let count = 0;
    const walk = (node: Parser.SyntaxNode): void => {
      if (node.isNamed) count += 1;
      for (let i = 0; i < node.namedChildCount; i += 1) {
        walk(node.namedChild(i) as Parser.SyntaxNode);
      }
    };
    walk(tree.rootNode);
    if (count <= 0) {
      throw new Error(`grammar ${g.name} produced zero named nodes`);
    }
    totalSymbols += count;
    console.log(`ok  ${g.name}: ${count} named nodes`);
  }
  console.log(`total named nodes across grammars: ${totalSymbols}`);
}

main().catch((err) => {
  console.error("smoke failed:", err);
  process.exit(1);
});
