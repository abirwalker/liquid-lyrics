import { defineConfig } from "@spicemod/creator";
import { name, version } from "./package.json";

const subcommand = process.argv.slice(2).find((arg) => !arg.startsWith("-"));
const isDev = subcommand === "dev";

const AMLL_CONSOLE_BANNER =
  'globalThis.__amllConsole??=(()=>{const n=()=>{};return{log:n,debug:n,warn:n,error:n,groupCollapsed:n,groupEnd:n};})();';

const AMLL_CONSOLE_METHODS = [
  "log",
  "debug",
  "warn",
  "error",
  "groupCollapsed",
  "groupEnd",
] as const;

const AMLL_CONSOLE_DEFINE = Object.fromEntries(
  AMLL_CONSOLE_METHODS.map((method) => [`console.${method}`, `globalThis.__amllConsole.${method}`]),
);

const AMLL_CONSOLE_PURE = AMLL_CONSOLE_METHODS.map((method) => `console.${method}`);

export default defineConfig({
  name,
  version,
  framework: "react",
  template: "extension",
  cssId: "liquid-lyrics-styles",
  esbuildOptions: isDev
    ? {
        banner: { js: AMLL_CONSOLE_BANNER },
        define: {
          "process.env.NODE_ENV": '"development"',
          ...AMLL_CONSOLE_DEFINE,
        },
      }
    : {
        define: {
          "process.env.NODE_ENV": '"production"',
        },
        pure: AMLL_CONSOLE_PURE,
      },
});
