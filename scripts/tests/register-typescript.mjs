import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import ts from "typescript";

const roots = ["../../worker/", "../../src/shared/", "../../src/editor/"].map((path) => new URL(path, import.meta.url).href);
const isLocal = (url) => roots.some((root) => url?.startsWith(root));
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (isLocal(context.parentURL) && specifier.startsWith(".") && !/\.tsx?$/.test(specifier)) specifier += ".ts";
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (isLocal(url) && /\.tsx?$/.test(url)) {
      const { outputText } = ts.transpileModule(readFileSync(new URL(url), "utf8"), {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX },
      });
      return { format: "module", source: outputText, shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});
