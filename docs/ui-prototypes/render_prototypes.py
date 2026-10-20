
import argparse
import os
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

OUT_DIR = Path(__file__).resolve().parent

def load_font(size, bold=False):
    candidates = [
        r"C:\Windows\Fonts\msyhbd.ttc" if bold else r"C:\Windows\Fonts\msyh.ttc",
        r"C:\Windows\Fonts\simhei.ttf",
        r"C:\Windows\Fonts\arial.ttf",
    ]
    for path in candidates:
        if os.path.exists(path):
            try:
                return ImageFont.truetype(path, size)
            except Exception:
                pass
    return ImageFont.load_default()

F_H1 = load_font(26, True)
F_H2 = load_font(20, True)
F_H3 = load_font(16, True)
F_B_BOLD = load_font(14, True)
F_B = load_font(14, False)
F_S_BOLD = load_font(12, True)
F_S = load_font(12, False)
F_XS_BOLD = load_font(11, True)
F_XS = load_font(11, False)

def pill(draw, x, y, text, bg, fg, font=F_XS_BOLD, pad_x=10, pad_y=4):
    bbox = draw.textbbox((0, 0), text, font=font)
    w = (bbox[2] - bbox[0]) + pad_x * 2
    h = (bbox[3] - bbox[1]) + pad_y * 2 + 2
    draw.rounded_rectangle([x, y, x + w, y + h], radius=h // 2, fill=bg)
    draw.text((x + pad_x, y + pad_y - 1), text, fill=fg, font=font)
    return w, h

def icon_badge(draw, x, y, ch, bg, fg, size=20):
    draw.rounded_rectangle([x, y, x + size, y + size], radius=5, fill=bg)
    bbox = draw.textbbox((0, 0), ch, font=F_XS_BOLD)
    tw = bbox[2] - bbox[0]
    th = bbox[3] - bbox[1]
    draw.text((x + (size - tw) / 2, y + (size - th) / 2 - 2), ch, fill=fg, font=F_XS_BOLD)

def card(draw, box, fill="#FFFFFF", outline="#E2E8F0", radius=10, width=1):
    draw.rounded_rectangle(box, radius=radius, fill=fill, outline=outline, width=width)

# ==============================================================================
# IMAGE 1: WinUI 3 Desktop Prototype (1600 x 980)
# ==============================================================================
def render_desktop_winui3():
    W, H = 1600, 980
    img = Image.new("RGB", (W, H), "#E8EEF7")
    draw = ImageDraw.Draw(img)

    # Outer Title Banner
    draw.text((36, 22), "「补位 · AI 项目办公室」电脑客户端原型 — Windows 11 WinUI 3 Fluent 2 三栏主从架构", fill="#0F172A", font=F_H2)
    pill(draw, 910, 22, "WinUI 3.0 · Mica Alt 材质", "#DBEAFE", "#1D4ED8", F_S_BOLD)
    pill(draw, 1110, 22, "零 WebView2 · 原生 XAML 渲染", "#F3E8FF", "#6D28D9", F_S_BOLD)
    pill(draw, 1345, 22, "固定版本 + DSH 本地桥接", "#CCFBF1", "#0F766E", F_S_BOLD)

    # Window Shadow & Frame
    win_box = [32, 66, W - 32, H - 28]
    draw.rounded_rectangle([36, 72, W - 28, H - 22], radius=14, fill="#CBD5E1")
    card(draw, win_box, fill="#F3F5F9", outline="#94A3B8", radius=12, width=2)

    wx1, wy1, wx2, wy2 = win_box

    # 1. Custom WinUI 3 TitleBar (ExtendsContentIntoTitleBar)
    tb_h = 46
    draw.rounded_rectangle([wx1, wy1, wx2, wy1 + tb_h + 10], radius=12, fill="#EAEFF6")
    draw.rectangle([wx1, wy1 + tb_h - 4, wx2, wy1 + tb_h], fill="#EAEFF6")
    draw.line([wx1, wy1 + tb_h, wx2, wy1 + tb_h], fill="#D8E0EC", width=1)

    # App Icon + Breadcrumb
    draw.rounded_rectangle([wx1 + 16, wy1 + 12, wx1 + 38, wy1 + 34], radius=6, fill="#2563EB")
    draw.text((wx1 + 21, wy1 + 13), "补", fill="#FFFFFF", font=F_S_BOLD)
    draw.text((wx1 + 48, wy1 + 14), "补位 AI 项目办公室  |  2026 挑战杯·智能无人巡检系统  ›  任务与证据工作台", fill="#1E293B", font=F_S_BOLD)

    # Center AutoSuggestBox
    sb_x1, sb_x2 = 630, 1055
    card(draw, [sb_x1, wy1 + 8, sb_x2, wy1 + 38], fill="#FFFFFF", outline="#CBD5E1", radius=6)
    draw.line([sb_x1 + 2, wy1 + 38, sb_x2 - 2, wy1 + 38], fill="#2563EB", width=2)
    draw.text((sb_x1 + 12, wy1 + 14), "● 搜索任务、固定版本文档、评分引用或输入 > 唤醒命令...", fill="#64748B", font=F_XS)
    pill(draw, sb_x2 - 64, wy1 + 12, "Ctrl+K", "#F1F5F9", "#475569", F_XS_BOLD, 6, 2)

    # Right Status Pills + Window Caption Buttons
    pill(draw, 1075, wy1 + 12, "● SQLite 快照已同步 (rev#48)", "#CCFBF1", "#0F766E", F_XS_BOLD)
    pill(draw, 1275, wy1 + 12, "◆ DSH Bridge: 在线", "#F3E8FF", "#6D28D9", F_XS_BOLD)
    draw.text((wx2 - 115, wy1 + 14), "─     □     ×", fill="#475569", font=F_S_BOLD)

    # 2. Body Layout: Left NavigationView (232px) + Center Frame + Right Inspector (348px)
    body_top = wy1 + tb_h + 1
    body_bot = wy2 - 30
    nav_w = 232
    insp_w = 348
    main_x1 = wx1 + nav_w
    main_x2 = wx2 - insp_w

    # Left NavigationView Pane
    draw.rectangle([wx1 + 1, body_top, main_x1, body_bot], fill="#EAEFF6")
    draw.line([main_x1, body_top, main_x1, body_bot], fill="#D8E0EC", width=1)

    # Project Picker Card in Nav
    card(draw, [wx1 + 12, body_top + 12, main_x1 - 12, body_top + 86], fill="#FFFFFF", outline="#CBD5E1", radius=8)
    draw.text((wx1 + 22, body_top + 20), "当前活跃项目 · 项目负责人", fill="#2563EB", font=F_XS_BOLD)
    draw.text((wx1 + 22, body_top + 38), "智能无人巡检系统  ▼", fill="#0F172A", font=F_B_BOLD)
    draw.text((wx1 + 22, body_top + 60), "距省赛截止还剩 6 天 14 小时", fill="#B45309", font=F_XS_BOLD)

    nav_items = [
        ("概", "项目概览与主目标", "78%", False, "#DBEAFE", "#1D4ED8"),
        ("任", "任务协作与验收闭环", "3待审", True, "#FEF3C7", "#B45309"),
        ("资", "资料库与富文档版本", "v12", False, "#E2E8F0", "#475569"),
        ("评", "标准、评分与语音演练", "88.5分", False, "#CCFBF1", "#0F766E"),
        ("智", "AI 协助与 DSH 桥接", "在线", False, "#F3E8FF", "#6D28D9"),
        ("队", "团队权限与留档导出", "6人", False, "#E2E8F0", "#475569"),
    ]
    ny = body_top + 102
    draw.text((wx1 + 18, ny), "项目核心工作区 (NavigationView)", fill="#64748B", font=F_XS_BOLD)
    ny += 24
    for ic, label, badge, active, b_bg, b_fg in nav_items:
        if active:
            card(draw, [wx1 + 10, ny, main_x1 - 10, ny + 38], fill="#FFFFFF", outline="#BFDBFE", radius=6)
            draw.rounded_rectangle([wx1 + 10, ny + 7, wx1 + 14, ny + 31], radius=2, fill="#2563EB")
            icon_badge(draw, wx1 + 20, ny + 9, ic, "#2563EB", "#FFFFFF", 20)
            draw.text((wx1 + 46, ny + 10), label, fill="#0F172A", font=F_S_BOLD)
        else:
            icon_badge(draw, wx1 + 20, ny + 9, ic, "#E2E8F0", "#475569", 20)
            draw.text((wx1 + 46, ny + 10), label, fill="#475569", font=F_S)
        pill(draw, main_x1 - 66, ny + 9, badge, b_bg, b_fg, F_XS_BOLD, 7, 2)
        ny += 44

    # Bottom Global Items in Nav
    ny = body_bot - 140
    draw.line([wx1 + 14, ny, main_x1 - 14, ny], fill="#D8E0EC", width=1)
    icon_badge(draw, wx1 + 18, ny + 10, "档", "#E2E8F0", "#475569", 20)
    draw.text((wx1 + 44, ny + 11), "全局个人资料与 AI 授权", fill="#475569", font=F_S)
    icon_badge(draw, wx1 + 18, ny + 40, "工", "#E2E8F0", "#475569", 20)
    draw.text((wx1 + 44, ny + 41), "站内支持工单 & 帮助文档", fill="#475569", font=F_S)

    card(draw, [wx1 + 10, body_bot - 56, main_x1 - 10, body_bot - 10], fill="#FFFFFF", outline="#CBD5E1", radius=8)
    draw.ellipse([wx1 + 18, body_bot - 48, wx1 + 46, body_bot - 20], fill="#2563EB")
    draw.text((wx1 + 26, body_bot - 43), "林", fill="#FFFFFF", font=F_S_BOLD)
    draw.text((wx1 + 54, body_bot - 48), "林知远 (lin_zy)", fill="#0F172A", font=F_S_BOLD)
    draw.text((wx1 + 54, body_bot - 30), "超级管理员 · 项目负责人", fill="#64748B", font=F_XS)

    # 3. Center Main Content Frame
    draw.rectangle([main_x1 + 1, body_top, main_x2, body_bot], fill="#F8FAFC")
    cx1, cy1 = main_x1 + 20, body_top + 16
    cx2 = main_x2 - 20

    # CommandBar Header
    draw.text((cx1, cy1), "任务协作与固定版本验收工作台", fill="#0F172A", font=F_H3)
    draw.text((cx1, cy1 + 24), "独立主目标统领平级依赖任务 · 软依赖提示不阻塞提前认领 · 成果绑定固定版本与任务文件", fill="#64748B", font=F_XS)
    pill(draw, cx2 - 365, cy1 + 4, "★ AI 拆解与智能分工", "#F3E8FF", "#6D28D9", F_S_BOLD, 12, 6)
    pill(draw, cx2 - 190, cy1 + 4, "↑ Office 正文导入", "#FFFFFF", "#1E293B", F_S_BOLD, 12, 6)
    pill(draw, cx2 - 48, cy1 + 4, "＋ 新建", "#2563EB", "#FFFFFF", F_S_BOLD, 12, 6)

    # Main Goal Banner
    gy = cy1 + 52
    card(draw, [cx1, gy, cx2, gy + 84], fill="#EFF6FF", outline="#93C5FD", radius=10)
    pill(draw, cx1 + 14, gy + 12, "◎ 独立主目标 (GraphRev #19)", "#2563EB", "#FFFFFF", F_XS_BOLD)
    pill(draw, cx1 + 210, gy + 12, "分工模式：负责人确认 · 验收模式：AI 自动初审 + 人工确认附件", "#CCFBF1", "#0F766E", F_XS_BOLD)
    draw.text((cx1 + 14, gy + 38), "完成《智能无人巡检系统》省赛申报书、RTK-VIO 定位误差实测 (<2cm) 与 8 分钟语音答辩演练", fill="#0F172A", font=F_B_BOLD)
    draw.text((cx1 + 14, gy + 60), "生效标准：Standard v4 (总分 88.5/100)  ·  已完成任务：9 / 12 (78%)  ·  团队每周可用总工时：116h", fill="#475569", font=F_XS)

    # 4 KPI Row
    ky = gy + 96
    kw = (cx2 - cx1 - 36) // 4
    kpis = [
        ("平级协作任务", "9 / 12", "2 项已完成(待人工审核)", "#2563EB"),
        ("固定版本材料检查", "88.5 分", "基于 Standard v4 · v12", "#0D9488"),
        ("本机 Office 与资料", "24 份", "16,000字符批次+SHA256", "#6D28D9"),
        ("任务内私密质询", "1 未读", "一对一隔离 · 4 活跃会话", "#D97706"),
    ]
    for i, (k_title, k_val, k_sub, k_col) in enumerate(kpis):
        kx = cx1 + i * (kw + 12)
        card(draw, [kx, ky, kx + kw, ky + 78], fill="#FFFFFF", outline="#E2E8F0", radius=8)
        draw.text((kx + 12, ky + 10), k_title, fill="#64748B", font=F_XS_BOLD)
        draw.text((kx + 12, ky + 28), k_val, fill=k_col, font=F_H2)
        draw.text((kx + 12, ky + 56), k_sub, fill="#64748B", font=F_XS)

    # Task List Section
    ty = ky + 92
    draw.text((cx1, ty), "■ 平级依赖任务列表（支持按前置拓扑顺序浏览与软依赖提前提交）", fill="#0F172A", font=F_B_BOLD)
    ty += 26

    tasks = [
        ("T-07", "边缘端视觉避障延迟实测与图表整理", "前置: T-04(已通过) · 绑定《第4章-实验验证》(固定版本 v12) + 2 份任务文件", "陈昊 · 第2轮", "已完成 (待人工审核)", "#FEF3C7", "#B45309", True),
        ("T-08", "商业化落地痛点与三年财务预测模型", "前置: T-03(软依赖提示) · 绑定《第6章-商业模式》(固定版本 v8)", "周敏 · 第1轮", "需改进 (Improve)", "#FEE2E2", "#B91C1C", False),
        ("T-09", "国内外无人巡检竞品专利对比矩阵", "前置: T-01(已通过) · 本机 DSH Agent 已回传富文档草稿 (待勾选复核)", "林知远 · 进行中", "DSH 草稿待采纳", "#F3E8FF", "#6D28D9", False),
        ("T-10", "室外复杂光照双目相机标定现场录像采集", "包含实物硬件现场操作 · 系统已禁用 AI 代实施（仅可生成辅助计划）", "待认领 · 预计12h", "待认领 (可提前认领)", "#DBEAFE", "#1D4ED8", False),
    ]
    for code, title, sub, owner, status, s_bg, s_fg, sel in tasks:
        card(draw, [cx1, ty, cx2, ty + 62], fill="#EFF6FF" if sel else "#FFFFFF", outline="#2563EB" if sel else "#E2E8F0", radius=8, width=2 if sel else 1)
        pill(draw, cx1 + 12, ty + 12, code, "#F1F5F9", "#334155", F_XS_BOLD, 8, 3)
        draw.text((cx1 + 68, ty + 10), title, fill="#0F172A", font=F_B_BOLD)
        draw.text((cx1 + 68, ty + 34), sub, fill="#64748B", font=F_XS)
        draw.text((cx2 - 280, ty + 22), owner, fill="#334155", font=F_XS_BOLD)
        pill(draw, cx2 - 165, ty + 18, status, s_bg, s_fg, F_XS_BOLD, 9, 4)
        ty += 70

    # Bottom Split: Fixed Version Acceptance + Private Task Inquiry
    by = ty + 6
    bw = (cx2 - cx1 - 14) // 2
    # Left Card: Acceptance
    card(draw, [cx1, by, cx1 + bw, body_bot - 12], fill="#FFFFFF", outline="#CBD5E1", radius=8)
    draw.text((cx1 + 14, by + 12), "◆ T-07 第 2 轮固定版本成果验收面板", fill="#0F172A", font=F_B_BOLD)
    pill(draw, cx1 + bw - 135, by + 12, "绑定 Material v12", "#DBEAFE", "#1D4ED8", F_XS_BOLD)
    draw.text((cx1 + 14, by + 40), "成果说明：已补充 30 组逆光与降雨模拟下 RTK+视觉避障延迟，均值 18.4ms", fill="#334155", font=F_XS)
    draw.text((cx1 + 14, by + 60), "任务文件：[文档] 实验验证(v12)  ·  [表格] rtk_latency_30runs.xlsx  ·  [图] wave.png", fill="#2563EB", font=F_XS_BOLD)
    card(draw, [cx1 + 14, by + 84, cx1 + bw - 14, by + 114], fill="#F8FAFC", outline="#CBD5E1", radius=6)
    draw.text((cx1 + 22, by + 92), "验收意见：原始波形与置信区间核验无误，准予通过。", fill="#475569", font=F_XS)
    pill(draw, cx1 + 14, by + 122, "● 接受 (Accept)", "#0D9488", "#FFFFFF", F_XS_BOLD, 12, 5)
    pill(draw, cx1 + 135, by + 122, "需改进 (Improve)", "#FEF3C7", "#B45309", F_XS_BOLD, 12, 5)
    pill(draw, cx1 + 265, by + 122, "需重做 (Rework)", "#FEE2E2", "#B91C1C", F_XS_BOLD, 12, 5)

    # Right Card: Private Inquiry
    rx1 = cx1 + bw + 14
    card(draw, [rx1, by, cx2, body_bot - 12], fill="#FFFFFF", outline="#CBD5E1", radius=8)
    draw.text((rx1 + 14, by + 12), "◆ 任务内一对一私密质询 (仅林知远 <-> 陈昊可见)", fill="#0F172A", font=F_B_BOLD)
    pill(draw, cx2 - 90, by + 12, "● 1 条新回复", "#FEE2E2", "#B91C1C", F_XS_BOLD)
    card(draw, [rx1 + 14, by + 40, cx2 - 14, by + 78], fill="#F8FAFC", outline="#E2E8F0", radius=6)
    draw.text((rx1 + 20, by + 48), "林知远：第 17 组逆光测试 31ms 尖峰是否已在正文中说明滤波策略？", fill="#475569", font=F_XS)
    card(draw, [rx1 + 14, by + 84, cx2 - 14, by + 146], fill="#EFF6FF", outline="#93C5FD", radius=6)
    draw.text((rx1 + 20, by + 92), "陈昊 (10:28)：已在固定版本 v12 第 3.2 节补充卡尔曼重投影降级说明，", fill="#1E3A8A", font=F_XS_BOLD)
    draw.text((rx1 + 20, by + 112), "并附上了真机日志截图，点击右侧检查器可直接预览固定版本段落。", fill="#1E3A8A", font=F_XS)

    # 4. Right Acrylic Contextual Inspector
    ix1 = main_x2 + 1
    draw.rectangle([ix1, body_top, wx2 - 1, body_bot], fill="#EEF2F9")
    draw.line([main_x2, body_top, main_x2, body_bot], fill="#D8E0EC", width=1)

    iy = body_top + 16
    draw.text((ix1 + 16, iy), "◆ 上下文智能检查器 (Acrylic Inspector)", fill="#334155", font=F_S_BOLD)
    iy += 28

    # Inspector Card 1: Fixed Version & Draft Guard
    card(draw, [ix1 + 14, iy, wx2 - 14, iy + 156], fill="#FFFFFF", outline="#CBD5E1", radius=8)
    draw.text((ix1 + 26, iy + 12), "■ 固定版本证据与草稿锁 (Task #T-07)", fill="#0F172A", font=F_S_BOLD)
    draw.text((ix1 + 26, iy + 38), "• 绑定文档：第4章-实验验证 (Material v12)", fill="#475569", font=F_XS)
    draw.text((ix1 + 26, iy + 58), "• 内容指纹：SHA-256 9d4a...71e0 (不可篡改)", fill="#475569", font=F_XS)
    draw.text((ix1 + 26, iy + 78), "• 本机草稿：expectedRevision=12 自动持久化", fill="#0F766E", font=F_XS_BOLD)
    draw.text((ix1 + 26, iy + 98), "• 冲突保护：版本不一致时保留双端草稿对照", fill="#475569", font=F_XS)
    pill(draw, ix1 + 26, iy + 120, "对照 v11/v12 差异", "#DBEAFE", "#1D4ED8", F_XS_BOLD)
    pill(draw, ix1 + 160, iy + 120, "查看历史轮次 (2)", "#F1F5F9", "#334155", F_XS_BOLD)
    iy += 170

    # Inspector Card 2: Native Voice Rehearsal Mini Monitor
    card(draw, [ix1 + 14, iy, wx2 - 14, iy + 190], fill="#FFFFFF", outline="#CBD5E1", radius=8)
    draw.text((ix1 + 26, iy + 12), "■ 语音答辩演练 #04 (TTS + PCM)", fill="#0F172A", font=F_S_BOLD)
    pill(draw, wx2 - 88, iy + 10, "● 01:18", "#FEE2E2", "#B91C1C", F_XS_BOLD)
    draw.text((ix1 + 26, iy + 36), "评委提问 (本地 TTS 朗读)：强逆光特征丢失时", fill="#64748B", font=F_XS)
    draw.text((ix1 + 26, iy + 52), "RTK 与 IMU 紧耦合权重如何动态切换？", fill="#64748B", font=F_XS)
    card(draw, [ix1 + 26, iy + 74, wx2 - 26, iy + 142], fill="#F8FAFC", outline="#93C5FD", radius=6)
    draw.text((ix1 + 34, iy + 82), "[实时转录人工核对] 当内点率低于35%时，", fill="#1E293B", font=F_XS)
    draw.text((ix1 + 34, iy + 100), "ESKF 自动放大视觉协方差，切换至 RTK 主导", fill="#1E293B", font=F_XS)
    draw.text((ix1 + 34, iy + 118), "模式，过渡耗时 < 8ms。", fill="#0F766E", font=F_XS_BOLD)
    pill(draw, ix1 + 26, iy + 150, "● 核对无误并提交回答", "#2563EB", "#FFFFFF", F_XS_BOLD, 12, 4)
    iy += 204

    # Inspector Card 3: AI & DSH Bridge Recovery
    card(draw, [ix1 + 14, iy, wx2 - 14, body_bot - 12], fill="#FFFFFF", outline="#CBD5E1", radius=8)
    draw.text((ix1 + 26, iy + 12), "■ AI 异步队列与 DSH 持久意图锁", fill="#0F172A", font=F_S_BOLD)
    draw.text((ix1 + 26, iy + 38), "• 最近模型返回：2026-10-20 09:31:42", fill="#475569", font=F_XS)
    draw.text((ix1 + 26, iy + 58), "• 失败恢复：支持「从停止处继续」(复用已存步骤)", fill="#475569", font=F_XS)
    draw.text((ix1 + 26, iy + 78), "• 录制守护：每 5 分钟自动分段落盘 + 恢复日志", fill="#475569", font=F_XS)
    pill(draw, ix1 + 26, iy + 104, "● 从停止处继续", "#F3E8FF", "#6D28D9", F_XS_BOLD)
    pill(draw, ix1 + 158, iy + 104, "↓ 导出项目留档", "#CCFBF1", "#0F766E", F_XS_BOLD)

    # 5. Bottom WinUI StatusBar
    draw.rounded_rectangle([wx1, body_bot, wx2, wy2], radius=12, fill="#EAEFF6")
    draw.line([wx1, body_bot, wx2, body_bot], fill="#D8E0EC", width=1)
    draw.text((wx1 + 16, body_bot + 7), "● 在线 · /api/v1 同源契约  |  ■ SaveBeforeCloseAsync 草稿守护已启用 (密码/API Key 绝不落盘)", fill="#475569", font=F_XS)
    draw.text((wx2 - 390, body_bot + 7), "WinUI 3.0 (Windows App SDK 2.5.1)  ·  内存 68 MB  ·  0 WebView2", fill="#334155", font=F_XS_BOLD)

    out_path = os.path.join(OUT_DIR, "winui3-desktop-prototype.png")
    img.save(out_path)
    print("Saved:", out_path)

# ==============================================================================
# IMAGE 2: Mobile Native Prototype Suite (1600 x 980, 3 Phone Screens Side-by-Side)
# ==============================================================================
def render_mobile_suite():
    W, H = 1600, 980
    img = Image.new("RGB", (W, H), "#EEF2F7")
    draw = ImageDraw.Draw(img)

    # Header
    draw.text((40, 22), "「补位 · AI 项目办公室」手机客户端原型 — 移动优先卡片流、现场分段录制与随身语音答辩", fill="#0F172A", font=F_H2)
    pill(draw, 980, 22, "单手拇指热区交互", "#DBEAFE", "#1D4ED8", F_S_BOLD)
    pill(draw, 1145, 22, "5分钟分段防丢录制 + 扫描补页", "#CCFBF1", "#0F766E", F_S_BOLD)
    pill(draw, 1390, 22, "离线版本冲突保护", "#FEF3C7", "#B45309", F_S_BOLD)

    phones = [
        ("Screen 1 · 移动总控与优先待办", "聚焦单一主目标、待审任务与一对一未读质询", 55),
        ("Screen 2 · 现场采集与随身语音答辩", "5分钟分段录音落盘 + 本地TTS提问与实时字幕核对", 565),
        ("Screen 3 · 任务验收、离线冲突与双轨隐私", "固定版本成果审批、双端冲突对照与AI授权隔离", 1075),
    ]

    for idx, (p_title, p_sub, px) in enumerate(phones):
        draw.text((px + 14, 68), p_title, fill="#0F172A", font=F_B_BOLD)
        draw.text((px + 14, 90), p_sub, fill="#64748B", font=F_XS)

        # Phone Outer Bezel (468 x 830)
        pw, ph = 468, 830
        py = 116
        draw.rounded_rectangle([px + 4, py + 6, px + pw + 4, py + ph + 6], radius=42, fill="#CBD5E1")
        draw.rounded_rectangle([px, py, px + pw, py + ph], radius=42, fill="#0F172A")
        # Inner Screen
        sx1, sy1, sx2, sy2 = px + 12, py + 12, px + pw - 12, py + ph - 12
        draw.rounded_rectangle([sx1, sy1, sx2, sy2], radius=32, fill="#F4F6FA")

        # Status Bar & Dynamic Island
        draw.text((sx1 + 24, sy1 + 12), "09:34", fill="#0F172A", font=F_XS_BOLD)
        draw.rounded_rectangle([sx1 + 168, sy1 + 10, sx2 - 168, sy1 + 28], radius=9, fill="#0F172A")
        draw.text((sx2 - 78, sy1 + 12), "5G · 96%", fill="#0F172A", font=F_XS_BOLD)

        # App Bar
        ay = sy1 + 38
        draw.rectangle([sx1, ay, sx2, ay + 52], fill="#FFFFFF")
        draw.line([sx1, ay + 52, sx2, ay + 52], fill="#E2E8F0", width=1)

        if idx == 0:
            draw.text((sx1 + 18, ay + 8), "智能无人巡检系统  ▼", fill="#0F172A", font=F_B_BOLD)
            draw.text((sx1 + 18, ay + 30), "省赛冲刺 · 离线缓存就绪 (rev#48)", fill="#64748B", font=F_XS)
            pill(draw, sx2 - 96, ay + 14, "● 已同步", "#CCFBF1", "#0F766E", F_XS_BOLD)

            cy = ay + 66
            # Hero Main Goal Card
            card(draw, [sx1 + 14, cy, sx2 - 14, cy + 122], fill="#2563EB", outline="#1D4ED8", radius=16)
            draw.text((sx1 + 28, cy + 14), "◎ 独立主目标 (GraphRev #19)", fill="#DBEAFE", font=F_XS_BOLD)
            draw.text((sx2 - 135, cy + 14), "剩 6 天 14 小时", fill="#FEF3C7", font=F_XS_BOLD)
            draw.text((sx1 + 28, cy + 38), "省赛申报书、RTK 实测 (<2cm)", fill="#FFFFFF", font=F_B_BOLD)
            draw.text((sx1 + 28, cy + 60), "与 8 分钟答辩演练全闭环", fill="#FFFFFF", font=F_B_BOLD)
            draw.rounded_rectangle([sx1 + 28, cy + 92, sx2 - 28, cy + 102], radius=5, fill="#1E40AF")
            draw.rounded_rectangle([sx1 + 28, cy + 92, sx1 + 320, cy + 102], radius=5, fill="#34D399")
            draw.text((sx2 - 70, cy + 84), "78%", fill="#FFFFFF", font=F_B_BOLD)
            cy += 136

            # Urgent Action Queue
            card(draw, [sx1 + 14, cy, sx2 - 14, cy + 195], fill="#FFFFFF", outline="#F59E0B", radius=14, width=2)
            draw.text((sx1 + 26, cy + 12), "◆ 待你优先响应 (按个人关联排序)", fill="#B45309", font=F_S_BOLD)
            pill(draw, sx2 - 84, cy + 10, "3 项待办", "#FEF3C7", "#B45309", F_XS_BOLD)

            card(draw, [sx1 + 24, cy + 40, sx2 - 24, cy + 106], fill="#FFFBEB", outline="#FDE68A", radius=10)
            draw.text((sx1 + 34, cy + 48), "[待人工审核] T-07 边缘端避障延迟实测", fill="#0F172A", font=F_XS_BOLD)
            draw.text((sx1 + 34, cy + 68), "AI 初审正文达标 · 待核验陈昊上传的 2 份附件", fill="#475569", font=F_XS)
            pill(draw, sx2 - 108, cy + 66, "去核验 ›", "#2563EB", "#FFFFFF", F_XS_BOLD)

            card(draw, [sx1 + 24, cy + 114, sx2 - 24, cy + 180], fill="#FEF2F2", outline="#FECACA", radius=10)
            draw.text((sx1 + 34, cy + 122), "● [私密质询未读] T-07 逆光尖峰滤波说明", fill="#991B1B", font=F_XS_BOLD)
            draw.text((sx1 + 34, cy + 142), "陈昊 10:28 回复了你的一对一质询（其他成员不可见）", fill="#7F1D1D", font=F_XS)
            cy += 208

            # Dependency Stream Card
            card(draw, [sx1 + 14, cy, sx2 - 14, cy + 198], fill="#FFFFFF", outline="#E2E8F0", radius=14)
            draw.text((sx1 + 26, cy + 12), "■ 平级任务与软依赖提示（允许提前认领）", fill="#0F172A", font=F_S_BOLD)
            rows = [
                ("T-04 核心算法实测数据汇总", "已通过 (v9)", "#CCFBF1", "#0F766E"),
                ("T-07 边缘端视觉避障延迟实测", "待人工审核", "#FEF3C7", "#B45309"),
                ("T-09 竞品专利对比矩阵 (DSH草稿)", "待勾选采纳", "#F3E8FF", "#6D28D9"),
                ("T-10 室外双目相机标定现场录像", "待认领(真人)", "#DBEAFE", "#1D4ED8"),
            ]
            ry = cy + 40
            for r_t, r_s, r_bg, r_fg in rows:
                draw.text((sx1 + 26, ry + 4), r_t, fill="#334155", font=F_XS_BOLD)
                pill(draw, sx2 - 118, ry, r_s, r_bg, r_fg, F_XS_BOLD, 8, 3)
                ry += 38

        elif idx == 1:
            draw.text((sx1 + 18, ay + 8), "现场采集与随身语音答辩", fill="#0F172A", font=F_B_BOLD)
            draw.text((sx1 + 18, ay + 30), "5分钟分段录音防丢 · 本地TTS提问 + 字幕人工核对", fill="#64748B", font=F_XS)
            pill(draw, sx2 - 96, ay + 14, "● 采集中", "#FEE2E2", "#B91C1C", F_XS_BOLD)

            cy = ay + 66
            # Segmented Field Recorder Card
            card(draw, [sx1 + 14, cy, sx2 - 14, cy + 196], fill="#FFFFFF", outline="#93C5FD", radius=14, width=2)
            draw.text((sx1 + 26, cy + 12), "● 现场原生录制 (5 分钟自动分段落盘)", fill="#0F172A", font=F_S_BOLD)
            pill(draw, sx2 - 92, cy + 10, "● 04:12", "#FEE2E2", "#B91C1C", F_XS_BOLD)
            draw.text((sx1 + 26, cy + 36), "标题：《室外巡检抗逆光测试导师现场指导纪要》", fill="#475569", font=F_XS)
            draw.text((sx1 + 26, cy + 54), "贡献人：陈昊、林知远  ·  分段 #01 已写入本机恢复日志", fill="#0F766E", font=F_XS_BOLD)

            # Waveform bars
            wx = sx1 + 36
            heights = [14, 28, 36, 18, 40, 24, 32, 16, 38, 26, 20, 34, 28, 16, 36, 22, 30, 18, 34, 24]
            for bh in heights:
                draw.rounded_rectangle([wx, cy + 98 - bh // 2, wx + 8, cy + 98 + bh // 2], radius=3, fill="#2563EB")
                wx += 18

            pill(draw, sx1 + 26, cy + 142, "|| 暂停录制 (保留状态)", "#F1F5F9", "#334155", F_XS_BOLD, 16, 8)
            pill(draw, sx1 + 215, cy + 142, "■ 结束并显式确认上传", "#2563EB", "#FFFFFF", F_XS_BOLD, 16, 8)
            cy += 210

            # Voice Rehearsal Card
            card(draw, [sx1 + 14, cy, sx2 - 14, cy + 310], fill="#FFFFFF", outline="#DDD6FE", radius=14, width=2)
            draw.text((sx1 + 26, cy + 12), "◆ 随身语音答辩演练 #04 (第 2/5 题)", fill="#6D28D9", font=F_S_BOLD)
            pill(draw, sx2 - 115, cy + 10, "● 本地TTS朗读", "#F3E8FF", "#6D28D9", F_XS_BOLD)

            card(draw, [sx1 + 24, cy + 40, sx2 - 24, cy + 108], fill="#F8FAFC", outline="#E2E8F0", radius=10)
            draw.text((sx1 + 34, cy + 48), "评委提问（基于生效标准 Standard v4 维度 #1）：", fill="#2563EB", font=F_XS_BOLD)
            draw.text((sx1 + 34, cy + 68), "“当双目视觉特征丢失时，RTK 与 IMU 的紧耦合", fill="#0F172A", font=F_XS_BOLD)
            draw.text((sx1 + 34, cy + 86), "权重是如何动态切换的？有何实测数据支撑？”", fill="#0F172A", font=F_XS_BOLD)

            draw.text((sx1 + 26, cy + 118), "■ 实时 PCM 转录核对区（提交前可手动修正专业术语）：", fill="#475569", font=F_XS_BOLD)
            card(draw, [sx1 + 24, cy + 140, sx2 - 24, cy + 232], fill="#EFF6FF", outline="#93C5FD", radius=10)
            draw.text((sx1 + 34, cy + 150), "当双目相机内点率低于 35% 阈值时，ESKF 滤波器自动", fill="#1E293B", font=F_XS)
            draw.text((sx1 + 34, cy + 170), "将视觉观测协方差放大 10 倍，切换至 RTK 载波相位与", fill="#1E293B", font=F_XS)
            draw.text((sx1 + 34, cy + 190), "200Hz IMU 预积分主导模式，实测切换耗时 < 8ms。", fill="#0F766E", font=F_XS_BOLD)

            pill(draw, sx1 + 24, cy + 248, "文字回退模式", "#F1F5F9", "#475569", F_XS_BOLD, 16, 10)
            pill(draw, sx1 + 165, cy + 248, "● 核对无误 · 提交本轮回答", "#2563EB", "#FFFFFF", F_XS_BOLD, 24, 10)

        else:
            draw.text((sx1 + 18, ay + 8), "成果验收、冲突保护与双轨隐私", fill="#0F172A", font=F_B_BOLD)
            draw.text((sx1 + 18, ay + 30), "固定版本证据核对 · 离线冲突双端保留 · AI 授权独立", fill="#64748B", font=F_XS)
            pill(draw, sx2 - 96, ay + 14, "◆ 安全守护", "#DBEAFE", "#1D4ED8", F_XS_BOLD)

            cy = ay + 66
            # Card 1: Mobile Quick Acceptance
            card(draw, [sx1 + 14, cy, sx2 - 14, cy + 175], fill="#FFFFFF", outline="#E2E8F0", radius=14)
            draw.text((sx1 + 26, cy + 12), "■ T-07 第 2 轮固定版本成果终审", fill="#0F172A", font=F_S_BOLD)
            pill(draw, sx2 - 115, cy + 10, "绑定 v12", "#DBEAFE", "#1D4ED8", F_XS_BOLD)
            draw.text((sx1 + 26, cy + 38), "提交人：陈昊  ·  AI 初审：正文达标 (待核验 2 份附件)", fill="#475569", font=F_XS)
            draw.text((sx1 + 26, cy + 58), "附件：[表] rtk_latency_30runs.xlsx  [图] wave_capture.png", fill="#2563EB", font=F_XS_BOLD)
            card(draw, [sx1 + 26, cy + 82, sx2 - 26, cy + 114], fill="#F8FAFC", outline="#CBD5E1", radius=8)
            draw.text((sx1 + 34, cy + 90), "验收理由：示波器附件与正文表 4-2 数据一致，通过。", fill="#334155", font=F_XS)
            pill(draw, sx1 + 26, cy + 124, "● 接受通过", "#0D9488", "#FFFFFF", F_XS_BOLD, 18, 7)
            pill(draw, sx1 + 155, cy + 124, "需改进", "#FEF3C7", "#B45309", F_XS_BOLD, 18, 7)
            pill(draw, sx1 + 260, cy + 124, "需重做", "#FEE2E2", "#B91C1C", F_XS_BOLD, 18, 7)
            cy += 188

            # Card 2: Offline Conflict Guard
            card(draw, [sx1 + 14, cy, sx2 - 14, cy + 156], fill="#FFFBEB", outline="#F59E0B", radius=14, width=2)
            draw.text((sx1 + 26, cy + 12), "▲ 离线编辑版本冲突核对 (禁止静默覆盖)", fill="#B45309", font=F_S_BOLD)
            draw.text((sx1 + 26, cy + 38), "本机离线草稿《第6章-商业模式》(expectedRevision=7)", fill="#334155", font=F_XS)
            draw.text((sx1 + 26, cy + 56), "与同伴刚保存的服务端最新 v8 存在 1 处表格冲突：", fill="#334155", font=F_XS)
            pill(draw, sx1 + 26, cy + 92, "◆ 左右对照双端草稿", "#FFFFFF", "#B45309", F_XS_BOLD, 16, 8)
            pill(draw, sx1 + 210, cy + 92, "● 人工合并保存为 v9", "#2563EB", "#FFFFFF", F_XS_BOLD, 16, 8)
            cy += 170

            # Card 3: Dual-Track Personal Profile Privacy
            card(draw, [sx1 + 14, cy, sx2 - 14, cy + 162], fill="#FFFFFF", outline="#E2E8F0", radius=14)
            draw.text((sx1 + 26, cy + 12), "■ 全局个人资料 · 公开展示与 AI 授权分离", fill="#0F172A", font=F_S_BOLD)
            draw.text((sx1 + 26, cy + 40), "• 允许完整登录用户名搜索我：已开启", fill="#334155", font=F_XS)
            draw.text((sx1 + 26, cy + 64), "• 专业与技能特长公开展示：公开 (可独立关闭)", fill="#0F766E", font=F_XS_BOLD)
            draw.text((sx1 + 26, cy + 88), "• AI 任务偏好推荐授权：已单独勾选授权", fill="#6D28D9", font=F_XS_BOLD)
            draw.text((sx1 + 26, cy + 114), "■ 每周可用时间 (22h/周)：仅本人可见，绝不发给 AI", fill="#B45309", font=F_XS_BOLD)

        # Bottom Navigation Bar inside Phone
        by_nav = sy2 - 62
        draw.rectangle([sx1, by_nav, sx2, sy2], fill="#FFFFFF")
        draw.line([sx1, by_nav, sx2, by_nav], fill="#E2E8F0", width=1)
        tabs = ["◎ 总览", "● 任务", "● 采集/资料", "◆ 演练/评分", "■ 我的"]
        tw = (sx2 - sx1) // 5
        active_tab = 0 if idx == 0 else (2 if idx == 1 else 4)
        for ti, t_label in enumerate(tabs):
            tx = sx1 + ti * tw + 8
            if ti == active_tab:
                pill(draw, tx, by_nav + 14, t_label, "#DBEAFE", "#1D4ED8", F_XS_BOLD, 8, 5)
            else:
                draw.text((tx + 6, by_nav + 18), t_label, fill="#64748B", font=F_XS)

    out_path = os.path.join(OUT_DIR, "mobile-native-prototype.png")
    img.save(out_path)
    print("Saved:", out_path)

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Render the native client concept illustrations (requires Pillow).")
    parser.add_argument("--output-dir", type=Path, default=OUT_DIR)
    OUT_DIR = parser.parse_args().output_dir.resolve()
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    render_desktop_winui3()
    render_mobile_suite()
