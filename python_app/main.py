# python_app/main.py
# Subtitle-for-G 的 Python 桌面壳：
#   - 用 http.server 在本地托管已构建的前端 dist/
#   - 用 pywebview（底层为系统自带的 Edge WebView2）打开原生窗口加载该页面
#   - 通过 js_api 暴露 translate / open_file / save_as，翻译与文件读写都在本机完成，
#     API Key 只留在 Python 进程内存里，不外传。
#
# 出包：pip install -r requirements.txt && pyinstaller --onefile --windowed
#       --name Subtitle-for-G --add-data "python_app/dist;dist" python_app/main.py
# 产物：dist/Subtitle-for-G.exe（单文件）

import os
import sys
import json
import copy
import re
import ctypes
import threading
import urllib.parse
import urllib.request
import http.server
import socketserver

import webview


# --------------------------------------------------------------------------
# 单实例：用 Windows 命名互斥体保证同一时刻只运行一个程序。
# 互斥体句柄全程持有（不关闭），进程退出时由系统自动释放；
# 若已存在同名互斥体（另一个实例在运行），不弹窗、不启动第二个窗口，
# 而是把已存在的那个窗口恢复（若最小化）并提到最前台。
# --------------------------------------------------------------------------
_MUTEX_HANDLE = None


def ensure_single_instance():
    """返回 True 表示这是第一个实例；False 表示已有实例在运行。"""
    global _MUTEX_HANDLE
    kernel32 = ctypes.windll.kernel32
    _MUTEX_HANDLE = kernel32.CreateMutexW(None, False, 'SubtitleForG_SingleInstance')
    if not _MUTEX_HANDLE:
        return False
    if kernel32.GetLastError() == 183:  # ERROR_ALREADY_EXISTS
        _MUTEX_HANDLE = None
        return False
    return True


def _activate_existing_window():
    """已有实例在运行时：把那个已存在的窗口恢复（若最小化）并提到最前台，
    而不是弹窗。找不到（极小概率的启动竞态）就静默退出。"""
    user32 = ctypes.windll.user32
    kernel32 = ctypes.windll.kernel32

    SW_RESTORE = 9
    HWND_TOPMOST = -1
    HWND_NOTOPMOST = -2
    SWP_NOMOVE = 0x0001
    SWP_NOSIZE = 0x0002
    PREFIX = 'Subtitle-for-G'

    # 设置必要参数类型，避免 64 位下 HWND 被当作 32 位 int 截断
    user32.EnumWindows.argtypes = [
        ctypes.WINFUNCTYPE(ctypes.c_bool, ctypes.c_void_p, ctypes.c_void_p),
        ctypes.c_void_p,
    ]
    user32.EnumWindows.restype = ctypes.c_bool
    user32.GetWindowTextLengthW.argtypes = [ctypes.c_void_p]
    user32.GetWindowTextLengthW.restype = ctypes.c_int
    user32.GetWindowTextW.argtypes = [ctypes.c_void_p, ctypes.c_wchar_p, ctypes.c_int]
    user32.IsWindowVisible.argtypes = [ctypes.c_void_p]
    user32.IsWindowVisible.restype = ctypes.c_bool
    user32.ShowWindow.argtypes = [ctypes.c_void_p, ctypes.c_int]
    user32.SetForegroundWindow.argtypes = [ctypes.c_void_p]
    user32.SetWindowPos.argtypes = [
        ctypes.c_void_p, ctypes.c_void_p, ctypes.c_int,
        ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_uint,
    ]
    user32.GetWindowThreadProcessId.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
    user32.GetWindowThreadProcessId.restype = ctypes.c_ulong
    user32.AttachThreadInput.argtypes = [ctypes.c_ulong, ctypes.c_ulong, ctypes.c_bool]

    found = [None]

    @ctypes.WINFUNCTYPE(ctypes.c_bool, ctypes.c_void_p, ctypes.c_void_p)
    def enum_cb(hwnd, lparam):
        if not user32.IsWindowVisible(hwnd):
            return True
        length = user32.GetWindowTextLengthW(hwnd)
        if length <= 0:
            return True
        buf = ctypes.create_unicode_buffer(length + 1)
        user32.GetWindowTextW(hwnd, buf, length + 1)
        title = buf.value or ''
        if title.startswith(PREFIX):
            found[0] = hwnd
            return False  # 找到第一个匹配即停止枚举
        return True

    # 窗口可能尚未创建（极小概率的双开竞态），最多重试 5 秒
    for _ in range(50):
        found[0] = None
        user32.EnumWindows(enum_cb, 0)
        if found[0]:
            break
        kernel32.Sleep(100)
    hwnd = found[0]
    if not hwnd:
        return False

    # 1) 若被最小化，先还原为正常/最大化窗口
    user32.ShowWindow(hwnd, SW_RESTORE)
    # 2) 用 AttachThreadInput 临时把本线程挂到目标窗口线程，绕过前台锁，
    #    再把窗口提到最前；失败（返回 0）也不影响后续尝试
    cur_thread = kernel32.GetCurrentThreadId()
    target_thread = user32.GetWindowThreadProcessId(hwnd, None)
    try:
        user32.AttachThreadInput(cur_thread, target_thread, True)
    except Exception:
        pass
    user32.SetForegroundWindow(hwnd)
    # 3) topmost 乒乓：先置顶再取消置顶，进一步确保窗口可见且不被遮挡
    user32.SetWindowPos(hwnd, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE)
    user32.SetWindowPos(hwnd, HWND_NOTOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE)
    try:
        user32.AttachThreadInput(cur_thread, target_thread, False)
    except Exception:
        pass
    return True

