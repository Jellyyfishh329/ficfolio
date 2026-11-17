'use strict';

/**
 * Ficfolio — a tiny, dependency-free AO3 EPUB library.
 *
 * Node built-ins only. EPUBs are unzipped with zlib, parsed as XML with a
 * small purpose-built parser, extracted to data/library/<id>/ and served
 * back to the browser as sanitized chapter HTML.
 */

const http = require('http');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');
const LIBRARY_DIR = path.join(DATA_DIR, 'library');
const PORT = Number(process.env.PORT) || 4545;
const MAX_UPLOAD = 250 * 1024 * 1024;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.xhtml': 'application/xhtml+xml; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.mp4': 'video/mp4',
  '.pdf': 'application/pdf',
};

/* ------------------------------------------------------------------ *
 * ZIP reader
 * ------------------------------------------------------------------ */

function findEocd(buf) {
  const floor = Math.max(0, buf.length - 0xffff - 22);
  for (let i = buf.length - 22; i >= floor; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) return i;
  }
  return -1;
}

function decodeZipName(buf, flags) {
  // Bit 11 means UTF-8; some writers omit it despite using UTF-8.
  const utf8 = buf.toString('utf8');
  const name = flags & 0x800 ? utf8 : buf.toString('latin1');
  return (name.includes('\uFFFD') ? utf8 : name).replace(/\\/g, '/');
}

function unzip(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 22) {
    throw new Error('That file is too small to be an EPUB.');
  }
  const eocd = findEocd(buffer);
  if (eocd < 0) throw new Error('That file is not a valid EPUB (no ZIP directory found).');

  const entryCount = buffer.readUInt16LE(eocd + 10);
  const cdOffset = buffer.readUInt32LE(eocd + 16);
  if (entryCount === 0xffff || cdOffset === 0xffffffff) {
    throw new Error('ZIP64 EPUBs are not supported.');
  }

  const files = new Map();
  let ptr = cdOffset;
  for (let n = 0; n < entryCount; n++) {
    if (ptr + 46 > buffer.length || buffer.readUInt32LE(ptr) !== 0x02014b50) break;
    const flags = buffer.readUInt16LE(ptr + 8);
    const method = buffer.readUInt16LE(ptr + 10);
    const compressedSize = buffer.readUInt32LE(ptr + 20);
    const nameLen = buffer.readUInt16LE(ptr + 28);
    const extraLen = buffer.readUInt16LE(ptr + 30);
    const commentLen = buffer.readUInt16LE(ptr + 32);
    const localOffset = buffer.readUInt32LE(ptr + 42);
    const nameBuf = buffer.subarray(ptr + 46, ptr + 46 + nameLen);
    const name = normalizeZipPath(decodeZipName(nameBuf, flags));
    ptr += 46 + nameLen + extraLen + commentLen;

    if (!name || name.endsWith('/')) continue;
    if (flags & 1) throw new Error('This EPUB is encrypted and cannot be opened.');

    if (localOffset + 30 > buffer.length) continue;
    if (buffer.readUInt32LE(localOffset) !== 0x04034b50) continue;
    const localNameLen = buffer.readUInt16LE(localOffset + 26);
    const localExtraLen = buffer.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + localNameLen + localExtraLen;
    if (start + compressedSize > buffer.length) continue;
    const raw = buffer.subarray(start, start + compressedSize);

    let data;
    if (method === 0) data = raw;
    else if (method === 8 || method === 12) {
      try {
        data = zlib.inflateRawSync(raw);
      } catch {
        continue;
      }
    } else continue;

    files.set(name, data);
  }

  if (!files.size) throw new Error('That EPUB appears to be empty or damaged.');
  return files;
}

