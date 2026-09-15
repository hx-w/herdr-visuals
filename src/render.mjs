import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { readImage, imageDataURL } from './images.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
// Herdr limits decoded inline image data to 512 KiB. Its Base64 representation
// plus the RPC envelope also fits the separate 1 MiB request limit.
const PREVIEW_PNG_BYTES = 512 * 1024;
const template = `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src data:; connect-src 'none'; base-uri 'none'; form-action 'none'">
<link rel="stylesheet" href="/katex/katex.min.css">
<style>
*{box-sizing:border-box}html,body{margin:0;background:#dedcd5;color:#34414a;font-family:Arial,'PingFang SC','Noto Sans CJK SC',sans-serif}
body{padding:22px}#context{font-size:15px;line-height:1.6;margin:0 0 20px;white-space:pre-wrap;overflow-wrap:anywhere;color:#495a64}
#content{display:flow-root;min-width:0}#content svg{max-width:none!important;height:auto;display:block}
.katex-display{text-align:left;margin:12px 0}.katex-display>.katex{text-align:left}
pre{font-family:ui-monospace,'SF Mono',monospace;font-size:15px;line-height:1.6;white-space:pre-wrap;overflow-wrap:anywhere;margin:0}
#error{color:#ad4f48;white-space:pre-wrap;font-size:14px;margin-bottom:16px}
</style></head><body><div id="context"></div><div id="error"></div><div id="content"></div></body></html>`;