try:
    from _version import VERSION
except ImportError:
    VERSION = '0.0.0.0'

HERE = os.path.dirname(os.path.abspath(__file__))
# PyInstaller 打包后资源在 sys._MEIPASS 下；开发期用仓库内的 dist
BASE = sys._MEIPASS if getattr(sys, 'frozen', False) else HERE
DIST = os.path.join(BASE, 'dist')
PORT = 8011

# --------------------------------------------------------------------------
# 程序配置文件（记录窗口大小、表格间距、文件打开位置、翻译引擎等）
# 优先放在 exe 同级目录，若不可写则回退到 %APPDATA%/SubtitleForG
# --------------------------------------------------------------------------
DEFAULT_CONFIG = {
    'window': {'width': 1100, 'height': 720, 'x': None, 'y': None, 'maximized': False},
    'table': {'cell_padding': 4},
    'last_dir': '',
    'provider': 'mymemory',
}


def _config_path():
    if getattr(sys, 'frozen', False):
        cand = os.path.join(os.path.dirname(sys.executable), 'config.json')
    else:
        cand = os.path.join(HERE, 'config.json')
    d = os.path.dirname(cand)
    try:
        if not os.path.isdir(d):
            os.makedirs(d, exist_ok=True)
        tmp = os.path.join(d, '.writetest_subtitleforg')
        with open(tmp, 'w') as f:
            f.write('')
        os.remove(tmp)
        return cand
    except Exception:
        app = os.path.join(os.environ.get('APPDATA', os.path.expanduser('~')), 'SubtitleForG')
        os.makedirs(app, exist_ok=True)
        return os.path.join(app, 'config.json')


def _load_config():
    cfg = copy.deepcopy(DEFAULT_CONFIG)
    try:
        with open(_config_path(), 'r', encoding='utf-8') as f:
            data = json.load(f)
        for k, v in data.items():
            if isinstance(v, dict) and isinstance(cfg.get(k), dict):
                cfg[k].update(v)
            else:
                cfg[k] = v
    except Exception:
        pass
    return cfg


def _save_config(cfg):
    try:
        with open(_config_path(), 'w', encoding='utf-8') as f:
            json.dump(cfg, f, ensure_ascii=False, indent=2)
    except Exception:
        pass


# --------------------------------------------------------------------------
# 本地静态服务器（托管 dist/，使前端 ES Module 可正常加载，避免 file:// 的 CORS）
# --------------------------------------------------------------------------
class _Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=DIST, **kwargs)

    def log_message(self, fmt, *args):  # 静默
        pass


def _serve():
    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.TCPServer(("127.0.0.1", PORT), _Handler) as httpd:
        httpd.serve_forever()


# --------------------------------------------------------------------------
# 翻译后端（纯标准库，无第三方依赖）
# --------------------------------------------------------------------------
def _mymemory(text, source, target):
    q = urllib.parse.urlencode({'q': text, 'langpair': f'{source}|{target}'})
    url = 'https://api.mymemory.translated.net/get?' + q
    with urllib.request.urlopen(url, timeout=20) as r:
        data = json.loads(r.read().decode('utf-8'))
    rd = data.get('responseData')
    if isinstance(rd, dict):
        txt = rd.get('translatedText', '') or ''
        # MyMemory 超配额 / 出错时，会把错误文本塞进 translatedText（形如 "MYMEMORY WARNING: ..."），
        # 此时应作为异常抛出，让前端明确提示，而不是静默返回空（表现为「翻译不出来」）。
        if txt and 'MYMEMORY' in txt.upper() and 'WARNING' in txt.upper():
            raise RuntimeError(txt)
        return txt
    if isinstance(rd, str):
        return rd
    # 错误有时放在 responseMessage / responseDetails
    msg = data.get('responseMessage') or data.get('responseDetails') or ''
    if msg and msg.strip().upper() not in ('OK', ''):
        raise RuntimeError(msg)
    raise RuntimeError('MyMemory 未返回译文（可能已超每日免费额度）')


