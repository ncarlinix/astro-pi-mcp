import { z } from 'zod';
import type { ToolDef } from './types.js';
import { toToolResult } from './util.js';

const COMPRESSION = [
  'zlib',
  'zlib+sh',
  'zstd',
  'zstd+sh',
  'lz4',
  'lz4+sh',
  'lz4hc',
  'lz4hc+sh',
  'none',
] as const;

export const openImage: ToolDef = {
  name: 'open_image',
  description: 'Open an image file (XISF, FITS, TIFF, …) in PixInsight and return its view id.',
  inputSchema: { path: z.string().describe('Absolute path to the image file') },
  handler: async (backend, args) => {
    const res = await backend.send('open_image', '__internal__', { filePath: args.path });
    return toToolResult(res);
  },
};

export const saveImage: ToolDef = {
  name: 'save_image',
  description:
    'Save a view to disk. For XISF, an explicit compression codec is used (default ' +
    '"zlib+sh") so file sizes are reproducible. Omit "view" to save the active image. ' +
    'Set overwrite=true to replace an existing file.',
  inputSchema: {
    path: z.string().describe('Absolute output path; extension selects the format'),
    view: z.string().optional().describe('View id to save; omit for the active image'),
    compression: z.enum(COMPRESSION).optional().describe('XISF compression codec'),
    overwrite: z.boolean().optional().describe('Replace an existing file (default false)'),
  },
  handler: async (backend, args) => {
    const res = await backend.send('save_image', '__internal__', {
      viewId: args.view,
      filePath: args.path,
      compression: args.compression,
      overwrite: args.overwrite ?? false,
    });
    return toToolResult(res);
  },
};

export const closeImage: ToolDef = {
  name: 'close_image',
  description: 'Close an image window. Omit "view" to close the active image.',
  inputSchema: { view: z.string().optional().describe('View id to close; omit for active') },
  handler: async (backend, args) => {
    const res = await backend.send('close_image', '__internal__', { viewId: args.view });
    return toToolResult(res);
  },
};

export const listImages: ToolDef = {
  name: 'list_images',
  description:
    'List all open image windows with their view id, file path, and geometry ' +
    '(width/height/channels/color/bit depth).',
  inputSchema: {},
  handler: async (backend) => {
    const res = await backend.send('list_open_images', '__internal__', {});
    return toToolResult(res);
  },
};

export const activeImage: ToolDef = {
  name: 'active_image',
  description: 'Return the currently active image window (view id + geometry), or null if none.',
  inputSchema: {},
  handler: async (backend) => {
    const res = await backend.send('active_image', '__internal__', {});
    return toToolResult(res);
  },
};

export const imageTools: ToolDef[] = [openImage, saveImage, closeImage, listImages, activeImage];
