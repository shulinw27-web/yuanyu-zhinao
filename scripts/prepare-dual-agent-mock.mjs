import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { documents, dictionary, openapi, samples } from '../examples/knowledge/dual-agent-mock/scenario.mjs';
const dir = resolve('output/dual-agent-weknora/materials');
await mkdir(dir, { recursive: true });
for (const doc of documents) await writeFile(resolve(dir, doc.name), doc.text, 'utf8');
for (const [name, value] of Object.entries({ 'data-dictionary.json': dictionary, 'combined-openapi.json': openapi, 'sample-events.json': samples })) {
  await writeFile(resolve(dir, name), JSON.stringify(value, null, 2));
}
console.log(JSON.stringify({ directory: dir, uploadToWeKnora: documents.map(d => d.name), expectedAnswersExcluded: true }));