def _openai(lines, api_key, model, source, target):
    url = 'https://api.openai.com/v1/chat/completions'
    model = model or 'gpt-4o-mini'
    out = []
    for line in lines:
        body = {
            'model': model,
            'messages': [
                {'role': 'system', 'content':
                    f'You are a subtitle translator. Translate the user text from {source} to {target}. Output only the translation, no explanations.'},
                {'role': 'user', 'content': line},
            ],
            'temperature': 0.3,
        }
        req = urllib.request.Request(
            url,
            data=json.dumps(body).encode('utf-8'),
            headers={'Content-Type': 'application/json',
                     'Authorization': f'Bearer {api_key}'},
            method='POST',
        )
        with urllib.request.urlopen(req, timeout=30) as r:
            data = json.loads(r.read().decode('utf-8'))
        out.append(data['choices'][0]['message']['content'].strip())
    return out


def _deepl(lines, api_key, model, source, target):
    url = 'https://api-free.deepl.com/v2/translate'
    tgt = 'ZH' if target.lower().startswith('zh') else target.upper()
    out = []
    for line in lines:
        body = {'text': [line], 'target_lang': tgt}
        if source:
            body['source_lang'] = source.upper()
        req = urllib.request.Request(
            url,
            data=json.dumps(body).encode('utf-8'),
            headers={'Content-Type': 'application/json',
                     'Authorization': f'DeepL-Auth-Key {api_key}'},
            method='POST',
        )
        with urllib.request.urlopen(req, timeout=30) as r:
            data = json.loads(r.read().decode('utf-8'))
        out.append(data['translations'][0]['text'])
    return out


# --------------------------------------------------------------------------
# 在 WinForms UI 线程上执行（解决 js_api 后台线程调用原生对话框的跨线程崩溃）
# --------------------------------------------------------------------------
def _run_on_ui(fn):
    """
    js_api 方法运行在后台线程（见 webview/util.py 的 js_bridge_call），
    而 create_file_dialog 内部 dialog.ShowDialog(form) 必须在 UI 线程调用，
    否则 WinForms 抛“跨线程操作无效”异常并吞掉对话框。这里借助主窗口 Form
    的 Invoke 把对话框派发到 UI 线程执行，再同步取回结果。
    """
    try:
        from System.Windows.Forms import Application
        from System import Action

        form = Application.OpenForms[0]
        form.Invoke(Action(fn))
    except Exception:
        # 兜底：极少数环境拿不到主线程 Form 时退化直调（可能失败，但保证不崩）
        fn()


# --------------------------------------------------------------------------
# 纯标准库解析 Word 文档（.docx），智能识别时间码并分组文本
# --------------------------------------------------------------------------
def _srt_to_ms(tc):
    m = re.match(r'^(\d{1,2}):(\d{2}):(\d{2}),(\d{3})$', tc)
    if not m:
        return 0
    h, mm, s, ms = (int(m.group(i)) for i in range(1, 5))
    return ((h * 60 + mm) * 60 + s) * 1000 + ms


def _mmss_to_ms(tc):
    """把 MM:SS（纪录片片段标记，如 00:46 / 02:35）转换为毫秒。"""
    m = re.match(r'^\s*(\d{1,2}):(\d{2})\s*$', tc)
    if not m:
        return 0
    mm, ss = int(m.group(1)), int(m.group(2))
    return (mm * 60 + ss) * 1000


# 署名行：全大写人名（允许重音大写 À-Ý、空格、撇号、间隔号 ·、连字符）+ 逗号或句号 + 职务。
# 例：CONCEPCIÓ PEIG, Researcher in Architectural… / MANUEL ARENAS. Architect
# 用于纪录片脚本 docx：每个片段末尾那行「人物名 + 职务」不是台词，应剔除。
_CREDIT_RE = re.compile(
    r'^[A-Z\u00c0-\u00dd][A-Z\u00c0-\u00dd \'\u00b7-]* '
    r'[A-Z\u00c0-\u00dd \'\u00b7-]*[.,]\s+[A-Za-z]'
)


def _is_credit_line(line):
    s = (line or '').strip()
    if not s or len(s) > 90:
        return False
    return bool(_CREDIT_RE.match(s))


# 导入归一化：把「非中文文本」里的中文全角标点转成英文 ASCII 标点。
# 中文（含 CJK 表意文字）文本不处理，保留原本的中文标点，避免破坏原文。
_CN_PUNCT = {
    '\uFF0C': ',',   # ，
    '\u3002': '.',   # 。
    '\u3001': ',',   # 、
    '\uFF1B': ';',   # ；
    '\uFF1A': ':',   # ：
    '\uFF1F': '?',   # ？
    '\uFF01': '!',   # ！
    '\uFF08': '(',   # （
    '\uFF09': ')',   # ）
    '\u201C': '"',   # “
    '\u201D': '"',   # ”
    '\u2018': "'",   # ‘
    '\u2019': "'",   # ’
    '\u300C': '"',   # 「
    '\u300D': '"',   # 」
    '\u300E': '"',   # 『
    '\u300F': '"',   # 』
    '\u3010': '[',   # 【
    '\u3011': ']',   # 】
    '\u300A': '"',   # 《
    '\u300B': '"',   # 》
    '\uFF5E': '~',   # ～
    '\u3000': ' ',   # 　 全角空格
}


