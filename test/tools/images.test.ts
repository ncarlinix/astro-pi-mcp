import { describe, it, expect } from 'vitest';
import {
  openImage,
  saveImage,
  closeImage,
  listImages,
  activeImage,
} from '../../src/mcp/tools/images.js';
import { recordingBackend } from './helpers.js';

describe('image tools', () => {
  it('open_image forwards the file path', async () => {
    const { backend, calls } = recordingBackend();
    await openImage.handler(backend, { path: '/data/m31.xisf' });
    expect(calls[0]).toMatchObject({
      tool: 'open_image',
      parameters: { filePath: '/data/m31.xisf' },
    });
  });

  it('save_image forwards path, view, compression, overwrite', async () => {
    const { backend, calls } = recordingBackend();
    await saveImage.handler(backend, {
      path: '/out/m31.xisf',
      view: 'm31',
      compression: 'zstd+sh',
      overwrite: true,
    });
    expect(calls[0]).toMatchObject({
      tool: 'save_image',
      parameters: {
        filePath: '/out/m31.xisf',
        viewId: 'm31',
        compression: 'zstd+sh',
        overwrite: true,
      },
    });
  });

  it('save_image defaults overwrite to false and allows omitting the view', async () => {
    const { backend, calls } = recordingBackend();
    await saveImage.handler(backend, { path: '/out/x.xisf' });
    expect(calls[0]!.parameters).toMatchObject({ viewId: undefined, overwrite: false });
  });

  it('close_image forwards the view id', async () => {
    const { backend, calls } = recordingBackend();
    await closeImage.handler(backend, { view: 'm31' });
    expect(calls[0]).toMatchObject({ tool: 'close_image', parameters: { viewId: 'm31' } });
  });

  it('list_images calls list_open_images', async () => {
    const { backend, calls } = recordingBackend();
    await listImages.handler(backend, {});
    expect(calls[0]!.tool).toBe('list_open_images');
  });

  it('active_image calls active_image', async () => {
    const { backend, calls } = recordingBackend();
    await activeImage.handler(backend, {});
    expect(calls[0]!.tool).toBe('active_image');
  });
});
