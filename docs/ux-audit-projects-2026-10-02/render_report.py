"""Render the local, screenshot-backed UX review. Does not access the website."""
from pathlib import Path
from html import escape
from datetime import datetime, timezone, timedelta
import hashlib
import json
from PIL import Image

root = Path(__file__).resolve().parent
data = json.loads((root / 'audit.json').read_text(encoding='utf-8'))
data['versionCheck'] = '页面更新检查返回：当前已是最新版本。线上与本地 dist 的资源名仍不同。'

def h(value):
    return escape(str(value), quote=True)

def li(items):
    return '<ul>' + ''.join(f'<li>{h(s)}</li>' for s in items) + '</ul>'

shots = {}
for step in data['steps']:
    for filename in step['files']:
        path = root / filename
        with Image.open(path) as img:
            width, height = img.size
            assert width > 1000 and height > 600, (filename, img.size)
            img.verify()
        shots[filename] = {
            'width': width, 'height': height,
            'sha256': hashlib.sha256(path.read_bytes()).hexdigest(),
            'step': step['n'],
            'captureFileTime': datetime.fromtimestamp(path.stat().st_mtime, timezone(timedelta(hours=8))).isoformat()
        }
assert len(shots) == 21
for finding in data['findings'] + data['secondary']:
    assert all(f in shots for f in finding['evidence'])
