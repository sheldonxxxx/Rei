from pathlib import Path
import zipfile
from PIL import Image, ImageDraw
from docx import Document
from docx.shared import Inches as DI
from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill, Alignment
from openpyxl.chart import BarChart, Reference
from pptx import Presentation
from pptx.util import Inches, Pt
from pptx.chart.data import CategoryChartData
from pptx.enum.chart import XL_CHART_TYPE
from pptx.dml.color import RGBColor
out = Path(__file__).resolve().parent
out.mkdir(parents=True, exist_ok=True)
im = Image.new('RGB', (640, 260), '#172b41'); draw=ImageDraw.Draw(im); draw.rectangle((30, 150, 130, 235), fill='#36a183');draw.rectangle((160, 90, 260, 235), fill='#8aa4f5');draw.rectangle((290, 40, 390, 235), fill='#e9b462');draw.text((30,20),'SYNTHETIC LIBRARY TEST',fill='white');im.save(out/'chart.png')
doc=Document();doc.add_heading('Library preview — 文件報告',0);doc.add_paragraph('Synthetic test document. Headers, tables, images and multiple pages.');table=doc.add_table(rows=1,cols=2);table.rows[0].cells[0].text='項目';table.rows[0].cells[1].text='Amount';row=table.add_row().cells;row[0].text='Hosting';row[1].text='120 HKD';doc.add_picture(str(out/'chart.png'),width=DI(5));doc.sections[0].header.paragraphs[0].text='Rei synthetic fixture';doc.sections[0].footer.paragraphs[0].text='Preview fixture — no private data';doc.add_page_break();doc.add_heading('Second page',1);doc.add_paragraph('中文內容與第二頁。');doc.save(out/'report.docx')
wb=Workbook();ws=wb.active;ws.title='Budget';ws.merge_cells('A1:D1');ws['A1']='2026 日本旅費 — synthetic budget';ws['A1'].font=Font(size=20,color='FFFFFF',bold=True);ws['A1'].fill=PatternFill('solid',fgColor='172B41');ws.row_dimensions[1].height=38
for row in [('Category','Amount','Quantity','Total'),('Hotel',1200,3,'=B3*C3'),('Transit',240,2,'=B4*C4'),('Food',180,4,'=B5*C5')]:ws.append(row)
for col in 'ABCD':ws.column_dimensions[col].width=24
for cell in ws[2]:cell.fill=PatternFill('solid',fgColor='DCEAE7');cell.font=Font(bold=True)
ws['D6']='=SUM(D3:D5)';ws['A6']='Uncached total';ws.freeze_panes='B3';chart=BarChart();chart.add_data(Reference(ws,min_col=2,min_row=2,max_row=5),titles_from_data=True);chart.set_categories(Reference(ws,min_col=1,min_row=3,max_row=5));chart.title='Trip expenses';ws.add_chart(chart,'F2')
second=wb.create_sheet('明細');second.append(['Description','Value']);second.append(['CJK content',42]);second.append(['Formula without saved result','=1+1']);wb.save(out/'budget.xlsx')
# Give the first sheet stored formula values, keeping D6 deliberately uncached.
path=out/'budget.xlsx'
with zipfile.ZipFile(path) as z: entries={n:z.read(n) for n in z.namelist()}
s=entries['xl/worksheets/sheet1.xml'].decode()
for formula,value in [('B3*C3','3600'),('B4*C4','480'),('B5*C5','720')]:s=s.replace('<f>'+formula+'</f><v></v>','<f>'+formula+'</f><v>'+value+'</v>')
entries['xl/worksheets/sheet1.xml']=s.encode()
with zipfile.ZipFile(path,'w',zipfile.ZIP_DEFLATED) as z:
 for n,data in entries.items():z.writestr(n,data)
prs=Presentation();prs.slide_width=Inches(13.33);prs.slide_height=Inches(7.5)
slide=prs.slides.add_slide(prs.slide_layouts[6]);box=slide.shapes.add_textbox(Inches(.8), Inches(.7), Inches(11), Inches(1.5));box.text_frame.text='Private AI Platform — 私有 AI 平台';box.text_frame.paragraphs[0].font.size=Pt(36);box.text_frame.paragraphs[0].font.bold=True;slide.shapes.add_picture(str(out/'chart.png'),Inches(.8),Inches(2.4),width=Inches(8))
slide=prs.slides.add_slide(prs.slide_layouts[5]);slide.shapes.title.text='Second slide — 第二頁';data=CategoryChartData();data.categories=['Compute','Storage','Network'];data.add_series('Budget',[120,80,45]);slide.shapes.add_chart(XL_CHART_TYPE.COLUMN_CLUSTERED,Inches(1),Inches(1.8),Inches(8),Inches(4.5),data)
slide=prs.slides.add_slide(prs.slide_layouts[5]);slide.shapes.title.text='Delivery checklist';table=slide.shapes.add_table(3,2,Inches(1),Inches(2),Inches(10),Inches(2.5)).table
for i,row in enumerate([('Format','Status'),('Office','Native browser preview'),('HTML','Interactive and isolated')]):
 for j,value in enumerate(row):table.cell(i,j).text=value
prs.save(out/'slides.pptx')
(out/'dashboard.html').write_text('''<!doctype html><html><head><style>body{font:18px system-ui;padding:32px;color:#172b41}button{padding:12px 20px;border:0;border-radius:10px;background:#358c73;color:white}section{padding:24px;background:#eef5f2;border-radius:16px}h1{margin-top:0}</style></head><body><h1>Interactive report</h1><section><p>This file runs entirely inside its isolated preview.</p><button id="counter">Count: 0</button></section><script>let n=0;document.querySelector('#counter').onclick=e=>e.target.textContent='Count: '+(++n);</script></body></html>''')
(out/'security.html').write_text('''<!doctype html><body><h1>Isolation probes</h1><pre id="result"></pre><button id="navigate">Attempt external navigation</button><script>let results={};try{parent.document.body.dataset.hacked='yes';results.parent=true}catch(e){results.parent=false}try{results.cookie=document.cookie}catch(e){results.cookie='blocked'}fetch('https://example.invalid/network-probe').then(()=>results.fetch=true).catch(()=>{results.fetch=false;document.querySelector('#result').textContent=JSON.stringify(results)});document.querySelector('#navigate').onclick=()=>location.href='https://example.invalid/navigation-probe';</script></body>''')
(out/'report.py').write_text('''# A deliverable script; preview must never execute this.\nfrom pathlib import Path\nprint("Library script preview")\n''')
(out/'notes.md').write_text('# Library notes\n\n**Saved independently** of the source chat.\n\n| Feature | State |\n| --- | --- |\n| Versions | Immutable |\n| Library | Ready |\n')
(out/'corrupt.docx').write_bytes(b'not a real Office document')
print(out)

(out/"compatibility.rtf").write_text(r"{\rtf1\ansi\deff0 {\fonttbl {\f0 Arial;}}\f0\fs28 Compatibility preview fixture\par Synthetic report rendered only after an explicit user action.}")

# Optional encryption regression fixture (pip install msoffcrypto-tool==5.4.2).
try:
 import msoffcrypto
 with (out/'report.docx').open('rb') as src, (out/'encrypted.docx').open('wb') as dst:
  msoffcrypto.OfficeFile(src).encrypt('preview-test', dst)
except ImportError:
 pass
