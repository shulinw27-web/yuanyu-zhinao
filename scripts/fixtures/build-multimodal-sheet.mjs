import { pathToFileURL } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
const runtime = process.env.ARTIFACT_TOOL_ENTRY;
if (!runtime) throw new Error('Set ARTIFACT_TOOL_ENTRY to the bundled artifact_tool.mjs path');
const { Workbook, SpreadsheetFile } = await import(pathToFileURL(runtime).href);
const workbook = Workbook.create();
const fixtures = {
  Tickets: [['ticket_code', 'asset_code', 'repair_cost', 'currency'], ['RT-101', 'AS-01', 137.5, 'CNY'], ['RT-102', 'AS-02', 22.5, 'CNY']],
  Assets: [['asset_code', 'asset_name'], ['AS-01', 'Cooling pump'], ['AS-02', 'Air compressor']]
};
const out = 'output/multimodal-fixtures';
await mkdir(out, { recursive: true });
for (const [name, values] of Object.entries(fixtures)) {
  const sheet = workbook.worksheets.add(name);
  sheet.showGridLines = false;
  const end = name === 'Tickets' ? 'D' : 'B';
  sheet.getRange(`A1:${end}3`).values = values;
  sheet.getRange(`A1:${end}3`).format.font = { name: 'Arial', size: 11 };
  sheet.getRange(`A1:${end}3`).format.columnWidth = 24;
  sheet.getRange(`A1:${end}3`).format.rowHeight = 26;
  sheet.getRange(`A1:${end}1`).format = { fill: '#193A59', font: { name: 'Arial', size: 11, color: '#FFFFFF', bold: true } };
  if (name === 'Tickets') sheet.getRange('C2:C3').setNumberFormat('0.00');
  const preview = await workbook.render({ sheetName: name, autoCrop: 'all', scale: 1.5, format: 'png' });
  await writeFile(`${out}/${name}-preview.png`, new Uint8Array(await preview.arrayBuffer()));
}
workbook.recalculate();
await (await SpreadsheetFile.exportXlsx(workbook)).save(`${out}/tickets.xlsx`);
console.log((await workbook.inspect({ kind: 'sheet', include: 'id,name' })).ndjson);
