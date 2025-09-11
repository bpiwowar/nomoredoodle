import fs from "fs";
import path from "path";
import { execSync } from "child_process";

// Output TypeScript file
const sourceDir = path.resolve("./source");
const tsOutput = path.join(sourceDir, "tailwind-css.ts");

// Minimal Tailwind input CSS
const inputCSS = `
@import "tailwindcss";
`;

// Run Tailwind CLI using stdin, capture output in memory
console.log("Building Tailwind CSS in memory...");
const tailwindGenerated = execSync(`npx tailwindcss -i - --minify`, {
  input: inputCSS,
  encoding: "utf-8",
  stdio: ["pipe", "pipe", "inherit"], // stdin, stdout, stderr
});

// Generate the TypeScript file
const tsContent = `export const tailwindCSS = \`${tailwindGenerated}\`;`;
fs.writeFileSync(tsOutput, tsContent, "utf-8");

console.log(`✅ Generated TypeScript file at ${tsOutput}`);
