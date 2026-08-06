import esbuild from "esbuild";
import process from "process";
import builtins from "builtin-modules";

// 옵시디언 커뮤니티 플러그인 표준 빌드. src/main.ts → main.js(CJS) 번들.
// `obsidian`·`electron`·node 빌트인은 외부로 두어 앱이 런타임에 제공한다.

const prod = process.argv[2] === "production";

const context = await esbuild.context({
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: ["obsidian", "electron", ...builtins],
  format: "cjs",
  target: "es2018",
  logLevel: "info",
  sourcemap: prod ? false : "inline",
  treeShaking: true,
  outfile: "main.js",
  minify: prod
});

if (prod) {
  await context.rebuild();
  process.exit(0);
} else {
  await context.watch();
}
