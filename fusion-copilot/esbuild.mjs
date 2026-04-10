import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');

/** @type {esbuild.BuildOptions} */
const buildOptions = {
	entryPoints: ['src/extension.ts'],
	bundle: true,
	outfile: 'dist/extension.js',
	external: ['vscode'],
	format: 'cjs',
	platform: 'node',
	target: 'node20',
	sourcemap: true,
	minify: !watch,
	treeShaking: true,
};

if (watch) {
	const ctx = await esbuild.context(buildOptions);
	await ctx.watch();
	console.log('[fusion-copilot] Watching for changes...');
} else {
	await esbuild.build(buildOptions);
	console.log('[fusion-copilot] Build complete');
}
