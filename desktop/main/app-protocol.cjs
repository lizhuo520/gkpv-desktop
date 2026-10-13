'use strict';

/**
 * 自定义 `app://` 协议，把 renderer/ 目录当作站点根。
 *
 * 为什么要它：`file://` 是不透明源（opaque origin），OPFS / localStorage / crypto 等
 * 在 file:// 下要么不可用要么按文件隔离。用注册为 standard+secure 的自定义协议，
 * 得到的既是 secure context，又有一个稳定的源（`app://gkpv`），OPFS 因此可用。
 */

const { protocol, net } = require('electron');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const SCHEME = 'app';
const HOST = 'gkpv';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

/** 必须在 app ready 之前调用。 */
function registerScheme() {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        stream: true,
        corsEnabled: true,
        allowServiceWorkers: true,
      },
    },
  ]);
}

/** app ready 之后调用。 */
function registerHandler(rootDir) {
  const root = path.resolve(rootDir);

  const handler = async (request) => {
    let url;
    try {
      url = new URL(request.url);
    } catch {
      return new Response('bad url', { status: 400 });
    }
    if (url.hostname !== HOST) return new Response('not found', { status: 404 });

    let rel = decodeURIComponent(url.pathname);
    if (rel === '/' || rel === '') rel = '/index.html';

    // 目录穿越防护：解析后必须仍在 root 之内
    const abs = path.resolve(root, '.' + rel);
    if (abs !== root && !abs.startsWith(root + path.sep)) {
      return new Response('forbidden', { status: 403 });
    }

    let stat;
    try {
      stat = await fsp.stat(abs);
    } catch {
      return new Response('not found', { status: 404 });
    }
    if (stat.isDirectory()) return new Response('not found', { status: 404 });

    const headers = {
      'content-type': MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream',
      'cache-control': 'no-cache',
      'content-length': String(stat.size),
    };

    // 大文件用流式返回，避免整块读进内存。
    // 但 asar 里的文件不能用 createReadStream：打包后资源全在 app.asar 内，
    // 流式读会以 EOF/EISDIR 一类错误失败（electron-builder 的 __dirname 就指向 asar）。
    // 所以这里是「先试流、失败退整读」——非打包运行走流，打包运行走整读。
    if (stat.size > 4 * 1024 * 1024) {
      try {
        const stream = fs.createReadStream(abs);
        await new Promise((resolve, reject) => {
          stream.once('readable', resolve);
          stream.once('error', reject);
        });
        return new Response(stream, { status: 200, headers });
      } catch {
        // 落到下面的整读；整读在 asar 下是支持的
      }
    }
    const data = await fsp.readFile(abs);
    return new Response(data, { status: 200, headers });
  };

  protocol.handle(SCHEME, handler);
}

const origin = `${SCHEME}://${HOST}`;
const entryUrl = () => `${origin}/renderer/index.html`;
const rootUrl = (relPath = '') => pathToFileURL(path.join(__dirname, '..', relPath)).href;

module.exports = { SCHEME, HOST, origin, entryUrl, registerScheme, registerHandler, rootUrl };
