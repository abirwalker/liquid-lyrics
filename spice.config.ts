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

// Each build gets its own style element, so a second copy loading cannot overwrite the running copy's CSS.
const cssId = `liquid-lyrics-styles-${version}${isDev ? "-dev" : ""}`;
const BUILD_DEFINE = {
  __LIQUID_LYRICS_VERSION__: JSON.stringify(version),
  __LIQUID_LYRICS_CSS_ID__: JSON.stringify(cssId),
};

export default defineConfig({
  name,
  version,
  framework: "react",
  template: "extension",
  cssId,
  esbuildOptions: isDev
    ? {
        banner: { js: AMLL_CONSOLE_BANNER },
        define: {
          "process.env.NODE_ENV": '"development"',
          ...BUILD_DEFINE,
          ...AMLL_CONSOLE_DEFINE,
        },
      }
    : {
        define: {
          "process.env.NODE_ENV": '"production"',
          ...BUILD_DEFINE,
        },
        pure: AMLL_CONSOLE_PURE,
      },
});
