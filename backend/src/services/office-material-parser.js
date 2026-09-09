import JSZip from 'jszip';
import xmlJs from 'xml-js';
import { posix } from 'node:path';

const children = (node, name) => (node?.elements || []).filter(item => item.type === 'element' && item.name.split(':').at(-1) === name);
const first = (node, name) => children(node, name)[0];
const text = node => (node?.elements || []).map(item => item.type === 'text' ? item.text : text(item)).join('');
const richText = node => children(node, 't').map(text).join('') + children(node, 'r').map(item => children(item, 't').map(text).join('')).join('');
const columnName = index => index < 26 ? String.fromCharCode(65 + index) : columnName(Math.floor(index / 26) - 1) + columnName(index % 26);

// Bounded, passive OOXML only. Never evaluate formulas, links, macros or entities.
export async function parseOfficeMaterial(bytes, mimeType) {
  // Check advertised sizes before CRC verification decompresses archive members.
  const zip = await JSZip.loadAsync(bytes, { checkCRC32: false, createFolders: false });
  const files = Object.values(zip.files);
  if (files.length > 200 || files.reduce((sum, file) => sum + Math.max(0, Number(file?._data?.uncompressedSize || 0)), 0) > 20 * 1024 * 1024) throw new Error('office expansion limit');
  if (files.some(file => /vbaProject|embeddings\//i.test(file.name))) throw new Error('active office content');
  const read = async name => {
    const file = zip.file(name);
    if (!file) return null;
    const value = await file.async('string');
    if (value.length > 2_000_000 || /<!DOCTYPE|<!ENTITY/i.test(value)) throw new Error('unsafe office XML');
    return xmlJs.xml2js(value, { compact: false, ignoreComment: true, ignoreInstruction: true });
  };
  const parts = [];
  const warnings = [];
  if (mimeType.includes('wordprocessingml')) {
    const root = first(await read('word/document.xml'), 'document');
    if (!root) throw new Error('missing document');
    // Join formatting runs without inventing spaces inside field codes or names.
    const wordText = node => (node?.elements || []).map(item => {
      const name = item.name?.split(':').at(-1);
      if (['del', 'instrText', 'drawing', 'pict'].includes(name)) return '';
      if (name === 't') return text(item);
      if (['br', 'cr'].includes(name)) return '\n';
      if (name === 'tab') return '\t';
      return `${wordText(item)}${name === 'p' ? '\n' : ''}`;
    }).join('');
    let paragraph = 0; let table = 0;
    for (const node of first(root, 'body')?.elements || []) {
      if (node.name?.endsWith(':p')) parts.push(`段落 ${++paragraph}: ${wordText(node)}`);
      if (node.name?.endsWith(':tbl')) {
        table += 1;
        for (const [index, row] of children(node, 'tr').entries()) {
          parts.push(`表 ${table} 行 ${index + 1}: ${children(row, 'tc').map((cell, i) => `${columnName(i)}=${JSON.stringify(wordText(cell).trim())}`).join(' | ')}`);
        }
      }
    }
    warnings.push('仅解析正文段落及表格；图片、文本框、页眉页脚、批注和修订记录未作为完整文档读取。');
    return { text: parts.join('\n'), warnings, kind: 'docx', truncated: false };
  }
  const sst = first(await read('xl/sharedStrings.xml'), 'sst');
  const strings = children(sst, 'si').map(richText);
  const workbook = first(await read('xl/workbook.xml'), 'workbook');
  const relationships = children(first(await read('xl/_rels/workbook.xml.rels'), 'Relationships'), 'Relationship');
  const styles = first(await read('xl/styles.xml'), 'styleSheet');
  const formats = new Map(children(first(styles, 'numFmts'), 'numFmt').map(item => [Number(item.attributes?.numFmtId), item.attributes?.formatCode]));
  const styleFormats = children(first(styles, 'cellXfs'), 'xf').map(item => Number(item.attributes?.numFmtId));
  const date1904 = ['1', 'true'].includes(first(workbook, 'workbookPr')?.attributes?.date1904);
  let sheets = children(first(workbook, 'sheets'), 'sheet').map(sheet => {
    const rel = relationships.find(item => item.attributes?.Id === sheet.attributes?.['r:id']);
    const target = rel?.attributes?.Target;
    if (!target || rel.attributes?.TargetMode === 'External') throw new Error('invalid worksheet relationship');
    const path = target.startsWith('/') ? posix.normalize(target.slice(1)) : posix.normalize(`xl/${target}`);
    if (!path.startsWith('xl/worksheets/')) throw new Error('worksheet path rejected');
    return { name: sheet.attributes?.name || path, path, hidden: sheet.attributes?.state || 'visible' };
  });
  // Minimal OOXML test/export producers sometimes omit workbook metadata.
  if (!sheets.length) sheets = files.filter(file => /^xl\/worksheets\/sheet\d+\.xml$/.test(file.name)).map(file => ({ name: file.name, path: file.name }));
  if (!sheets.length) throw new Error('missing worksheets');
  let truncated = sheets.length > 20;
  for (const sheet of sheets.slice(0, 20)) {
    const root = first(await read(sheet.path), 'worksheet');
    if (!root) throw new Error('missing worksheet');
    parts.push(`工作表 ${JSON.stringify(sheet.name)}${sheet.hidden && sheet.hidden !== 'visible' ? '（隐藏表，仍属附件内容）' : ''}`);
    for (const [index, row] of children(first(root, 'sheetData'), 'row').entries()) {
      if (index >= 2000) { truncated = true; break; }
      const cells = children(row, 'c');
      if (cells.length > 200) truncated = true;
      const values = cells.slice(0, 200).map((cell, i) => {
        const attr = cell.attributes || {};
        const reference = attr.r || `${columnName(i)}${row.attributes?.r || index + 1}`;
        const raw = text(first(cell, 'v'));
        const formula = first(cell, 'f');
        let value = raw;
        if (attr.t === 's') {
          if (!/^\d+$/.test(raw) || strings[Number(raw)] === undefined) throw new Error('invalid shared string');
          value = strings[Number(raw)];
        } else if (attr.t === 'inlineStr') value = richText(first(cell, 'is'));
        else if (attr.t === 'b') value = raw === '1' ? 'true' : 'false';
        else if (attr.t === 'e') value = `单元格错误 ${raw}`;
        else if (raw !== '' && (!attr.t || attr.t === 'n')) {
          const formatId = styleFormats[Number(attr.s || 0)];
          const format = String(formats.get(formatId) || '').replace(/"[^"]*"|\\./g, '');
          const isDate = (formatId >= 14 && formatId <= 22) || (formatId >= 45 && formatId <= 47) || /[yd]/i.test(format);
          if (isDate && Number.isFinite(Number(raw))) {
            const serial = Number(raw);
            if (!date1904 && serial >= 60 && serial < 61) value = `${raw}（Excel 虚构日期 1900-02-29，需复核）`;
            else {
              const epoch = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 31);
              value = new Date(epoch + (serial - (!date1904 && serial >= 60 ? 1 : 0)) * 86400000).toISOString();
            }
          } else if (format) value = `${raw}（格式 ${format}）`;
          else if ([9, 10].includes(formatId)) value = `${Number(raw) * 100}%`;
        }
        if (formula) value = raw === '' ? `公式 ${text(formula)}；无缓存结果，未计算` : `${value}（公式缓存，未重新计算：${text(formula)}）`;
        return `${reference}=${JSON.stringify(value)}`;
      });
      parts.push(`行 ${row.attributes?.r || index + 1}${row.attributes?.hidden === '1' ? '（隐藏行）' : ''}: ${values.join(' | ')}`);
    }
    const merges = children(first(root, 'mergeCells'), 'mergeCell').map(item => item.attributes?.ref).filter(Boolean);
    if (merges.length) parts.push(`合并范围：${merges.join(', ')}；仅左上格存值，不自动填充空格。`);
  }
  warnings.push('公式仅引用文件缓存，未重新计算；图表、图片和透视表的视觉含义未读取。');
  return { text: parts.join('\n'), warnings, kind: 'xlsx', truncated };
}
