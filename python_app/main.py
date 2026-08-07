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
# 暴露给前端的 JS API
# --------------------------------------------------------------------------
class Api:
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
        result = win.create_file_dialog(
            webview.OPEN_DIALOG,
            allow_multiple=False,
            file_types=(('字幕文件', '*.srt'), ('所有文件', '*.*')),
        )
        if not result:
            return None
        path = result[0] if isinstance(result, (list, tuple)) else result
        with open(path, 'r', encoding='utf-8', errors='ignore') as f:
            text = f.read()
        return {'path': path, 'text': text}

    def save_as(self, default_name, contents):
        win = webview.windows[0]
        result = win.create_file_dialog(
            webview.SAVE_DIALOG,
            save_filename=default_name,
            file_types=(('SubRip 字幕', '*.srt'), ('所有文件', '*.*')),
        )
        if not result:
            return None
        path = result[0] if isinstance(result, (list, tuple)) else result
        with open(path, 'w', encoding='utf-8') as f:
            f.write(contents)
        return path


if __name__ == '__main__':
    threading.Thread(target=_serve, daemon=True).start()
    api = Api()
    webview.create_window(
        'Subtitle-for-G - 字幕双语编辑器',
        f'http://127.0.0.1:{PORT}',
        js_api=api,
        width=1100,
        height=720,
    )
    webview.start()
