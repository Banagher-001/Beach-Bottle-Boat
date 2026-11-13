import * as esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';

const minify = process.env.MINIFY === '1';
const useStub = process.env.WORLD_STUB === '1';
const root = process.cwd();
const entry = path.join(root, 'src', 'main.js');
const templatePath = path.join(root, 'src', 'index.template.html');
const outputPath = path.join(root, 'bottle_ocean_sandbox.html');
const indexPath = path.join(root, 'index.html');

const stubPlugin = {
  name: 'world-stub-alias',
  setup(build) {
    if (!useStub) return;
    build.onResolve({ filter: /^\.\/world\.js$/ }, (args) => {
      if (args.importer.endsWith('main.js')) {
        return { path: path.join(root, 'src', 'world-stub.js') };
      }
      return null;
    });
  }
};

if (!useStub && !fs.existsSync(path.join(root, 'src', 'world.js'))) {
  console.error('src/world.js is missing. Set WORLD_STUB=1 only for core-scene development.');
  process.exit(1);
}

const result = await esbuild.build({
  entryPoints: [entry],
  bundle: true,
  format: 'iife',
  target: ['chrome100', 'firefox100', 'safari15'],
  platform: 'browser',
  absWorkingDir: root,
  write: false,
  minify,
  sourcemap: false,
  legalComments: 'none',
  plugins: [stubPlugin],
  logLevel: 'info'
});

const js = result.outputFiles[0].text;
const template = fs.readFileSync(templatePath, 'utf8');
const marker = '<!-- BOTTLE_OCEAN_BUNDLE -->';
if (!template.includes(marker)) {
  console.error('Bundle marker missing from template.');
  process.exit(1);
}
const inlineScript = '<script>\n' + js.replace(/<\/script/gi, '<\\/script') + '\n</script>';
const html = template.replace(marker, inlineScript);
fs.mkdirSync(path.join(root, '.build'), { recursive: true });
fs.writeFileSync(path.join(root, '.build', 'bundle.js'), js);
fs.writeFileSync(outputPath, html);
fs.writeFileSync(indexPath, html);
const bytes = Buffer.byteLength(html, 'utf8');
console.log('Built ' + outputPath + ' + index.html (' + (bytes / 1024).toFixed(1) + ' KB, ' + (minify ? 'minified' : 'readable') + (useStub ? ', STUB WORLD' : ', production world') + ')');
