const {
  AlignmentType,
  Document,
  Footer,
  Header,
  HeadingLevel,
  Packer,
  PageNumber,
  Paragraph,
  TextRun
} = require('docx');
const JSZip = require('jszip');

const xmlEscape = (value) => String(value || '')
  .replace(/&/gu, '&amp;')
  .replace(/</gu, '&lt;')
  .replace(/>/gu, '&gt;')
  .replace(/"/gu, '&quot;')
  .replace(/'/gu, '&apos;');

const cleanTitle = (fileName) => String(fileName || '智脑工作成果').replace(/\.(?:docx|xlsx)$/iu, '').slice(0, 80) || '智脑工作成果';

const contentParagraphs = (content, documentTitle) => {
  const numbering = 'zhinao-numbering';
  let firstContentSeen = false;
  return String(content || '').split(/\r?\n/gu).flatMap((rawLine) => {
    const line = rawLine.trim();
    if (!line) return [new Paragraph({ spacing: { after: 80 } })];
    if (!firstContentSeen) {
      firstContentSeen = true;
      if (/^#\s+/u.test(line) && line.replace(/^#\s+/u, '').trim() === documentTitle) return [];
    }
    if (/^###\s+/u.test(line)) return [new Paragraph({ text: line.replace(/^###\s+/u, ''), heading: HeadingLevel.HEADING_3 })];
    if (/^##\s+/u.test(line)) return [new Paragraph({ text: line.replace(/^##\s+/u, ''), heading: HeadingLevel.HEADING_2 })];
    if (/^#\s+/u.test(line)) return [new Paragraph({ text: line.replace(/^#\s+/u, ''), heading: HeadingLevel.HEADING_1 })];
    if (/^(?:[-*])\s+/u.test(line)) return [new Paragraph({ text: line.replace(/^(?:[-*])\s+/u, ''), bullet: { level: 0 } })];
    const numbered = line.match(/^\d+[.)、]\s*(.+)$/u);
    if (numbered) return [new Paragraph({ text: numbered[1], numbering: { reference: numbering, level: 0 } })];
    return [new Paragraph({ children: [new TextRun(line)], spacing: { after: 120, line: 276 } })];
  });
};

async function buildDocxBuffer({ fileName, content }) {
  const title = cleanTitle(fileName);
  const document = new Document({
    creator: '元域智脑',
    title,
    description: '由元域智脑在用户确认后生成的本地办公草稿。',
    styles: {
      default: { document: { run: { font: 'Microsoft YaHei', size: 22, color: '222222' }, paragraph: { spacing: { after: 120, line: 276 } } } },
      paragraphStyles: [
        { id: 'ZhinaoTitle', name: '智脑标题', basedOn: 'Normal', next: 'Normal', quickFormat: true, run: { font: 'Microsoft YaHei', size: 42, bold: true, color: '163B4D' }, paragraph: { spacing: { before: 0, after: 260 }, keepNext: true } },
        { id: 'Heading1', name: 'Heading 1', basedOn: 'Normal', next: 'Normal', quickFormat: true, run: { font: 'Microsoft YaHei', size: 32, bold: true, color: '1C6575' }, paragraph: { spacing: { before: 320, after: 160 }, keepNext: true, outlineLevel: 0 } },
        { id: 'Heading2', name: 'Heading 2', basedOn: 'Normal', next: 'Normal', quickFormat: true, run: { font: 'Microsoft YaHei', size: 26, bold: true, color: '1C6575' }, paragraph: { spacing: { before: 240, after: 120 }, keepNext: true, outlineLevel: 1 } },
        { id: 'Heading3', name: 'Heading 3', basedOn: 'Normal', next: 'Normal', quickFormat: true, run: { font: 'Microsoft YaHei', size: 24, bold: true, color: '315A68' }, paragraph: { spacing: { before: 160, after: 80 }, keepNext: true, outlineLevel: 2 } }
      ]
    },
    numbering: {
      config: [{
        reference: 'zhinao-numbering',
        levels: [{ level: 0, format: 'decimal', text: '%1.', alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 720, hanging: 360 }, spacing: { after: 80 } } } }]
      }]
    },
    sections: [{
      properties: {
        page: {
          size: { width: 12240, height: 15840 },
          margin: { top: 1440, right: 1440, bottom: 1440, left: 1440, header: 708, footer: 708 }
        }
      },
      headers: { default: new Header({ children: [new Paragraph({ alignment: AlignmentType.RIGHT, children: [new TextRun({ text: '元域智脑 · 本地办公草稿', size: 18, color: '77858B' })] })] }) },
      footers: { default: new Footer({ children: [new Paragraph({ alignment: AlignmentType.RIGHT, children: [new TextRun({ text: '第 ', size: 18, color: '77858B' }), new TextRun({ children: [PageNumber.CURRENT], size: 18, color: '77858B' }), new TextRun({ text: ' 页', size: 18, color: '77858B' })] })] }) },
      children: [
        new Paragraph({ style: 'ZhinaoTitle', children: [new TextRun(title)] }),
        new Paragraph({ children: [new TextRun({ text: '由元域智脑生成 · 请在正式使用前核对内容', size: 19, color: '66757C' })], spacing: { after: 320 } }),
        ...contentParagraphs(content, title)
      ]
    }]
  });
  return Packer.toBuffer(document);
}

const groupWorkbookRows = (content) => {
  const rows = [];
  let section = '内容';
  for (const rawLine of String(content || '').split(/\r?\n/gu)) {
    const line = rawLine.trim();
    if (!line) continue;
    const heading = line.match(/^#{1,3}\s+(.+)$/u);
    if (heading) { section = heading[1]; continue; }
    rows.push([section, line.replace(/^(?:[-*]|\d+[.)、])\s*/u, '')]);
  }
  return rows.length ? rows.slice(0, 500) : [['内容', '当前没有可写入的有效内容。']];
};

const inlineCell = (ref, value, style = 0) => `<c r="${ref}" t="inlineStr" s="${style}"><is><t xml:space="preserve">${xmlEscape(value)}</t></is></c>`;

async function buildXlsxBuffer({ fileName, content }) {
  const title = cleanTitle(fileName);
  const rows = groupWorkbookRows(content);
  const sheetRows = [
    `<row r="1" ht="30" customHeight="1">${inlineCell('A1', title, 1)}</row>`,
    `<row r="2" ht="20" customHeight="1">${inlineCell('A2', '分类', 2)}${inlineCell('B2', '内容', 2)}</row>`,
    ...rows.map((row, index) => {
      const number = index + 3;
      return `<row r="${number}" ht="34" customHeight="1">${inlineCell(`A${number}`, row[0], 3)}${inlineCell(`B${number}`, row[1], 4)}</row>`;
    })
  ].join('');
  const lastRow = rows.length + 2;
  const zip = new JSZip();
  zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>`);
  zip.file('_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>`);
  zip.file('docProps/core.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${xmlEscape(title)}</dc:title><dc:creator>元域智脑</dc:creator><dc:description>用户确认后生成的本地办公草稿</dc:description></cp:coreProperties>`);
  zip.file('docProps/app.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>元域智脑</Application></Properties>`);
  zip.file('xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><bookViews><workbookView/></bookViews><sheets><sheet name="工作成果" sheetId="1" r:id="rId1"/></sheets><calcPr fullCalcOnLoad="1"/></workbook>`);
  zip.file('xl/_rels/workbook.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`);
  zip.file('xl/styles.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="3"><font><sz val="11"/><name val="Microsoft YaHei"/></font><font><b/><sz val="16"/><color rgb="FFFFFFFF"/><name val="Microsoft YaHei"/></font><font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Microsoft YaHei"/></font></fonts><fills count="4"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF163B4D"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FF1C6575"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="2"><border/><border><left style="thin"><color rgb="FFD8E0E3"/></left><right style="thin"><color rgb="FFD8E0E3"/></right><top style="thin"><color rgb="FFD8E0E3"/></top><bottom style="thin"><color rgb="FFD8E0E3"/></bottom></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="5"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment vertical="center"/></xf><xf numFmtId="0" fontId="2" fillId="3" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="center"/></xf><xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf><xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`);
  zip.file('xl/worksheets/sheet1.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="2" topLeftCell="A3" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols><col min="1" max="1" width="22" customWidth="1"/><col min="2" max="2" width="72" customWidth="1"/></cols><sheetData>${sheetRows}</sheetData><mergeCells count="1"><mergeCell ref="A1:B1"/></mergeCells><autoFilter ref="A2:B${lastRow}"/><pageMargins left="0.5" right="0.5" top="0.6" bottom="0.6" header="0.3" footer="0.3"/></worksheet>`);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
}

module.exports = { buildDocxBuffer, buildXlsxBuffer };