def _looks_chinese(text):
    # 仅识别 CJK 表意文字（不含全角标点），避免把含全角标点的纯英文误判为中文
    return bool(re.search(r'[\u3400-\u9fff]', text or ''))


def _normalize_cjk_punct(text):
    if not text:
        return text
    out = re.sub(r'\u2026+', '...', text)  # 省略号（……）折叠为一个 ...
    for k, v in _CN_PUNCT.items():
        if k in out:
            out = out.replace(k, v)
    return out


# 中文文本里要「去除」的标点字符集（显式列出，避免误伤富文本标签 < > / 等）。
# 保留：双引号 “” (U+201C/U+201D) 与书名号 《》 (U+300A/U+300B)；以及标签字符 < > / 。
# 即：删除中文文本里的【一切标点】（中文全角标点 + ASCII 标点），只留 “” 《》 与标签字符。
# 刻意排除 300A/300B(《》)、201C/201D(“”)、空格 3000，以及所有字母/数字/CJK 表意/emoji/标签字符。
_CN_STRIP_RE = re.compile(
    "[\uFF01-\uFF0F\uFF1A-\uFF20\uFF3B-\uFF40\uFF5B-\uFF65"
    "\u3001\u3002\u3008\u3009\u300C-\u301B\u301C\u301D-\u301F\u3030"
    "\u2013-\u2015\u2018\u2019\u201B\u2025\u2026\u00B7"
    "!\x22#$%&'()*+,.:;=?@^_{|}~-]"
)


def _collapse_spaces(text):
    # 合并连续空白为单个 ASCII 空格：ASCII 空格、全角空格(　)、制表符。
    if not text:
        return text
    return re.sub(r'[ 　\t]+', ' ', text)


def _strip_chinese_punct(text):
    if not text:
        return text
    return _CN_STRIP_RE.sub('', text)


def _normalize_docx_items(items):
    for it in items:
        for key in ('source', 'target'):
            val = it.get(key) or ''
            if not val:
                continue
            # 1) 合并连续空格为单个（所有文本）
            val = _collapse_spaces(val)
            # 2) 中文文本：去除中文标点（保留 “” 《》）；非中文：全角标点转 ASCII
            if _looks_chinese(val):
                val = _strip_chinese_punct(val)
            else:
                val = _normalize_cjk_punct(val)
            # 3) 去除标点后可能留下多余空格，再合并一次并收尾 trim
            val = _collapse_spaces(val).strip()
            it[key] = val
    return items