manifest = {'date': data['date'], 'timezone': data['timezone'], 'onlineAsset': data['onlineAsset'], 'versionCheck': data['versionCheck'], 'screenshots': shots}
(root / 'evidence-manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding='utf-8')

def refs(files):
    return ' '.join(f'<a class="tag" href="#shot-{h(f)}">图 {h(f[:2])}</a>' for f in files)

def figure(filename):
    meta = shots[filename]
    return f'<figure id="shot-{h(filename)}"><a href="{h(filename)}" target="_blank"><img src="{h(filename)}" width="{meta["width"]}" height="{meta["height"]}" alt="步骤 {meta["step"]}，截图 {h(filename[:2])}" loading="lazy"></a><figcaption>图 {h(filename[:2])} · {h(filename)} · 点击查看原图</figcaption></figure>'

rows = ''.join(f'<tr><td><a href="#{f["id"]}">{h(f["id"])}</a></td><td><span class="priority">{h(f["priority"])}</span></td><td><a href="#{f["id"]}">{h(f["title"])}</a></td><td>{refs(f["evidence"])}</td></tr>' for f in data['findings'])
issues = ''
for f in data['findings']:
    issues += f'<article id="{f["id"]}" class="finding"><p class="eyebrow">{h(f["id"])} · {h(f["priority"])}</p><h3>{h(f["title"])}</h3><p><b>现场观察：</b>{h(f["observed"])}</p><p class="question"><b>新手可能的疑问：</b>{h(f["confusion"])}</p><p><b>建议：</b>{h(f["recommendation"])}</p><p><b>验收方式：</b>{h(f["acceptance"])}</p><p>{refs(f["evidence"])}</p>'
    if 'boundary' in f:
        issues += f'<p class="muted">边界：{h(f["boundary"])}</p>'
    issues += f'<details><summary>源码佐证（与线上观察分开）</summary><p class="code">{h(f["source"])}</p></details></article>'

step_rows = ''.join(f'<tr><td>{s["n"]}</td><td><a href="#step-{s["n"]}">{h(s["name"])}</a></td><td>{h(s["health"])}</td></tr>' for s in data['steps'])
evidence = ''.join(f'<article id="step-{s["n"]}" class="step"><p class="eyebrow">STEP {s["n"]:02d}</p><h3>{h(s["name"])}</h3><p><b>{h(s["health"])}</b></p><p>{h(s["note"])}</p><p class="code">{h(s["route"])}</p><div class="gallery">'+''.join(figure(f) for f in s['files'])+'</div></article>' for s in data['steps'])
copy_rows = ''.join('<tr>'+''.join(f'<td>{h(cell)}</td>' for cell in row)+'</tr>' for row in data['copySuggestions'])
secondary = ''.join(f'<article class="finding"><h3>{h(x["title"])}</h3><p>{h(x["detail"])}</p>{refs(x["evidence"])}</article>' for x in data['secondary'])

css = '''
:root{color-scheme:light;--ink:#17243b;--muted:#516178;--line:#dce3ec;--paper:#f3f5f8;--blue:#245cc0}
*{box-sizing:border-box}html{scroll-behavior:smooth;scroll-padding-top:80px}body{margin:0;background:var(--paper);color:var(--ink);font:16px/1.8 "Segoe UI","Microsoft YaHei",sans-serif}a{color:var(--blue);text-underline-offset:4px}header{background:#17243b;color:#fff;padding:58px max(24px,calc((100% - 1160px)/2)) 38px}header h1{font-size:36px;margin:10px 0}header p{max-width:960px;color:#d5dfef}nav{position:sticky;top:0;background:#fff;border-bottom:1px solid var(--line);padding:12px 24px;z-index:3;display:flex;gap:24px;justify-content:center;flex-wrap:wrap}nav a{text-decoration:none;font-weight:600}main{max-width:1208px;margin:auto;padding:26px 24px 64px}section{margin-bottom:32px;padding:28px;background:#fff;border:1px solid var(--line);border-radius:12px}h2{font-size:25px;margin:0 0 16px}h3{font-size:20px;margin:0 0 12px}.eyebrow{font-size:12px;letter-spacing:1px;font-weight:700;color:#68809e;margin:0}.finding{border-top:1px solid var(--line);padding:24px 0}.finding:last-child{padding-bottom:0}.finding p{margin:10px 0}.question{border-left:4px solid #e0a23a;background:#fff8e9;padding:12px 16px}.muted{color:var(--muted);font-size:14px}.code{font-family:Consolas,"Microsoft YaHei",monospace;font-size:13px;color:#59687d;overflow-wrap:anywhere}table{border-collapse:collapse;width:100%;font-size:15px}td,th{padding:13px 10px;text-align:left;border-bottom:1px solid var(--line);vertical-align:top}th{background:#f2f5fa;font-weight:600}.tag{display:inline-block;font-size:12px;text-decoration:none;background:#eaf0fb;border-radius:5px;padding:2px 7px;margin:2px}.priority{font-size:13px;font-weight:600;white-space:nowrap}details{font-size:14px;color:var(--muted)}summary{cursor:pointer}.step{border-top:1px solid var(--line);padding-top:25px;margin-top:25px}.gallery{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}figure{margin:0;scroll-margin-top:85px}figure img{width:100%;height:auto;display:block;border:1px solid #dae1ea;border-radius:8px}figcaption{font-size:12px;color:var(--muted);margin:5px 0 12px;overflow-wrap:anywhere}.note{background:#edf3fd;border-left:4px solid #477bc8;padding:14px 18px}.badges{display:flex;gap:10px;flex-wrap:wrap}.badges span{font-size:13px;padding:4px 10px;border:1px solid #71839d;border-radius:99px}ul{padding-left:24px}.table-wrap{overflow:auto}footer{color:var(--muted);font-size:13px;margin-top:22px}@media(max-width:760px){header{padding:28px 20px}header h1{font-size:28px}main{padding:16px}section{padding:20px}.gallery{grid-template-columns:1fr}nav{justify-content:flex-start;gap:14px}td,th{min-width:120px}}@media print{nav{position:static}body{background:white}section{border:0;padding:0}figure,.finding{break-inside:avoid}a{color:inherit}details{display:none}}
'''
document = f'''<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>{h(data['title'])} · 2026-10-02</title><style>{css}</style></head><body>
<header><p class="eyebrow">补位 · AI 项目办公室 / 独立 UX 检查</p><h1>{h(data['title'])}</h1><p>{h(data['verdict'])}</p><div class="badges"><span>2026-10-02 · UTC+8</span><span>9 项主要问题</span><span>10 个检查步骤</span><span>21 张本轮截图</span><span>只读审查</span></div></header>
<nav aria-label="报告导航"><a href="#summary">主要结论</a><a href="#issues">问题详情</a><a href="#copy">文案建议</a><a href="#evidence">截图与步骤</a><a href="#limits">范围与限制</a></nav>
<main><section id="summary"><h2>结论与优先级</h2><p>建议优先处理任务类型选择、预审前置条件引导、评分表单和首屏内容顺序，再统一名称与技术文案。无需把所有近似入口都合并。</p><div class="table-wrap"><table><thead><tr><th>编号</th><th>优先级</th><th>已确认问题</th><th>证据</th></tr></thead><tbody>{rows}</tbody></table></div><h3 style="margin-top:26px">值得保留的部分</h3>{li(data['strengths'])}<p class="note">“优先改”表示容易妨碍首次使用或让用户选错流程；“随后改”表示导航、辨认和阅读成本。它们是 UX 排序，不是安全漏洞评级。</p></section>
<section id="issues"><h2>逐项问题与验收方式</h2>{issues}<h2 style="margin-top:30px">补充观察</h2>{secondary}</section>
<section id="copy"><h2>面向新手的文案调整</h2><p>让说明回答四件事：这里做什么、先准备什么、完成后去哪里、会改变什么。下列建议保留实际行为边界，实施前仍需对照后台规则。</p><div class="table-wrap"><table><thead><tr><th>现有表述</th><th>建议表述 / 处理</th><th>目的</th></tr></thead><tbody>{copy_rows}</tbody></table></div><p class="note">可在项目首次进入时提供一条可跳过的流程提示：导入参考资料 → 核对要求与评分 → 安排任务、编写成果 → 检查与演练。每一步直接跳转对应页面，并展示是否已完成。</p></section>
<section id="evidence"><h2>本轮检查步骤与原始截图</h2><p>截图按实际检查顺序保存。所有图像来自用户更新后重新加载的线上页面，保存后重新读取检查；点击图片可查看原图。</p><div class="table-wrap"><table><thead><tr><th>步骤</th><th>检查内容</th><th>状态</th></tr></thead><tbody>{step_rows}</tbody></table></div>{evidence}</section>
<section id="limits"><h2>检查范围与证据边界</h2><p>{h(data['scope'])}</p><p><b>目标：</b><a href="{h(data['site']+data['projectPath'])}">{h(data['site']+data['projectPath'])}</a></p><p><b>样本：</b>{h(data['project'])}</p><p>{h(data['versionNote'])}</p><p>{h(data['versionCheck'])}</p><p class="code">线上资源：{h(data['onlineAsset'])}<br>本地构建：{h(data['localAssetAtComparison'])}<br>本地 HEAD：{h(data['localHead'])}（工作区有用户未提交修改）</p><h3>验证方式</h3>{li(data['method'])}<h3>未验证项与限制</h3>{li(data['limits'])}<p>本轮交付：report.html、audit.json、evidence-manifest.json、render_report.py 和 21 张 JPG 截图。报告生成脚本仅读取本地证据，不访问网站或更改业务数据。</p><p>推荐下一步：先将 F01–F04 转为一个小范围修改批次，完成后沿同样步骤复查。</p></section><footer>本地报告 · 没有上传或发布 · 证据文件校验见 evidence-manifest.json</footer></main></body></html>'''
(root / 'report.html').write_text(document, encoding='utf-8')
print(json.dumps({'report':str(root/'report.html'),'findings':len(data['findings']),'steps':len(data['steps']),'screenshots':len(shots),'result':'PASS'}, ensure_ascii=False))
