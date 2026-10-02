from pathlib import Path
import sys
sys.path.append(str(Path.home()/'.cache/codex-runtimes/codex-primary-runtime/dependencies/python/Lib/site-packages'))
from reportlab.pdfgen import canvas
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.cidfonts import UnicodeCIDFont
from reportlab.lib.pagesizes import A4
import pymupdf as fitz

out=Path('output/pdf/ai-acceptance');out.mkdir(parents=True,exist_ok=True)
pdfmetrics.registerFont(UnicodeCIDFont('STSong-Light'))
pages=[
 ('项目通知：校园节能调查',[
  '本文件为功能验收生成的虚构测试资料，不代表真实比赛。',
  '主目标：完成校园节能调查报告，并制作可答辩的演示材料。',
  '提交截止日期：2026-10-15。报告至少包含3个调查样本和数据来源。',
  '交付物：调查报告、数据表、演示文稿、5分钟答辩提纲。',
  '任务依赖：先收集数据，再分析数据，最后制作演示材料。']),
 ('验收要求与既有工作',[
  '已完成：问卷框架设计。不应重复创建问卷框架设计任务。',
  '尚未完成：采集3个样本、数据分析、报告编写和答辩准备。',
  '评分维度：内容完整性60%，证据质量40%。',
  '每份报告必须明确假设与限制，不能把未采集数据当作真实结果。',
  '负责人反馈：本阶段先完成样本采集，演示材料可同步准备结构。']),
 ('文件尾部的关键修订',[
  '修订编号：FINAL-TAIL-2026-10-02。',
  '本修订优先于第一页：提交截止日期改为2026-10-18。',
  '报告新增要求：附原始数据来源与样本采集日期。',
  '最终验收暗号：青竹尾页。',
  'AI应指出前后日期冲突，引用本页修订，不得无依据自行选择。'])]
path=out/'project-notice.pdf';c=canvas.Canvas(str(path),pagesize=A4)
for title,lines in pages:
 c.setFont('STSong-Light',19);c.drawString(48,790,title)
 c.setFont('STSong-Light',12)
 for i,line in enumerate(lines):c.drawString(48,745-i*36,line)
 c.showPage()
c.save()
doc=fitz.open(path)
assert len(doc)==3
assert '青竹尾页' in ''.join(page.get_text() for page in doc)
doc[0].get_pixmap(matrix=fitz.Matrix(1.3,1.3)).save(out/'project-notice-preview.png')
scan=out/'scanned-notice.pdf';s=canvas.Canvas(str(scan),pagesize=A4)
image=out/'project-notice-preview.png';s.drawImage(str(image),0,0,width=A4[0],height=A4[1]);s.save()
doc.close()
(out/'reference-conflict.md').write_text('# 旧版参考资料\n\n此文件是旧版，截止时间曾为2026-10-12。最新提交期限以project-notice.pdf尾页修订为准。\n\n已有成果：问卷框架。负责人反馈：不要重复拆分已完成工作。\n',encoding='utf-8')
print('Generated two PDFs, one Markdown and a rendered preview; text/tail assertions passed.')