def _parse_docx(path):
    """解析 .docx：提取段落文本，识别时间码行（H:MM:SS:FF / H:MM:SS,mmm 等），
    把相邻时间码之间的文本聚合成一条字幕；无时间码则按非空段落逐行导入。
    返回 [{index,start,end,source,target}]，时间码为 SRT 格式 HH:MM:SS,mmm。
    """
    import zipfile
    import re
    from xml.etree import ElementTree as ET

    W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
    with zipfile.ZipFile(path) as z:
        xml = z.read('word/document.xml').decode('utf-8')
    root = ET.fromstring(xml)
    body = root.find(f'{{{W}}}body')
    if body is None:
        body = root
    paras = []
    for p in body.iter(f'{{{W}}}p'):
        texts = [t.text or '' for t in p.iter(f'{{{W}}}t')]
        paras.append(''.join(texts))

    # 时间码：H:MM:SS:FF（最后一节 2 位=帧，3 位=毫秒），分隔符允许 :., 
    tc_re = re.compile(r'^\s*(\d{1,2})[:.,](\d{2})[:.,](\d{2})[:.,](\d{1,3})\s*$')
    # 片段标记：MM:SS（纪录片脚本常见，如 00:46 / 02:35），仅 2 节、分隔符为冒号
    mmss_re = re.compile(r'^\s*(\d{1,2}):(\d{2})\s*$')

    tc_idx = []
    max_frame = 0
    for idx, p in enumerate(paras):
        m = tc_re.match(p.strip())
        if m:
            tc_idx.append(idx)
            if len(m.group(4)) == 2:  # 帧（2 位）
                max_frame = max(max_frame, int(m.group(4)))

    mmss_idx = [idx for idx, p in enumerate(paras) if mmss_re.match(p.strip())]

    # 帧率推断：出现 >=25 的帧值 → 30fps，否则 25fps（PAL 常见）
    fps = 30 if max_frame >= 25 else 25

    def tc_to_srt(tc):
        m = tc_re.match(tc.strip())
        h, mm, s, last = m.group(1), m.group(2), m.group(3), m.group(4)
        if len(last) == 3:
            ms = int(last)
        else:
            ms = int(round(int(last) / fps * 1000))
        return f'{int(h):02d}:{int(mm):02d}:{int(s):02d},{ms:03d}'

    def ms_to_time(ms):
        total = max(0, int(ms))
        h = total // 3600000
        m = (total % 3600000) // 60000
        s = (total % 60000) // 1000
        return f'{h:02d}:{m:02d}:{s:02d},{total % 1000:03d}'

    items = []
    if tc_idx:
        # 有时间码（SRT 风格）：相邻时间码之间（跳过空行）的文本聚合为一条；
        # 若该时间码之后没有文本（仅作上一条的结束标记），则不单独成条。
        for k in range(len(tc_idx)):
            start_pos = tc_idx[k]
            end_pos = tc_idx[k + 1] if k + 1 < len(tc_idx) else len(paras)
            text_lines = [paras[j] for j in range(start_pos + 1, end_pos) if paras[j].strip()]
            if not text_lines:
                continue
            text = '\n'.join(text_lines)
            start_srt = tc_to_srt(paras[start_pos])
            if k + 1 < len(tc_idx):
                end_srt = tc_to_srt(paras[tc_idx[k + 1]])
            else:
                end_srt = ms_to_time(_srt_to_ms(start_srt) + 3000)
            items.append({
                'index': 0,
                'start': start_srt,
                'end': end_srt,
                'source': text,
                'target': '',
            })
        return _normalize_docx_items(items)

    if mmss_idx and len(mmss_idx) >= 2:
        # 仅带 MM:SS 片段标记（纪录片脚本常见，如 00:46 / 02:35）：
        # 把相邻两个标记之间的所有段落合并为一条字幕；标记作为开始时间，
        # 下一个标记作为结束时间；仅作结束标记、其后无文本的不单独成条；
        # 最后一个片段给默认 30 秒时长。标记倒序（结束早于开始）时同样兜底 30 秒。
        for k in range(len(mmss_idx)):
            start_pos = mmss_idx[k]
            end_pos = mmss_idx[k + 1] if k + 1 < len(mmss_idx) else len(paras)
            # 剔除片段末尾的「人物名 + 职务」署名行，只保留对白/旁白正文
            text_lines = [paras[j] for j in range(start_pos + 1, end_pos)
                          if paras[j].strip() and not _is_credit_line(paras[j])]
            if not text_lines:
                continue
            text = '\n'.join(text_lines)
            start_ms = _mmss_to_ms(paras[start_pos])
            if k + 1 < len(mmss_idx):
                end_ms = _mmss_to_ms(paras[mmss_idx[k + 1]])
                if end_ms <= start_ms:
                    end_ms = start_ms + 30000
            else:
                end_ms = start_ms + 30000
            items.append({
                'index': 0,
                'start': ms_to_time(start_ms),
                'end': ms_to_time(end_ms),
                'source': text,
                'target': '',
            })
        return _normalize_docx_items(items)

    # 双语交错：段落严格中英交替（CN|EN 两列表格按行铺平，呈 CLCLCL…），
    # 既无 SRT 时间码也无 MM:SS 片段标记。把每个「中文段 + 紧随的英文段」配对为
    # 一条双语字幕（中文 source、英文 target）；顺序给占位时码（每条 3 秒）。
    # 注意：只认 CJK 表意文字（汉字），不要把全角标点(？、，等)算作"中文"，
    # 否则英文句末带中文标点的行会被误判为中文，破坏中英交替模式导致双语判定失败。
    _cjk_re = re.compile(r'[\u3400-\u9fff]')

    def _is_cjk(s):
        return bool(_cjk_re.search(s))

    neat = [(i, p) for i, p in enumerate(paras) if p.strip() and not _is_credit_line(p)]
    if neat:
        c_cnt = sum(1 for _, p in neat if _is_cjk(p))
        l_cnt = len(neat) - c_cnt
        flags = ''.join('C' if _is_cjk(p) else 'L' for _, p in neat)
        transitions = sum(1 for i in range(1, len(flags)) if flags[i] != flags[i - 1])
        # 同时含中英、严格交替（相邻几乎都不同语言）、且首段为中文 → 判定为双语交错
        if c_cnt > 0 and l_cnt > 0 and transitions >= len(flags) - 2 and flags[0] == 'C':
            gap = 3000
            n = 0
            pending_cjk = None
            for _, p in neat:
                if _is_cjk(p):
                    if pending_cjk is not None:
                        # 异常：上一个中文没跟到英文，先单独成条
                        items.append({
                            'index': 0,
                            'start': ms_to_time(n * gap),
                            'end': ms_to_time((n + 1) * gap),
                            'source': pending_cjk,
                            'target': '',
                        })
                        n += 1
                    pending_cjk = p
                else:
                    if pending_cjk is not None:
                        items.append({
                            'index': 0,
                            'start': ms_to_time(n * gap),
                            'end': ms_to_time((n + 1) * gap),
                            'source': pending_cjk,
                            'target': p,
                        })
                        n += 1
                        pending_cjk = None
                    else:
                        items.append({
                            'index': 0,
                            'start': ms_to_time(n * gap),
                            'end': ms_to_time((n + 1) * gap),
                            'source': '',
                            'target': p,
                        })
                        n += 1
            if pending_cjk is not None:
                items.append({
                    'index': 0,
                    'start': ms_to_time(n * gap),
                    'end': ms_to_time((n + 1) * gap),
                    'source': pending_cjk,
                    'target': '',
                })
                n += 1
            return _normalize_docx_items(items)

    # 无时间码：每个非空段落作为一条原文，顺序给占位时码（每行 3 秒）；
    # 顺带剔除「人物名 + 职务」署名行
    gap = 3000
    n = 0
    for p in paras:
        if not p.strip() or _is_credit_line(p):
            continue
        items.append({
            'index': 0,
            'start': ms_to_time(n * gap),
            'end': ms_to_time((n + 1) * gap),
            'source': p,
            'target': '',
        })
        n += 1
    return _normalize_docx_items(items)


