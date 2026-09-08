/**
 * @monaco-editor/react pulls Monaco off a CDN by default. That needs the
 * network at startup and is blocked by the app's CSP (`script-src 'self'`), so
 * point the loader at the bundled copy and hand it the workers Vite builds.
 *
 * Worker specifiers drop the `esm/vs/` prefix: monaco-editor >=0.53 maps
 * `"./*": "./esm/vs/*.js"` in its exports field, so the old deep paths no
 * longer resolve.
 * Imported for side effects from main.tsx, before <App /> mounts.
 */
import * as monaco from "monaco-editor";
import { loader } from "@monaco-editor/react";
import EditorWorker from "monaco-editor/editor/editor.worker?worker";
import JsonWorker from "monaco-editor/language/json/json.worker?worker";
import CssWorker from "monaco-editor/language/css/css.worker?worker";
import HtmlWorker from "monaco-editor/language/html/html.worker?worker";
import TsWorker from "monaco-editor/language/typescript/ts.worker?worker";

window.MonacoEnvironment = {
  getWorker(_workerId: string, label: string) {
    switch (label) {
      case "json":
        return new JsonWorker();
      case "css":
      case "scss":
      case "less":
        return new CssWorker();
      case "html":
      case "handlebars":
      case "razor":
        return new HtmlWorker();
      case "typescript":
      case "javascript":
        return new TsWorker();
      default:
        return new EditorWorker();
    }
  },
};

loader.config({ monaco });
