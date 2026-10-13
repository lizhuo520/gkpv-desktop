'use strict';

/**
 * 目录授权表（capability 模型）。
 *
 * 渲染层永远不持有绝对路径，只持有 `src:<id>` 句柄；主进程用它反查真实路径。
 * 这样即使渲染层被注入脚本，也无法读任意文件。
 */

const fs = require('node:fs/promises');
const path = require('node:path');

/** @type {Map<string, {root:string, recursive:boolean, createdAt:number}>} */
const sources = new Map();
let seq = 0;

function remember(dir, recursive = false) {
  seq += 1;
  const id = `src:${seq}`;
  sources.set(id, { root: dir, recursive: !!recursive, createdAt: Date.now() });
  return { id, root: dir, name: path.basename(dir) || dir };
}

function setRecursive(id, recursive) {
  const s = sources.get(id);
  if (!s) return false;
  s.recursive = !!recursive;
  return true;
}

function resolve(id) {
  return sources.get(id) || null;
}

/** 校验子路径不逃逸根目录（`..`、绝对路径、符号链接穿越）。 */
function safeJoin(root, rel) {
  const norm = String(rel || '').replace(/\\/g, '/');
  if (norm.includes('\0')) return null;
  const joined = path.resolve(root, norm);
  const rootResolved = path.resolve(root);
  if (joined !== rootResolved && !joined.startsWith(rootResolved + path.sep)) return null;
  return joined;
}

async function statOf(root, rel) {
  const abs = safeJoin(root, rel);
  if (!abs) return null;
  try {
    const st = await fs.stat(abs);
    return { size: st.size, lastModified: st.mtimeMs, abs };
  } catch {
    return null;
  }
}

async function readBuffer(root, rel) {
  const abs = safeJoin(root, rel);
  if (!abs) return null;
  try {
    return await fs.readFile(abs);
  } catch {
    return null;
  }
}

function release(id) {
  return sources.delete(id);
}

function releaseAll() {
  sources.clear();
}

module.exports = { remember, setRecursive, resolve, safeJoin, statOf, readBuffer, release, releaseAll, sources };
