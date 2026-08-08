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
import threading
import urllib.parse
import urllib.request
import http.server
import socketserver

import webview

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
    'window': {'width': 1100, 'height': 720, 'maximized': False},
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
    return data.get('responseData', {}).get('translatedText', '')


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
# 暴露给前端的 JS API
# --------------------------------------------------------------------------
class Api:
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
                file_types=('字幕文件 (*.srt)', '所有文件 (*.*)'),
            )
        _run_on_ui(_show)
        result = holder.get('res')
        if not result:
            return None
        path = result[0] if isinstance(result, (list, tuple)) else result
        with open(path, 'r', encoding='utf-8', errors='ignore') as f:
            text = f.read()
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


if __name__ == '__main__':
    threading.Thread(target=_serve, daemon=True).start()
    api = Api()
    cfg = _load_config()
    win_w = cfg['window'].get('width') or 1100
    win_h = cfg['window'].get('height') or 720

    window = webview.create_window(
        'Subtitle-for-G - 字幕双语编辑器',
        f'http://127.0.0.1:{PORT}',
        js_api=api,
        width=win_w,
        height=win_h,
    )

    # 窗口尺寸/最大化状态持久化
    _resize_timer = None

    def _persist_size():
        c = _load_config()
        c['window']['width'] = window.width
        c['window']['height'] = window.height
        _save_config(c)

    def _on_resized():
        global _resize_timer
        if _resize_timer:
            _resize_timer.cancel()
        _resize_timer = threading.Timer(0.4, _persist_size)
        _resize_timer.start()

    def _on_closing():
        _persist_size()
        return True

    def _on_maximized():
        c = _load_config()
        c['window']['maximized'] = True
        _save_config(c)

    def _on_restored():
        c = _load_config()
        c['window']['maximized'] = False
        _save_config(c)

    window.events.resized += _on_resized
    window.events.closing += _on_closing
    # 这两个事件在部分 pywebview 后端可能不存在，逐一定制订阅以保兼容
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

    webview.start()