# --------------------------------------------------------------------------
# 文本读取：按 BOM / 编码自动解码
# --------------------------------------------------------------------------
def _read_text_auto(path):
    """读取文本文件并按编码自动解码，避免 EDIUS 等以 UTF-16 保存的字幕被
    utf-8 误读成乱码。优先级：UTF-16(BOM) > UTF-8-SIG(BOM) > UTF-8 > GB18030。"""
    with open(path, 'rb') as f:
        raw = f.read()
    if raw[:2] in (b'\xff\xfe', b'\xfe\xff'):
        return raw.decode('utf-16', errors='ignore')
    if raw[:3] == b'\xef\xbb\xbf':
        return raw.decode('utf-8-sig', errors='ignore')
    try:
        return raw.decode('utf-8')
    except UnicodeDecodeError:
        return raw.decode('gb18030', errors='ignore')


# --------------------------------------------------------------------------
# 暴露给前端的 JS API
# --------------------------------------------------------------------------
class Api:
    def __init__(self):
        # 工程缓冲：前端在导入 / 编辑 / 保存后把当前工程内容推过来，
        # 供「关闭时询问是否保存」使用。
        self._project_path = None
        self._project_xml = ''
        self._project_dirty = False

    def get_version(self):
        return VERSION

    def get_config(self):
        return _load_config()

    def save_config(self, patch):
        cfg = _load_config()
        for k, v in (patch or {}).items():
            if isinstance(v, dict) and isinstance(cfg.get(k), dict):
                cfg[k].update(v)
            else:
                cfg[k] = v
        _save_config(cfg)
        return cfg

    def translate(self, payload):
        lines = payload.get('lines', []) or []
        provider = (payload.get('provider') or 'mymemory').lower()
        api_key = payload.get('api_key') or ''
        model = payload.get('model') or ''
        source = payload.get('source') or 'en'
        target = payload.get('target') or 'zh-CN'
        try:
            if provider == 'mymemory':
                return [_mymemory(l, source, target) for l in lines]
            if provider == 'openai':
                return _openai(lines, api_key, model, source, target)
            if provider == 'deepl':
                return _deepl(lines, api_key, model, source, target)
            return list(lines)
        except Exception as e:  # 前端会检测 {error: ...}
            return {'error': str(e)}

    def open_file(self):
        win = webview.windows[0]
        init_dir = _load_config().get('last_dir') or ''
        holder = {}
        def _show():
            holder['res'] = win.create_file_dialog(
                webview.OPEN_DIALOG,
                directory=init_dir,
                allow_multiple=False,
                file_types=('字幕文件 (*.srt;*.ass;*.vtt;*.txt)', '所有文件 (*.*)'),
            )
        _run_on_ui(_show)
        result = holder.get('res')
        if not result:
            return None
        path = result[0] if isinstance(result, (list, tuple)) else result
        text = _read_text_auto(path)
        # 记录本次打开所在目录，下次打开/另存默认定位到这里
        cfg = _load_config()
        cfg['last_dir'] = os.path.dirname(path)
        _save_config(cfg)
        return {'path': path, 'text': text}

    def save_as(self, default_name, contents):
        win = webview.windows[0]
        init_dir = _load_config().get('last_dir') or ''
        holder = {}
        def _show():
            holder['res'] = win.create_file_dialog(
                webview.SAVE_DIALOG,
                directory=init_dir,
                save_filename=default_name,
                file_types=('SubRip 字幕 (*.srt)', '所有文件 (*.*)'),
            )
        _run_on_ui(_show)
        result = holder.get('res')
        if not result:
            return None
        path = result[0] if isinstance(result, (list, tuple)) else result
        with open(path, 'w', encoding='utf-8') as f:
            f.write(contents)
        cfg = _load_config()
        cfg['last_dir'] = os.path.dirname(path)
        _save_config(cfg)
        return path

    def save_export(self, default_name, contents):
        win = webview.windows[0]
        init_dir = _load_config().get('last_dir') or ''
        holder = {}
        ext = os.path.splitext(default_name)[1].lower() or '.txt'
        if ext == '.srt':
            label = 'SubRip 字幕 (*.srt)'
        elif ext in ('.vtt',):
            label = 'WebVTT 字幕 (*.vtt)'
        elif ext in ('.txt',):
            label = '纯文本 (*.txt)'
        else:
            label = '所有文件 (*.*)'
        def _show():
            holder['res'] = win.create_file_dialog(
                webview.SAVE_DIALOG,
                directory=init_dir,
                save_filename=default_name,
                file_types=(label, '所有文件 (*.*)'),
            )
        _run_on_ui(_show)
        result = holder.get('res')
        if not result:
            return None
        path = result[0] if isinstance(result, (list, tuple)) else result
        # 若用户未手动改扩展名，确保落盘文件带正确后缀
        if not path.lower().endswith(ext):
            path += ext
        with open(path, 'w', encoding='utf-8') as f:
            f.write(contents)
        cfg = _load_config()
        cfg['last_dir'] = os.path.dirname(path)
        _save_config(cfg)
        return path

    def import_text(self):
        """导入纯文本文件：仅返回文本内容，由前端把每一行当成一条原文。"""
        win = webview.windows[0]
        init_dir = _load_config().get('last_dir') or ''
        holder = {}
        def _show():
            holder['res'] = win.create_file_dialog(
                webview.OPEN_DIALOG,
                directory=init_dir,
                allow_multiple=False,
                file_types=('纯文本 (*.txt)', '所有文件 (*.*)'),
            )
        _run_on_ui(_show)
        result = holder.get('res')
        if not result:
            return None
        path = result[0] if isinstance(result, (list, tuple)) else result
        text = _read_text_auto(path)
        cfg = _load_config()
        cfg['last_dir'] = os.path.dirname(path)
        _save_config(cfg)
        return {'path': path, 'text': text}

    def import_docx(self):
        """智能导入其他文档（.docx）：自动识别时间码行并分组文本。
        纯标准库解析（zipfile + xml），无需第三方依赖。
        返回 {path, items:[{index,start,end,source,target}]}，时间码为 SRT 格式。
        """
        win = webview.windows[0]
        init_dir = _load_config().get('last_dir') or ''
        holder = {}
        def _show():
            holder['res'] = win.create_file_dialog(
                webview.OPEN_DIALOG,
                directory=init_dir,
                allow_multiple=False,
                file_types=('文档 (*.docx)', '所有文件 (*.*)'),
            )
        _run_on_ui(_show)
        result = holder.get('res')
        if not result:
            return None
        path = result[0] if isinstance(result, (list, tuple)) else result
        try:
            items = _parse_docx(path)
        except Exception as e:
            return {'path': path, 'error': str(e), 'items': []}
        cfg = _load_config()
        cfg['last_dir'] = os.path.dirname(path)
        _save_config(cfg)
        return {'path': path, 'items': items}

    def open_project(self):
        win = webview.windows[0]
        init_dir = _load_config().get('last_dir') or ''
        holder = {}

        def _show():
            holder['res'] = win.create_file_dialog(
                webview.OPEN_DIALOG,
                directory=init_dir,
                allow_multiple=False,
                file_types=('字幕项目 (*.gsub)', '所有文件 (*.*)'),
            )

        _run_on_ui(_show)
        result = holder.get('res')
        if not result:
            return None
        path = result[0] if isinstance(result, (list, tuple)) else result
        with open(path, 'r', encoding='utf-8', errors='ignore') as f:
            text = f.read()
        cfg = _load_config()
        cfg['last_dir'] = os.path.dirname(path)
        _save_config(cfg)
        return {'path': path, 'text': text}

    def save_project(self, default_name, contents):
        win = webview.windows[0]
        init_dir = _load_config().get('last_dir') or ''
        holder = {}

        def _show():
            holder['res'] = win.create_file_dialog(
                webview.SAVE_DIALOG,
                directory=init_dir,
                save_filename=default_name,
                file_types=('字幕项目 (*.gsub)', '所有文件 (*.*)'),
            )

        _run_on_ui(_show)
        result = holder.get('res')
        if not result:
            return None
        path = result[0] if isinstance(result, (list, tuple)) else result
        with open(path, 'w', encoding='utf-8') as f:
            f.write(contents)
        cfg = _load_config()
        cfg['last_dir'] = os.path.dirname(path)
        _save_config(cfg)
        return path

    def save_project_to_path(self, path, contents):
        # 直接覆盖已存在的工程文件（不弹对话框）。由前端「保存项目」按钮在
        # currentProjectPath 已知（已打开过 .gsub）时调用，实现快速保存。
        if not path:
            return None
        with open(path, 'w', encoding='utf-8') as f:
            f.write(contents)
        cfg = _load_config()
        cfg['last_dir'] = os.path.dirname(path)
        _save_config(cfg)
        return path

    def set_project_buffer(self, path, contents, dirty):
        # 前端在导入 / 编辑 / 保存后把当前工程内容推过来，供「关闭时询问是否保存」使用。
        self._project_path = path or None
        self._project_xml = contents or ''
        self._project_dirty = bool(dirty)

    def _save_current_project(self):
        # 在 FormClosing（UI 线程）内调用，直接把当前工程缓冲写盘。
        # 已知路径则覆盖保存；否则弹出「另存为」对话框。
        # 返回 True 表示已保存 / 无需保存；返回 False 表示用户取消了保存（调用方应取消关闭）。
        win = webview.windows[0]
        xml = self._project_xml or ''
        if not xml:
            return True
        if self._project_path:
            self.save_project_to_path(self._project_path, xml)
            return True
        # 没有已知路径：弹出另存为对话框（当前线程即 UI 线程，ShowDialog 安全）
        init_dir = _load_config().get('last_dir') or ''
        res = win.create_file_dialog(
            webview.SAVE_DIALOG,
            directory=init_dir,
            save_filename='未命名项目.gsub',
            file_types=('字幕项目 (*.gsub)', '所有文件 (*.*)'),
        )
        if not res:
            return False
        path = res[0] if isinstance(res, (list, tuple)) else res
        with open(path, 'w', encoding='utf-8') as f:
            f.write(xml)
        cfg = _load_config()
        cfg['last_dir'] = os.path.dirname(path)
        _save_config(cfg)
        self._project_path = path
        return True