export class Renderer {
  async start() {
    this.browser = await chromium.launch({ headless: true, channel: 'chromium' });
    this.context = await this.browser.newContext({ serviceWorkers: 'block', deviceScaleFactor: 2 });
    await this.context.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.origin !== 'https://visuals.invalid') return route.abort();
      if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: template });
      const match = url.pathname.match(/^\/(mermaid|katex)\/([a-zA-Z0-9_./-]+)$/);
      if (!match || match[2].split('/').includes('..')) return route.abort();
      const file = path.join(root, 'node_modules', match[1], 'dist', match[2]);
      const types = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf' };
      const contentType = types[path.extname(file)];
      if (!contentType) return route.abort();
      try { return await route.fulfill({ contentType, body: await fs.readFile(file) }); }
      catch { return route.abort(); }
    });
    await this.newPage();
  }
  async newPage() {
    if (this.page) await this.page.close().catch(() => {});
    this.page = await this.context.newPage();
    this.page.setDefaultTimeout(12000);
    await this.page.goto('https://visuals.invalid/');
    await this.page.addScriptTag({ url: '/katex/katex.min.js' });
    await this.page.evaluate(async () => { window.mermaid = (await import('/mermaid/mermaid.esm.min.mjs')).default; });
    this.key = null;
  }
  async render(block, { width = 800, height = 600, zoom = 1, x = 0, y = 0, source = false, fit = false } = {}) {
    if (!this.browser) await this.start();
    width = Math.max(100, Math.min(2400, Math.round(width)));
    height = Math.max(80, Math.min(1800, Math.round(height)));
    await this.page.setViewportSize({ width, height });
    let loaded, imageError;
    if (block.type === 'image' && !source) {
      try {
        if (block.imageData) {
          const dataURL = imageDataURL({ type: 'input_image', image_url: block.imageData });
          if (!dataURL) throw new Error('Invalid embedded image.');
          loaded = { dataURL, revision: block.id };
        } else loaded = await readImage(block.source, block.cwd);
      }
      catch (error) { imageError = error.message; }
    }
    const { imageData: _imageData, ...renderBlock } = block;
    const key = JSON.stringify([block.id, width, height, zoom, source, fit, loaded?.revision, imageError]);
    let timer;
    try {
      if (this.key !== key) {
        await Promise.race([
          this.page.evaluate(async ({ block, width, height, zoom, source, fit, dataURL, imageError }) => {
            window.scrollTo(0, 0);
            const target = document.querySelector('#content');
            target.replaceChildren();
            document.querySelector('#context').textContent = block.context === block.title ? '' : block.context;
            document.querySelector('#error').textContent = '';
            target.style.fontSize = `${22 * zoom}px`;
            const showSource = () => { const pre = document.createElement('pre'); pre.textContent = block.raw || block.source; target.replaceChildren(pre); };
            if (source) { showSource(); return; }
            try {
              if (block.source.length > 50000) throw new Error('Preview is limited to 50,000 characters. Use source view.');
              if (block.type === 'image') {
                if (imageError) throw new Error(imageError);
                const image = document.createElement('img'); image.src = dataURL;
                image.style.display = 'block'; target.replaceChildren(image);
                await image.decode();
                const scale = Math.min(1, (width - 44) / image.naturalWidth, (height - 100) / image.naturalHeight);
                image.style.width = `${Math.max(1, image.naturalWidth * scale * zoom)}px`;
                image.style.height = 'auto';
              } else if (block.type === 'math') {
                window.katex.render(block.source, target, { displayMode: true, throwOnError: true, trust: false, maxSize: 20, maxExpand: 1000, strict: 'warn' });
                const math = target.querySelector('.katex');
                if (math && zoom === 1 && math.getBoundingClientRect().width > width - 44) {
                  target.style.fontSize = `${Math.max(12, 22 * (width - 44) / math.getBoundingClientRect().width)}px`;
                }
              } else {
                window.mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', suppressErrorRendering: true,
                  maxTextSize: 50000, maxEdges: 500, theme: 'base', fontFamily: "Arial, PingFang SC, Noto Sans CJK SC, sans-serif",
                  themeVariables: { primaryColor: '#cbd3d2', primaryTextColor: '#34414a', primaryBorderColor: '#74838a', lineColor: '#345b74', secondaryColor: '#d8dad3', tertiaryColor: '#dedcd5' } });
                const { svg } = await window.mermaid.render('diagram', block.source);
                target.innerHTML = svg;
                const element = target.querySelector('svg');
                const view = element.viewBox.baseVal;
                const scale = Math.min(1, (width - 44) / (view.width || width));
                element.style.width = `${(view.width || width - 44) * (fit ? scale : Math.max(0.85, scale)) * zoom}px`;
              }
              await document.fonts.ready;
            } catch (error) {
              document.querySelector('#error').textContent = `Could not render: ${error.message}`;
              showSource();
            }
          }, { block: renderBlock, width, height, zoom, source, fit, dataURL: loaded?.dataURL, imageError }),
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Rendering exceeded 12 seconds')), 12000); }),
        ]);
        this.key = key;
      }
      const metrics = await this.page.evaluate(({ x, y }) => {
        window.scrollTo(x, y);
        return { x: scrollX, y: scrollY, width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight,
          error: document.querySelector('#error').textContent };
      }, { x, y });
      const original = await this.page.screenshot({ animations: 'disabled', timeout: 12000 });
      const png = await this.fitPreview(original);
      return { png, width, height, ...metrics, imageWidth: png.readUInt32BE(16), imageHeight: png.readUInt32BE(20) };
    } catch (error) { await this.newPage(); throw error; }
    finally { clearTimeout(timer); }
  }
  async fitPreview(png) {
    if (png.length <= PREVIEW_PNG_BYTES) return png;
    // Resize the captured viewport, not the document: zoom, pan, and export
    // retain their original coordinates, layout, and resolution.
    const base64 = await this.page.evaluate(async ({ source, maxBytes }) => {
      const bytes = Uint8Array.from(atob(source), c => c.charCodeAt(0));
      const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
      try {
        let scale = 1, size = bytes.length;
        const canvas = document.createElement('canvas');
        for (;;) {
          scale *= Math.min(0.8, Math.sqrt(maxBytes / size) * 0.9);
          canvas.width = Math.max(1, Math.floor(bitmap.width * scale));
          canvas.height = Math.max(1, Math.floor(bitmap.height * scale));
          const ctx = canvas.getContext('2d');
          ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
          ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
          const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
          if (!blob) throw new Error('Could not resize the preview image.');
          size = blob.size;
          if (size <= maxBytes) {
            return new Promise((resolve, reject) => {
              const reader = new FileReader();
              reader.onload = () => resolve(reader.result.split(',')[1]);
              reader.onerror = () => reject(new Error('Could not encode the preview image.'));
              reader.readAsDataURL(blob);
            });
          }
          if (canvas.width === 1 && canvas.height === 1) throw new Error('Preview could not fit the transport limit.');
        }
      } finally { bitmap.close(); }
    }, { source: png.toString('base64'), maxBytes: PREVIEW_PNG_BYTES });
    return Buffer.from(base64, 'base64');
  }
  async exportPNG() {
    const size = await this.page.evaluate(() => ({ width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight }));
    if (size.width * size.height > 24_000_000) throw new Error('Image too large to export. Reduce zoom first.');
    return this.page.screenshot({ fullPage: true, animations: 'disabled', timeout: 12000 });
  }
  async close() { await this.browser?.close(); }
}
