import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { build } from 'esbuild';
import * as lucide from 'lucide';

const sourceFiles = ['index.html', 'pricing.html', 'privacy.html', 'terms.html', 'app.js'];
const literalIconNames = new Set();
const unresolvedDynamicReferences = [];

const explicitDynamicSafelist = ['database', 'clock'];
for (const name of explicitDynamicSafelist) literalIconNames.add(name);

for (const file of sourceFiles) {
  const text = await readFile(file, 'utf8');

  for (const match of text.matchAll(/data-lucide\s*=\s*["']([a-z0-9-]+)["']/gi)) {
    literalIconNames.add(match[1].toLowerCase());
  }

  for (const match of text.matchAll(/data-lucide\s*=\s*["'`]([^"'`]*)\$\{([^}]*)\}/g)) {
    const expression = match[2];
    const isKnownConditional = expression.includes('data.from_cache') && expression.includes('database') && expression.includes('clock');
    const isCommandPaletteIcon = expression.trim() === 'c.icon';
    if (!isKnownConditional && !isCommandPaletteIcon) {
      unresolvedDynamicReferences.push(`${file}: ${match[0]}`);
    }
  }

  for (const match of text.matchAll(/\bicon\s*:\s*["']([a-z0-9-]+)["']/gi)) {
    const name = match[1].toLowerCase();
    const exportName = toExportName(name);
    if (lucide[exportName]) literalIconNames.add(name);
  }
}

const customIcons = new Set(['instagram']);
const imports = [];
const iconEntries = [];
const missing = [];

for (const name of [...literalIconNames].sort()) {
  const exportName = toExportName(name);
  if (customIcons.has(name)) {
    iconEntries.push(`${JSON.stringify(exportName)}: Instagram`);
    continue;
  }
  if (!lucide[exportName]) {
    missing.push({ name, exportName });
    continue;
  }
  imports.push(exportName);
  iconEntries.push(`${JSON.stringify(exportName)}: ${exportName}`);
}

const diagnostics = {
  sourceFiles,
  scannedIconCount: literalIconNames.size,
  scannedIcons: [...literalIconNames].sort(),
  unresolvedDynamicReferences,
  missingExports: missing,
  customIcons: [...customIcons].sort(),
  lucideVersion: '1.59.0',
};
await writeFile('lucide.diagnostics.json', `${JSON.stringify(diagnostics, null, 2)}\n`);

if (unresolvedDynamicReferences.length) {
  throw new Error(
    `Unresolved dynamic data-lucide references need an explicit safelist:\n${unresolvedDynamicReferences.join('\n')}`,
  );
}

if (missing.length) {
  throw new Error(`Missing Lucide exports:\n${missing.map((item) => `${item.name} -> ${item.exportName}`).join('\n')}`);
}

await mkdir('.generated', { recursive: true });
const entry = `
import { createIcons, ${imports.join(', ')} } from 'lucide';

const Instagram = [
  ['rect', { width: '20', height: '20', x: '2', y: '2', rx: '5', ry: '5' }],
  ['path', { d: 'M16 11.37A4 4 0 1 1 12.63 8 4 4 0 0 1 16 11.37z' }],
  ['line', { x1: '17.5', x2: '17.51', y1: '6.5', y2: '6.5' }],
];

const icons = { ${iconEntries.join(',\n  ')} };

function createCuratedIcons(options = {}) {
  return createIcons({ ...options, icons: { ...icons, ...(options.icons || {}) } });
}

window.lucide = Object.freeze({
  createIcons: createCuratedIcons,
  icons,
});
`;

await writeFile('.generated/lucide-entry.js', entry);
await build({
  entryPoints: ['.generated/lucide-entry.js'],
  outfile: 'lucide.generated.js',
  bundle: true,
  minify: true,
  format: 'iife',
  platform: 'browser',
  target: ['es2020'],
  legalComments: 'none',
  treeShaking: true,
  logLevel: 'warning',
});

const output = await readFile('lucide.generated.js');
const report = {
  ...diagnostics,
  iconCount: literalIconNames.size,
  icons: [...literalIconNames].sort(),
  rawBytes: output.length,
  gzipBytes: gzipSync(output, { level: 9 }).length,
};
await writeFile('lucide.generated.json', `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));

if (output.length >= 150_000) {
  throw new Error(`Curated Lucide bundle is unexpectedly large: ${output.length} bytes`);
}

function toExportName(name) {
  return name
    .split('-')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
}
