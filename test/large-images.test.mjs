import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Renderer } from '../src/render.mjs';

test('complex images fit the socket budget without cropping or changing export resolution', { timeout: 60000 }, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'visuals-large-'));
  const renderer = new Renderer();
  try {
    await renderer.start();
    const data = await renderer.page.evaluate(() => {
      const canvas = document.createElement('canvas'); canvas.width = 1800; canvas.height = 1200;
      const ctx = canvas.getContext('2d'), pixels = ctx.createImageData(canvas.width, canvas.height);
      let seed = 123456789;
      for (let i = 0; i < pixels.data.length; i += 4) {
        for (let c = 0; c < 3; c++) { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; pixels.data[i + c] = seed >>> 24; }
        pixels.data[i + 3] = 255;
      }
      ctx.putImageData(pixels, 0, 0);
      for (const [x, y, color] of [[0, 0, '#ff0000'], [1700, 0, '#00ff00'], [0, 1100, '#0000ff'], [1700, 1100, '#ffff00']]) {
        ctx.fillStyle = color; ctx.fillRect(x, y, 100, 100);
      }
      return canvas.toDataURL('image/png').split(',')[1];
    });
    const file = path.join(dir, 'color-study.png'); await fs.writeFile(file, Buffer.from(data, 'base64'));
    const medium = Buffer.from(await renderer.page.evaluate(async source => {
      const image = new Image(); image.src = `data:image/png;base64,${source}`; await image.decode();
      const canvas = document.createElement('canvas'); canvas.width = 500; canvas.height = 400;
      canvas.getContext('2d').drawImage(image, -200, -200);
      return canvas.toDataURL('image/png').split(',')[1];
    }, data), 'base64');
    assert.ok(medium.length > 512 * 1024 && medium.length < 720 * 1024, 'exercise graphics limit independently of the RPC limit');
    assert.ok((await renderer.fitPreview(medium)).length <= 512 * 1024, 'Herdr also limits decoded inline image data to 512 KiB');
    const block = { id: 'color-study', type: 'image', source: file, context: '', raw: '' };
    const frame = await renderer.render(block, { width: 1000, height: 700 });
    assert.equal(frame.error, '');
    assert.ok(frame.png.length <= 512 * 1024);
    const request = JSON.stringify({ id: '00000000-0000-0000-0000-000000000000', method: 'pane.graphics.set', params: {
      pane_id: 'viewer', layer_id: 'visuals', format: 'png', image_width: frame.imageWidth, image_height: frame.imageHeight,
      data_base64: frame.png.toString('base64'), placement: { viewport_col: 1, viewport_row: 4, grid_cols: 88, grid_rows: 22 },
    } });
    assert.ok(Buffer.byteLength(request) <= 1048576, `request has ${Buffer.byteLength(request)} bytes`);
    assert.equal(frame.png.readUInt32BE(16), frame.imageWidth);
    assert.equal(frame.png.readUInt32BE(20), frame.imageHeight);
    const exported = await renderer.exportPNG();
    assert.ok(exported.length > 1048576, 'fixture must exceed the limit before adaptation');
    assert.equal(exported.readUInt32BE(16), 2000);
    assert.equal(exported.readUInt32BE(20), 1400);
    assert.ok(frame.imageWidth < 2000);
    assert.ok(Math.abs(frame.imageWidth / frame.imageHeight - 1000 / 700) < 0.01);
    const colors = await renderer.page.evaluate(async png => {
      const image = new Image(); image.src = `data:image/png;base64,${png}`; await image.decode();
      const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
      const ctx = canvas.getContext('2d'); ctx.drawImage(image, 0, 0);
      // Coordinates of the four corner markers in the complete original viewport.
      return [[47, 47], [897, 47], [47, 597], [897, 597]].map(([x, y]) =>
        [...ctx.getImageData(Math.round(x / 1000 * image.width), Math.round(y / 700 * image.height), 1, 1).data].slice(0, 3));
    }, frame.png.toString('base64'));
    assert.deepEqual(colors, [[255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 0]]);
    const zoomed = await renderer.render(block, { width: 1000, height: 700, zoom: 2, x: 100, y: 100 });
    assert.equal(zoomed.error, ''); assert.ok(zoomed.png.length <= 512 * 1024);
    assert.ok(zoomed.x > 0 && zoomed.y > 0, 'adaptation preserves zoom and pan');
  } finally { await renderer.close(); await fs.rm(dir, { recursive: true, force: true }); }
});

test('valid images above the old file and pixel limits still preview', { timeout: 60000 }, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'visuals-input-'));
  const renderer = new Renderer();
  try {
    const width = 3400, height = 3300, stride = width * 3;
    const bmp = Buffer.alloc(54 + stride * height, 120);
    bmp.write('BM'); bmp.writeUInt32LE(bmp.length, 2); bmp.writeUInt32LE(0, 6); bmp.writeUInt32LE(54, 10);
    bmp.writeUInt32LE(40, 14); bmp.writeInt32LE(width, 18); bmp.writeInt32LE(height, 22);
    bmp.writeUInt16LE(1, 26); bmp.writeUInt16LE(24, 28); bmp.writeUInt32LE(0, 30);
    bmp.writeUInt32LE(stride * height, 34); bmp.fill(0, 38, 54);
    assert.ok(bmp.length > 32 * 1024 * 1024);
    const files = [path.join(dir, 'large-bitmap.bmp'), path.join(dir, 'large-vector.svg')];
    await fs.writeFile(files[0], bmp);
    await fs.writeFile(files[1], '<svg xmlns="http://www.w3.org/2000/svg" width="10000" height="5000"><rect width="10000" height="5000" fill="#345b74"/></svg>');
    for (const file of files) {
      const frame = await renderer.render({ id: file, type: 'image', source: file, context: '', raw: '' }, { width: 600, height: 400 });
      assert.equal(frame.error, '');
      assert.ok(await renderer.page.locator('#content img').evaluate(el => el.complete && el.naturalWidth > 0));
      assert.ok(frame.png.length <= 512 * 1024);
    }
  } finally { await renderer.close(); await fs.rm(dir, { recursive: true, force: true }); }
});
