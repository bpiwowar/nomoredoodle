import fs from 'node:fs';
import path from 'node:path';
import {execSync} from 'node:child_process';

// Output TypeScript file
const sourceDirectory = path.resolve('./source');
const tsOutput = path.join(sourceDirectory, 'tailwind-css.ts');

// Minimal Tailwind input CSS
const inputCSS = `
@import "tailwindcss";
`;

// Run Tailwind CLI using stdin, capture output in memory
console.log('Building Tailwind CSS in memory...');
const tailwindGenerated = execSync('npx tailwindcss -i - --minify', {
	input: inputCSS,
	encoding: 'utf8',
	stdio: ['pipe', 'pipe', 'inherit'], // Stdin, stdout, stderr
});

// Generate the TypeScript file
const tsContent = `export const tailwindCSS = \`${tailwindGenerated}\`;`;
fs.writeFileSync(tsOutput, tsContent, 'utf8');

console.log(`✅ Generated TypeScript file at ${tsOutput}`);