function normalizeZipPath(name) {
  return String(name)
    .replace(/\\/g, '/')
    .replace(/^\.?\//, '')
    .replace(/\/+/g, '/');
}

function dirnamePosix(p) {
  const idx = p.lastIndexOf('/');
  return idx < 0 ? '' : p.slice(0, idx);
}

function decodeUriSafe(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function resolvePosix(baseDir, relative) {
  let clean = decodeUriSafe(String(relative).trim()).replace(/\\/g, '/');
  clean = clean.split('?')[0].split('#')[0];
  const combined = clean.startsWith('/') ? clean.replace(/^\/+/, '') : (baseDir ? `${baseDir}/${clean}` : clean);
  const parts = [];
  for (const segment of combined.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      parts.pop();
      continue;
    }
    parts.push(segment);
  }
  return parts.join('/');
}

/* ------------------------------------------------------------------ *
 * Minimal XML parser (enough for OPF / container / nav / NCX)
 * ------------------------------------------------------------------ */

function decodeEntities(text) {
  return String(text).replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (match, entity) => {
    const name = entity.toLowerCase();
    if (name === 'amp') return '&';
    if (name === 'lt') return '<';
    if (name === 'gt') return '>';
    if (name === 'quot') return '"';
    if (name === 'apos') return "'";
    if (name.startsWith('#x')) return String.fromCodePoint(parseInt(name.slice(2), 16));
    if (name.startsWith('#')) return String.fromCodePoint(parseInt(name.slice(1), 10));
    return match;
  });
}

function findTagEnd(xml, from) {
  let quote = null;
  for (let i = from; i < xml.length; i++) {
    const c = xml[i];
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === '>') {
      return i;
    }
  }
  return -1;
}

function parseXml(xml) {
  const root = { name: '#document', attrs: {}, children: [] };
  const stack = [root];
  let i = 0;

  const addText = (text) => {
    if (text) stack[stack.length - 1].children.push({ text });
  };

  while (i < xml.length) {
    const lt = xml.indexOf('<', i);
    if (lt < 0) {
      addText(decodeEntities(xml.slice(i)));
      break;
    }
    if (lt > i) addText(decodeEntities(xml.slice(i, lt)));

    if (xml.startsWith('<!--', lt)) {
      const end = xml.indexOf('-->', lt + 4);
      i = end < 0 ? xml.length : end + 3;
      continue;
    }
    if (xml.startsWith('<![CDATA[', lt)) {
      const end = xml.indexOf(']]>', lt + 9);
      addText(xml.slice(lt + 9, end < 0 ? xml.length : end));
      i = end < 0 ? xml.length : end + 3;
      continue;
    }
    if (xml.startsWith('<?', lt) || xml.startsWith('<!', lt)) {
      const end = xml.indexOf('>', lt);
      i = end < 0 ? xml.length : end + 1;
      continue;
    }

    const gt = findTagEnd(xml, lt + 1);
    if (gt < 0) break;
    let raw = xml.slice(lt + 1, gt);
    i = gt + 1;

    if (raw.startsWith('/')) {
      const name = raw.slice(1).trim();
      for (let k = stack.length - 1; k > 0; k--) {
        if (stack[k].name === name) {
          stack.length = k;
          break;
        }
      }
      continue;
    }

    const selfClosing = raw.endsWith('/');
    if (selfClosing) raw = raw.slice(0, -1);
    const nameMatch = raw.match(/^([^\s/>]+)/);
    if (!nameMatch) continue;
    const name = nameMatch[1];

    const attrs = {};
    const attrRe = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
    let m;
    while ((m = attrRe.exec(raw.slice(name.length)))) {
      attrs[m[1]] = decodeEntities(m[2] !== undefined ? m[2] : m[3]);
    }

    const node = { name, attrs, children: [] };
    stack[stack.length - 1].children.push(node);
    if (!selfClosing) stack.push(node);
  }

  return root;
}

function localName(name) {
  const idx = String(name).indexOf(':');
  return (idx >= 0 ? name.slice(idx + 1) : name).toLowerCase();
}

function findAll(node, wanted, out = []) {
  if (!node || !node.children) return out;
  for (const child of node.children) {
    if (child.name && localName(child.name) === wanted) out.push(child);
    if (child.children) findAll(child, wanted, out);
  }
  return out;
}

function findFirst(node, wanted) {
  return findAll(node, wanted)[0] || null;
}

