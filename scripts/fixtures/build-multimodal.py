"""Synthetic fixtures only. Run with the bundled document Python runtime."""
from pathlib import Path
import json
from docx import Document
from docx.shared import Pt
from PIL import Image, ImageDraw, ImageFont
from reportlab.pdfgen import canvas
from reportlab.lib.utils import ImageReader

out = Path('output/multimodal-fixtures')
out.mkdir(parents=True, exist_ok=True)
doc = Document()
doc.styles['Normal'].font.size = Pt(11)
doc.add_heading('Synthetic maintenance data dictionary', 0)
doc.add_paragraph('Synthetic test data only. Currency: CNY. No enterprise connection.')
doc.add_heading('RepairTicket', level=1)
p = doc.add_paragraph('Foreign key ')
p.add_run('asset_').bold = True
p.add_run('code')
p.add_run(' references Asset.asset_code. Each Asset has zero or more RepairTicket records.')
table = doc.add_table(rows=1, cols=3)
table.style = 'Light Shading Accent 1'
for c, value in zip(table.rows[0].cells, ['Field', 'Type', 'Meaning']): c.text = value
for values in [('ticket_code', 'string', 'Primary key'), ('asset_code', 'string', 'Foreign key to Asset.asset_code'), ('repair_cost', 'decimal', 'Repair amount in CNY')]:
    for c, value in zip(table.add_row().cells, values): c.text = value
doc.add_heading('Asset', level=1)
doc.add_paragraph('Fields: asset_code (primary key), asset_name (string).')
doc.save(out / 'dictionary.docx')

image = Image.new('RGB', (1400, 700), 'white')
d = ImageDraw.Draw(image)
font = ImageFont.truetype('C:/Windows/Fonts/arial.ttf', 29)
small = ImageFont.truetype('C:/Windows/Fonts/arial.ttf', 24)
d.text((55, 35), 'Synthetic model diagram - not enterprise data', font=font, fill='#122b46')
for box in [(55, 160, 520, 435), (850, 160, 1345, 435)]:
    d.rounded_rectangle(box, radius=14, fill='#f0f5fa', outline='#193a59', width=3)
for xy, label in [((80, 183), 'Asset'), ((80, 255), 'asset_code  PK'), ((80, 318), 'asset_name'), ((875, 183), 'RepairTicket'), ((875, 255), 'ticket_code  PK'), ((875, 318), 'asset_code  FK'), ((875, 380), 'repair_cost  CNY')]:
    d.text(xy, label, font=font, fill='#122b46')
d.line([(525, 280), (843, 280)], fill='#2155a3', width=5)
d.polygon([(843, 280), (821, 267), (821, 293)], fill='#2155a3')
d.text((546, 230), '1', font=font, fill='#2155a3')
d.text((781, 230), '0..n', font=font, fill='#2155a3')
d.text((540, 307), 'via asset_code', font=small, fill='#2155a3')
d.text((55, 515), 'Sample: RT-101 -> AS-01 -> Cooling pump', font=font, fill='#122b46')
d.text((55, 570), 'RT-101 repair_cost = 137.50 CNY', font=font, fill='#122b46')
image.save(out / 'relationship.png')
image.save(out / 'relationship.jpg', quality=92)
image.save(out / 'relationship.webp')
pdf = canvas.Canvas(str(out / 'scanned-model.pdf'), pagesize=(700, 350))
pdf.drawImage(ImageReader(image), 0, 0, 700, 350)
pdf.save()
pdf = canvas.Canvas(str(out / 'mixed-report.pdf'), pagesize=(700, 420))
pdf.setFont('Helvetica', 16)
pdf.drawString(40, 365, 'Synthetic repair report')
pdf.drawString(40, 320, 'RT-101: AS-01, repair_cost 137.50 CNY')
pdf.drawString(40, 280, 'RT-102: AS-02, repair_cost 22.50 CNY')
pdf.drawString(40, 230, 'The relationship diagram is on page 2.')
pdf.showPage()
pdf.setFont('Helvetica', 14)
pdf.drawString(40, 389, 'Relationship diagram - synthetic')
pdf.drawImage(ImageReader(image), 0, 0, 700, 350)
pdf.save()

dictionary = {'tables': [{'name': 'RepairTicket', 'primaryKey': 'ticket_code', 'fields': [{'name': 'ticket_code', 'type': 'string', 'primaryKey': True}, {'name': 'asset_code', 'type': 'string', 'reference': 'Asset'}, {'name': 'repair_cost', 'type': 'number'}]}, {'name': 'Asset', 'primaryKey': 'asset_code', 'fields': [{'name': 'asset_code', 'type': 'string', 'primaryKey': True}, {'name': 'asset_name', 'type': 'string'}]}]}
(out / 'dictionary.json').write_text(json.dumps(dictionary), encoding='utf8')
(out / 'tickets.csv').write_text('ticket_code,asset_code,repair_cost,currency\nRT-101,AS-01,137.50,CNY\nRT-102,AS-02,22.50,CNY\n', encoding='utf8')
(out / 'dictionary.yaml').write_text('table: RepairTicket\nprimary_key: ticket_code\nfields:\n  ticket_code: string\n  asset_code: string\n  repair_cost: decimal\n', encoding='utf8')
(out / 'ground-truth.json').write_text(json.dumps({'synthetic': True, 'primary_key': 'ticket_code', 'foreign_key': 'asset_code', 'target': 'Asset.asset_code', 'cardinality': 'Asset 1 -> RepairTicket 0..n', 'rt101_cost': 137.5, 'rt102_cost': 22.5, 'total_cost': 160, 'currency': 'CNY'}, indent=2), encoding='utf8')
print('Synthetic fixtures created in output/multimodal-fixtures')
