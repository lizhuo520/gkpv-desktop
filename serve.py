"""gkpv 本地静态服务 —— 供 pythonw.exe（无控制台）启动。

为什么需要这个文件而不是直接 `pythonw -m http.server`：
  1) pythonw.exe 没有 stdout/stderr 句柄，sys.stderr 为 None。
     http.server 每处理一个请求都会往 sys.stderr 写访问日志 → 写入 None
     抛异常 → 客户端收到 "Remote end closed connection without response"
     （服务看着起了，实际完全不可用）。所以先把两个流兜住。
  2) Windows 上 SO_REUSEADDR 允许两个进程绑同一端口（这点和 Linux 不同），
     所以不能靠"bind 失败"来判断服务已在运行 —— 会真的绑上、两个服务
     抢请求。这里改成先主动探测端口，已在服务就直接退出。
  3) 站点根目录取脚本自身所在目录，整个文件夹搬走也不会失效。
"""
import functools
import http.server
import os
import socket
import socketserver
import sys

PORT = 8777
HOST = '127.0.0.1'


class Server(socketserver.ThreadingTCPServer):
    # 故意不开 SO_REUSEADDR：Windows 下它会让第二个实例也能绑上同一端口
    allow_reuse_address = False
    daemon_threads = True


def already_serving():
    s = socket.socket()
    s.settimeout(1.5)
    try:
        s.connect((HOST, PORT))
        return True
    except OSError:
        return False
    finally:
        s.close()


def main():
    # 修复点 1：pythonw 下这两个可能是 None
    if sys.stdout is None:
        sys.stdout = open(os.devnull, 'w', encoding='utf-8')
    if sys.stderr is None:
        sys.stderr = open(os.devnull, 'w', encoding='utf-8')

    # 修复点 2：已有实例在跑就安静退出，不要抢端口
    if already_serving():
        return 0

    root = os.path.dirname(os.path.abspath(__file__))
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=root)

    try:
        with Server((HOST, PORT), handler) as httpd:
            httpd.serve_forever()
    except OSError:
        # 极小概率的竞态：探测后、绑定前被别人抢了。静默退出即可。
        return 0
    return 0


if __name__ == '__main__':
    sys.exit(main())