function textOf(node) {
  if (!node) return '';
  if (typeof node.text === 'string') return node.text;
  return (node.children || []).map(textOf).join('');
}

function cleanText(value, max = 400) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function stripMarkup(value) {
  return decodeEntities(
    String(value || '')
      .replace(/<br\s*\/?>/gi, ' ')
      .replace(/<\/p>/gi, ' ')
      .replace(/<[^>]*>/g, ' '),
  )
    .replace(/\s+/g, ' ')
    .trim();
}

function uniqueList(values) {
  const seen = new Set();
  const out = [];
  for (const value of values) {
    const clean = cleanText(value, 120);
    if (!clean) continue;
    const key = clean.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(clean);
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * EPUB parsing
 * ------------------------------------------------------------------ */

function extractBody(html) {
  const match = String(html).match(/<body\b[^>]*>([\s\S]*?)<\/body\s*>/i);
  return match ? match[1] : String(html);
}

function extractHeading(html) {
  const body = extractBody(html);
  const match = body.match(/<h[1-3]\b[^>]*>([\s\S]*?)<\/h[1-3]\s*>/i);
  return match ? cleanText(stripMarkup(match[1]), 200) : '';
}

function getChapterMap(chapters) {
  const map = new Map();
  chapters.forEach((chapter, index) => map.set(chapter.path, index));
  return map;
}

function parseEpub(buffer) {
  const files = unzip(buffer);

  const containerBuf = files.get('META-INF/container.xml');
  if (!containerBuf) throw new Error('This EPUB is missing META-INF/container.xml.');

  const container = parseXml(containerBuf.toString('utf8'));
  const rootfile = findFirst(container, 'rootfile');
  const opfPath = normalizeZipPath(rootfile?.attrs['full-path'] || rootfile?.attrs.fullpath || '');
  if (!opfPath) throw new Error('This EPUB does not declare a package document.');

  const opfBuf = files.get(opfPath) || files.get(decodeUriSafe(opfPath));
  if (!opfBuf) throw new Error('The EPUB package document is missing.');
  const opf = parseXml(opfBuf.toString('utf8'));
  const opfDir = dirnamePosix(opfPath);
  const metadata = findFirst(opf, 'metadata') || opf;
  const manifest = findFirst(opf, 'manifest');
  const spine = findFirst(opf, 'spine');
  if (!manifest || !spine) throw new Error('The EPUB package document is incomplete.');

  /* Metadata */
  const title =
    cleanText(textOf(findFirst(metadata, 'title'))) ||
    cleanText(decodeUriSafe(path.basename(opfPath)).replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ')) ||
    'Untitled';

  const creators = uniqueList(findAll(metadata, 'creator').map((node) => textOf(node)));
  const author = creators.length ? creators.join(' & ') : 'Unknown author';

  const tags = uniqueList(findAll(metadata, 'subject').map((node) => textOf(node)))
    .map((tag) => tag.replace(/^ao3:/i, '').trim())
    .filter(Boolean)
    .slice(0, 80);

  const summary = stripMarkup(textOf(findFirst(metadata, 'description'))).slice(0, 1200);
  const language = cleanText(textOf(findFirst(metadata, 'language')), 30) || 'en';

  /* Manifest */
  const items = new Map();
  const manifestItems = findAll(manifest, 'item');
  for (const item of manifestItems) {
    const id = item.attrs.id;
    const href = item.attrs.href;
    if (!id || !href) continue;
    items.set(id, {
      id,
      href,
      path: resolvePosix(opfDir, href),
      mediaType: (item.attrs['media-type'] || '').toLowerCase(),
      properties: (item.attrs.properties || '').toLowerCase().split(/\s+/).filter(Boolean),
    });
  }

  /* Cover */
  let coverPath = null;
  const coverMeta = findAll(metadata, 'meta').find((node) => (node.attrs.name || '').toLowerCase() === 'cover');
  if (coverMeta?.attrs.content && items.has(coverMeta.attrs.content)) {
    coverPath = items.get(coverMeta.attrs.content).path;
  }
  if (!coverPath) {
    const coverItem = [...items.values()].find(
      (item) => item.properties.includes('cover-image') || item.properties.includes('cover'),
    );
    if (coverItem) coverPath = coverItem.path;
  }
  if (coverPath && !files.has(coverPath)) coverPath = null;

  /* Chapter order */
  const chapterItems = [];
  for (const itemref of findAll(spine, 'itemref')) {
    if ((itemref.attrs.linear || '').toLowerCase() === 'no') continue;
    const item = items.get(itemref.attrs.idref);
    if (!item) continue;
    if (!/x?html/.test(item.mediaType) && !/\.x?html?$/i.test(item.href)) continue;
    if (!files.has(item.path)) continue;
    chapterItems.push(item);
  }
  if (!chapterItems.length) throw new Error('This EPUB does not contain any readable chapters.');

  /* Chapter labels: EPUB3 nav first, then NCX, then the chapter heading */
  const labels = new Map();
  const navItem = [...items.values()].find((item) => item.properties.includes('nav'));
  if (navItem && files.has(navItem.path)) {
    const navDoc = parseXml(files.get(navItem.path).toString('utf8'));
    const navs = findAll(navDoc, 'nav');
    const tocNav = navs.find((nav) => (nav.attrs['epub:type'] || '').toLowerCase().includes('toc')) || navs[0];
    if (tocNav) {
      for (const anchor of findAll(tocNav, 'a')) {
        const href = anchor.attrs.href;
        if (!href) continue;
        const target = resolvePosix(dirnamePosix(navItem.path), href);
        const label = cleanText(textOf(anchor), 200);
        if (target && label && !labels.has(target)) labels.set(target, label);
      }
    }
  }

  if (!labels.size) {
    const ncxItem =
      [...items.values()].find((item) => item.mediaType === 'application/x-dtbncx+xml') ||
      (spine.attrs.toc ? items.get(spine.attrs.toc) : null);
    if (ncxItem && files.has(ncxItem.path)) {
      const ncx = parseXml(files.get(ncxItem.path).toString('utf8'));
      const ncxDir = dirnamePosix(ncxItem.path);
      const walk = (node) => {
        for (const child of node.children || []) {
          if (child.name && localName(child.name) === 'navpoint') {
            const content = findFirst(child, 'content');
            const navLabel = findFirst(child, 'navlabel');
            const label = navLabel ? cleanText(textOf(findFirst(navLabel, 'text') || navLabel), 200) : '';
            if (content?.attrs.src) {
              const target = resolvePosix(ncxDir, content.attrs.src);
              if (target && label && !labels.has(target)) labels.set(target, label);
            }
            walk(child);
          }
        }
      };
      walk(ncx);
    }
  }

  const chapters = chapterItems.map((item, index) => {
    let label = labels.get(item.path) || '';
    if (!label) {
      label = extractHeading(files.get(item.path).toString('utf8'));
    }
    return {
      title: label || `Chapter ${index + 1}`,
      path: item.path,
    };
  });

  /* Word count */
  let wordCount = 0;
  for (const chapter of chapters) {
    const text = stripMarkup(extractBody(files.get(chapter.path).toString('utf8')));
    if (text) wordCount += text.split(/\s+/).filter(Boolean).length;
  }

  return {
    files,
    opfPath,
    opfDir,
    title,
    author,
    tags,
    summary,
    language,
    cover: coverPath,
    chapters,
    wordCount,
  };
}

/* ------------------------------------------------------------------ *
 * HTML transformation
 * ------------------------------------------------------------------ */

function escapeAttr(value) {
  return String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

function stripDangerous(html) {
  return String(html)
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, '')
    .replace(/<(iframe|object|embed|form|video|audio|canvas|noscript)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<(script|style|iframe|object|embed|form|input|button|textarea|select|option|link|meta|base|video|audio|canvas|noscript)\b[^>]*\/?>/gi, '')
    .replace(/\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/\s(srcdoc|formaction)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/(href|src)\s*=\s*(?:"[^"]*(?:javascript|vbscript):[^"]*"|'[^']*(?:javascript|vbscript):[^']*')/gi, '$1="#"');
}

function rewriteUrls(html, chapterPath, chapterMap, assetExists, assetHref) {
  const baseDir = dirnamePosix(chapterPath);
  return html.replace(/(\s)(href|src)(\s*=\s*)(["'])([\s\S]*?)\4/gi, (match, space, attr, eq, quote, rawValue) => {
    const attrName = attr.toLowerCase();
    const value = decodeEntities(rawValue).trim();
    if (!value) return match;
    if (value.startsWith('#')) return match;

    if (/^data:/i.test(value)) {
      return attrName === 'src' && /^data:image\//i.test(value) ? match : '';
    }
    if (/^(mailto:|tel:)/i.test(value)) return match;

    if (/^[a-z][a-z0-9+.-]*:/i.test(value)) {
      if (attrName === 'href' && /^https?:/i.test(value)) {
        return ` href="${escapeAttr(value)}" target="_blank" rel="noopener noreferrer"`;
      }
      return attrName === 'href' ? match : '';
    }

    const hashIdx = value.indexOf('#');
    const pathPart = (hashIdx >= 0 ? value.slice(0, hashIdx) : value).split('?')[0];
    const fragment = hashIdx >= 0 ? value.slice(hashIdx + 1) : '';
    if (!pathPart) return match;
    const resolved = resolvePosix(baseDir, pathPart);

    if (attrName === 'href') {
      const chapterIndex = chapterMap.get(resolved);
      if (chapterIndex !== undefined) {
        return ` href="#chapter-${chapterIndex}" data-chapter="${chapterIndex}"${
          fragment ? ` data-frag="${escapeAttr(fragment)}"` : ''
        }`;
      }
      if (assetExists(resolved)) {
        return ` href="${escapeAttr(assetHref(resolved))}${fragment ? `#${escapeAttr(fragment)}` : ''}" target="_blank" rel="noopener"`;
      }
      return ' href="#"';
    }

    if (assetExists(resolved)) return ` src="${escapeAttr(assetHref(resolved))}"`;
    return '';
  });
}

/* ------------------------------------------------------------------ *
 * Storage helpers
 * ------------------------------------------------------------------ */

async function ensureDirs() {
  await fsp.mkdir(LIBRARY_DIR, { recursive: true });
}

function bookDir(id) {
  return path.join(LIBRARY_DIR, id);
}

function isSafeId(id) {
  return /^[a-z0-9][a-z0-9-]{0,120}$/.test(id);
}

async function readMeta(id) {
  if (!isSafeId(id)) throw Object.assign(new Error('Book not found'), { status: 404 });
  try {
    const raw = await fsp.readFile(path.join(bookDir(id), 'meta.json'), 'utf8');
    return JSON.parse(raw);
  } catch {
    throw Object.assign(new Error('Book not found'), { status: 404 });
  }
}

async function readChapters(id) {
  try {
    return JSON.parse(await fsp.readFile(path.join(bookDir(id), 'chapters.json'), 'utf8'));
  } catch {
    throw Object.assign(new Error('Chapter list not found'), { status: 404 });
  }
}

async function listBooks() {
  let entries = [];
  try {
    entries = await fsp.readdir(LIBRARY_DIR, { withFileTypes: true });
  } catch {
    return [];
  }
  const books = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      const meta = JSON.parse(await fsp.readFile(path.join(LIBRARY_DIR, entry.name, 'meta.json'), 'utf8'));
      if (meta && meta.id) books.push(meta);
    } catch {
      /* ignore incomplete imports */
    }
  }
  return books.sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
}

function slugify(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

function safeAssetPath(id, relative) {
  if (!isSafeId(id)) return null;
  const base = path.join(bookDir(id), 'files');
  const resolved = path.resolve(base, ...String(relative).split('/').filter(Boolean));
  if (resolved !== base && !resolved.startsWith(base + path.sep)) return null;
  return resolved;
}

async function importEpub(buffer, originalName) {
  let parsed;
  try {
    parsed = parseEpub(buffer);
  } catch (error) {
    throw Object.assign(error, { status: error.status || 400 });
  }
  const hash = crypto.createHash('sha256').update(buffer).digest('hex');

  const existing = (await listBooks()).find((book) => book.hash === hash);
  if (existing) return { book: existing, duplicate: true };

  const id = `${slugify(parsed.title) || 'untitled'}-${hash.slice(0, 8)}`;
  const dir = bookDir(id);
  const filesDir = path.join(dir, 'files');

  const tmpDir = path.join(LIBRARY_DIR, `.import-${hash.slice(0, 12)}`);
  await fsp.rm(tmpDir, { recursive: true, force: true });
  await fsp.mkdir(path.join(tmpDir, 'files'), { recursive: true });

  try {
    for (const [relative, data] of parsed.files) {
      const dest = path.join(tmpDir, 'files', ...relative.split('/'));
      if (!path.resolve(dest).startsWith(path.resolve(path.join(tmpDir, 'files')) + path.sep)) continue;
      await fsp.mkdir(path.dirname(dest), { recursive: true });
      await fsp.writeFile(dest, data);
    }

    const meta = {
      id,
      title: parsed.title,
      author: parsed.author,
      tags: parsed.tags,
      summary: parsed.summary,
      language: parsed.language,
      chapterCount: parsed.chapters.length,
      wordCount: parsed.wordCount,
      chapters: parsed.chapters.map((chapter, index) => ({ title: chapter.title, number: index + 1 })),
      cover: parsed.cover,
      addedAt: Date.now(),
      hash,
      size: buffer.length,
      sourceName: cleanText(originalName || '', 200),
    };

    await fsp.writeFile(path.join(tmpDir, 'meta.json'), JSON.stringify(meta, null, 2));
    await fsp.writeFile(
      path.join(tmpDir, 'chapters.json'),
      JSON.stringify(parsed.chapters.map((chapter) => ({ title: chapter.title, path: chapter.path }))),
    );

    await fsp.rm(dir, { recursive: true, force: true });
    await fsp.rename(tmpDir, dir);
    return { book: meta, duplicate: false };
  } catch (error) {
    await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

/* ------------------------------------------------------------------ *
 * HTTP helpers
 * ------------------------------------------------------------------ */

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readRequestBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let done = false;
    req.on('data', (chunk) => {
      if (done) return;
      size += chunk.length;
      if (size > limit) {
        done = true;
        reject(Object.assign(new Error('That EPUB is too large (max 250 MB).'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!done) resolve(Buffer.concat(chunks));
    });
    req.on('error', (error) => {
      if (!done) reject(error);
    });
  });
}

async function serveStatic(res, pathname) {
  let relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  relative = relative.split('?')[0];
  const filePath = path.resolve(PUBLIC_DIR, relative);
  if (filePath !== PUBLIC_DIR && !filePath.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  try {
    const stat = await fsp.stat(filePath);
    if (!stat.isFile()) throw new Error('not a file');
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': ['.html', '.js', '.css'].includes(ext) ? 'no-cache' : 'public, max-age=3600',
    });
    fs.createReadStream(filePath).pipe(res);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found');
  }
}

function assetUrl(id, relative) {
  return `/api/books/${id}/assets/${String(relative)
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/')}`;
}

/* ------------------------------------------------------------------ *
 * API
 * ------------------------------------------------------------------ */

async function handleApi(req, res, pathname) {
  const method = req.method || 'GET';

  if (pathname === '/api/books' && method === 'GET') {
    return sendJson(res, 200, { books: await listBooks() });
  }

  if (pathname === '/api/books' && method === 'POST') {
    const filename = decodeUriSafe(req.headers['x-filename'] || 'upload.epub');
    const buffer = await readRequestBody(req, MAX_UPLOAD);
    if (!buffer.length) {
      throw Object.assign(new Error('No file received.'), { status: 400 });
    }
    const result = await importEpub(buffer, filename);
    return sendJson(res, result.duplicate ? 200 : 201, result);
  }

  const booksMatch = pathname.match(/^\/api\/books\/([^/]+)$/);
  if (booksMatch && method === 'GET') {
    return sendJson(res, 200, { book: await readMeta(booksMatch[1]) });
  }

  if (booksMatch && method === 'DELETE') {
    const meta = await readMeta(booksMatch[1]);
    await fsp.rm(bookDir(meta.id), { recursive: true, force: true });
    return sendJson(res, 200, { ok: true });
  }

  const chapterMatch = pathname.match(/^\/api\/books\/([^/]+)\/chapters\/(\d+)$/);
  if (chapterMatch && method === 'GET') {
    const id = chapterMatch[1];
    const meta = await readMeta(id);
    const chapters = await readChapters(id);
    const index = Number(chapterMatch[2]);
    if (!Number.isInteger(index) || index < 0 || index >= chapters.length) {
      throw Object.assign(new Error('Chapter not found.'), { status: 404 });
    }

    const chapter = chapters[index];
    const chapterMap = getChapterMap(chapters);
    let raw = '';
    try {
      raw = await fsp.readFile(safeAssetPath(id, chapter.path), 'utf8');
    } catch {
      throw Object.assign(new Error('Chapter file is missing.'), { status: 404 });
    }

    const body = stripDangerous(extractBody(raw));
    const html = rewriteUrls(
      body,
      chapter.path,
      chapterMap,
      (relative) => {
        const assetPath = safeAssetPath(id, relative);
        return Boolean(assetPath && fs.existsSync(assetPath) && fs.statSync(assetPath).isFile());
      },
      (relative) => assetUrl(id, relative),
    );

    return sendJson(res, 200, {
      index,
      total: chapters.length,
      title: chapter.title,
      bookTitle: meta.title,
      author: meta.author,
      html,
    });
  }

  const assetMatch = pathname.match(/^\/api\/books\/([^/]+)\/assets\/(.+)$/);
  if (assetMatch && (method === 'GET' || method === 'HEAD')) {
    const id = assetMatch[1];
    await readMeta(id);
    const assetPath = safeAssetPath(id, decodeUriSafe(assetMatch[2]));
    if (!assetPath) {
      res.writeHead(404).end('Not found');
      return;
    }
    try {
      const stat = await fsp.stat(assetPath);
      if (!stat.isFile()) throw new Error('not a file');
      res.writeHead(200, {
        'Content-Type': MIME_TYPES[path.extname(assetPath).toLowerCase()] || 'application/octet-stream',
        'Content-Length': stat.size,
        'Cache-Control': 'public, max-age=3600',
      });
      if (method === 'HEAD') return res.end();
      fs.createReadStream(assetPath).pipe(res);
    } catch {
      res.writeHead(404).end('Not found');
    }
    return;
  }

  throw Object.assign(new Error('Not found'), { status: 404 });
}

/* ------------------------------------------------------------------ *
 * Server
 * ------------------------------------------------------------------ */

async function start() {
  await ensureDirs();

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const pathname = url.pathname;

      if (pathname.startsWith('/api/')) {
        await handleApi(req, res, pathname);
        return;
      }
      await serveStatic(res, pathname);
    } catch (error) {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      const status = error.status || (error.code === 'ENOENT' ? 404 : 500);
      const message = status >= 500 ? 'Something went wrong while reading that file.' : error.message;
      if (status >= 500) console.error(error);
      sendJson(res, status, { error: message });
    }
  });

  server.listen(PORT, '127.0.0.1', () => {
    console.log('');
    console.log('  Ficfolio is ready');
    console.log(`  → http://localhost:${PORT}`);
    console.log('  Uploaded EPUBs live in ./data/library');
    console.log('');
  });
}

if (require.main === module) {
  start().catch((error) => {
    console.error('Failed to start Ficfolio:', error);
    process.exit(1);
  });
}

module.exports = {
  unzip,
  parseXml,
  parseEpub,
  importEpub,
  start,
  PORT,
  LIBRARY_DIR,
};
