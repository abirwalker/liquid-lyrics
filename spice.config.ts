import { defineConfig } from "@spicemod/creator";
import { name, version } from "./package.json";

export default defineConfig({
  name,
  version,
  framework: "react",
  template: "extension",
  cssId: "liquid-lyrics-styles",
});
