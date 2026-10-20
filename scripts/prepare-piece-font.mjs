// Optional asset preparation; normal builds use the committed local subset.
import { mkdir, writeFile } from 'node:fs/promises';

const directory = new URL('../web/public/fonts/', import.meta.url);
const glyphs = '王玉歩香桂銀金飛角と杏圭全龍馬';
const stylesheet = 'https://fonts.googleapis.com/css2?family=Yuji+Boku&display=swap&text=' + encodeURIComponent(glyphs);
async function fetchChecked(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: ${response.status}`);
  return response;
}
const css = await (await fetchChecked(stylesheet)).text();
const source = css.match(/src: url\((https:\/\/fonts\.gstatic\.com\/[^)]+)\) format\('truetype'\)/)?.[1];
if (!source) throw new Error('Expected the Google Fonts TrueType subset response');
const font = new Uint8Array(await (await fetchChecked(source)).arrayBuffer());
if (font.byteLength > 100_000 || new DataView(font.buffer).getUint32(0) !== 0x00010000) throw new Error('Unexpected font subset');
const license = await (await fetchChecked('https://raw.githubusercontent.com/google/fonts/main/ofl/yujiboku/OFL.txt')).text();
await mkdir(directory, { recursive: true });
await writeFile(new URL('shogi-brush.ttf', directory), font);
await writeFile(new URL('OFL.txt', directory), license);
console.log(`Bundled Yuji Boku: ${glyphs.length} shogi glyphs, ${font.byteLength} bytes, SIL OFL 1.1.`);