if __name__ == '__main__':
    # 单实例：已有实例在运行时，把已存在的窗口恢复并提到前台，不启动第二个窗口
    if not ensure_single_instance():
        _activate_existing_window()
        sys.exit(0)

    threading.Thread(target=_serve, daemon=True).start()
    api = Api()
    cfg = _load_config()
    win_w = cfg['window'].get('width') or 1100
    win_h = cfg['window'].get('height') or 720
    win_x = cfg['window'].get('x')
    win_y = cfg['window'].get('y')

    create_kwargs = {
        'js_api': api,
        'width': win_w,
        'height': win_h,
    }
    # 仅当同时记录了有效的 x、y 时才还原窗口位置（否则由系统居中放置）
    if isinstance(win_x, (int, float)) and isinstance(win_y, (int, float)):
        create_kwargs['x'] = int(win_x)
        create_kwargs['y'] = int(win_y)

    window = webview.create_window(
        f'Subtitle-for-G {VERSION} - 字幕双语编辑器',
        f'http://127.0.0.1:{PORT}',
        **create_kwargs,
    )

    # 窗口位置/尺寸/最大化状态持久化
    _maximized = {'v': bool(cfg['window'].get('maximized'))}
    _resize_timer = None

    def _persist_geometry():
        c = _load_config()
        # 最大化时只保留 maximized 标记，不覆盖记录的常规位置/大小，
        # 这样下次启动还原到最大化窗口、但不把记录尺寸撑成整屏。
        if not _maximized['v']:
            try:
                c['window']['x'] = int(window.x)
                c['window']['y'] = int(window.y)
                c['window']['width'] = int(window.width)
                c['window']['height'] = int(window.height)
            except Exception:
                pass
        _save_config(c)

    def _on_resized():
        global _resize_timer
        if _resize_timer:
            _resize_timer.cancel()
        _resize_timer = threading.Timer(0.4, _persist_geometry)
        _resize_timer.start()

    def _on_moved():
        _persist_geometry()

    def _on_closing():
        _persist_geometry()
        return True

    def _on_maximized():
        _maximized['v'] = True
        c = _load_config()
        c['window']['maximized'] = True
        _save_config(c)

    def _on_restored():
        _maximized['v'] = False
        c = _load_config()
        c['window']['maximized'] = False
        _save_config(c)

    window.events.resized += _on_resized
    window.events.closing += _on_closing
    # 这些事件在部分 pywebview 后端可能不存在，逐一定制订阅以保兼容
    try:
        window.events.moved += _on_moved
    except Exception:
        pass
    try:
        window.events.maximized += _on_maximized
    except Exception:
        pass
    try:
        window.events.restored += _on_restored
    except Exception:
        pass

    if cfg['window'].get('maximized'):
        window.events.loaded += lambda: window.maximize()

    def _install_close_guard():
        # 在真实 WinForms 窗体上挂 FormClosing：edgechromium(WebView2) 后端并未订阅
        # window.events.closing，必须直接挂 FormClosing 才能拦截关闭。窗体在
        # webview.start() 内才创建，故用后台线程轮询至窗体就绪再挂。
        def _poll():
            try:
                from System.Windows.Forms import (
                    Application, MessageBox, MessageBoxButtons, MessageBoxIcon, DialogResult,
                )
            except Exception:
                return
            try:
                while Application.OpenForms.Count == 0:
                    threading.Event().wait(0.2)
                form = Application.OpenForms[0]

                def _handler(sender, args):
                    _persist_geometry()
                    if not api._project_dirty:
                        return
                    try:
                        res = MessageBox.Show(
                            '字幕尚未保存，是否将当前内容保存为项目？',
                            '保存项目',
                            MessageBoxButtons.YesNoCancel,
                            MessageBoxIcon.Question,
                        )
                    except Exception:
                        return
                    if res == DialogResult.Yes:
                        if not api._save_current_project():
                            args.Cancel = True
                    elif res == DialogResult.Cancel:
                        args.Cancel = True
                    # DialogResult.No → 直接关闭，不保存

                form.FormClosing += _handler
            except Exception:
                pass

        threading.Thread(target=_poll, daemon=True).start()

    _install_close_guard()

    webview.start()
