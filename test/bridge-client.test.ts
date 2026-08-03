// BridgeClient unit tests — no PixInsight required. Each test gets a fresh temp bridge
// dir and plays the watcher's role by writing result files. Ported from the reference
// pixinsight-mcp suite to Vitest (handlersRev → watcherRev).
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BridgeClient } from '../src/bridge/client.js';
import { EXPECTED_WATCHER_REV } from '../src/types.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function freshBridge(config: Record<string, unknown> = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'astropilot-test-'));
  cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
  const client = new BridgeClient({
    bridgeDir: dir,
    pollIntervalMs: 25,
    defaultTimeoutMs: 3000,
    ...config,
  });
  await client.ensureDirectories();
  return { client, commands: path.join(dir, 'commands'), results: path.join(dir, 'results') };
}

async function nextCommand(commandsDir: string, timeoutMs = 2000): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const files = (await fs.readdir(commandsDir)).filter((f) => f.endsWith('.json'));
    if (files.length > 0) {
      return JSON.parse(await fs.readFile(path.join(commandsDir, files[0]!), 'utf8'));
    }
    if (Date.now() > deadline) throw new Error('no command file appeared');
    await new Promise((r) => setTimeout(r, 10));
  }
}

function resultFor(cmd: any, extra: Record<string, unknown> = {}) {
  return {
    id: cmd.id,
    timestamp: new Date().toISOString(),
    status: 'success',
    process: cmd.process,
    duration_ms: 1,
    outputs: { watcherRev: EXPECTED_WATCHER_REV },
    message: 'ok',
    ...extra,
  };
}

async function writeResult(resultsDir: string, cmd: any, extra: Record<string, unknown> = {}) {
  await fs.writeFile(path.join(resultsDir, `${cmd.id}.json`), JSON.stringify(resultFor(cmd, extra)));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('BridgeClient', () => {
  it('success: result resolves the command and is deleted after', async () => {
    const { client, commands, results } = await freshBridge();
    const pending = client.sendCommand('ping', '__test__', { a: 1 });
    const cmd = await nextCommand(commands);
    await sleep(100);
    await writeResult(results, cmd, { message: 'done' });
    const res = await pending;
    expect(res.status).toBe('success');
    expect(res.message).toBe('done');
    expect(await fs.readdir(results)).toEqual([]);
  });

  it('writes a parseable command with correct fields and no .tmp leftover', async () => {
    const { client, commands, results } = await freshBridge();
    const pending = client.sendCommand(
      'some_tool',
      'SomeProcess',
      { x: 1 },
      { executeMethod: 'executeOn', targetView: 'v1' },
    );
    const cmd = await nextCommand(commands);
    expect(cmd.tool).toBe('some_tool');
    expect(cmd.process).toBe('SomeProcess');
    expect(cmd.parameters).toEqual({ x: 1 });
    expect(cmd.targetView).toBe('v1');
    expect((await fs.readdir(commands)).filter((f) => f.endsWith('.tmp'))).toEqual([]);
    await writeResult(results, cmd);
    await pending;
  });

  it('handles a running ack then success', async () => {
    const { client, commands, results } = await freshBridge();
    const pending = client.sendCommand('slow', '__test__', {});
    const cmd = await nextCommand(commands);
    await writeResult(results, cmd, { status: 'running', message: 'in progress' });
    await sleep(300);
    await writeResult(results, cmd, { message: 'finished' });
    const res = await pending;
    expect(res.status).toBe('success');
    expect(res.message).toBe('finished');
  });

  it('fails fast as MalformedResult after the grace window', async () => {
    const { client, commands, results } = await freshBridge({ defaultTimeoutMs: 10_000 });
    const pending = client.sendCommand('bad', '__test__', {});
    const cmd = await nextCommand(commands);
    await fs.writeFile(path.join(results, `${cmd.id}.json`), 'this is not json {{{');
    const started = Date.now();
    const res = await pending;
    expect(res.status).toBe('error');
    expect(res.error?.type).toBe('MalformedResult');
    expect(Date.now() - started).toBeLessThan(8000);
  });

  it('lets a partial write completed within the grace window succeed', async () => {
    const { client, commands, results } = await freshBridge({ defaultTimeoutMs: 10_000 });
    const pending = client.sendCommand('partial', '__test__', {});
    const cmd = await nextCommand(commands);
    const resPath = path.join(results, `${cmd.id}.json`);
    const full = JSON.stringify(resultFor(cmd, { message: 'completed' }));
    await fs.writeFile(resPath, full.slice(0, 20));
    await sleep(500);
    await fs.writeFile(resPath, full);
    const res = await pending;
    expect(res.status).toBe('success');
    expect(res.message).toBe('completed');
  });

  it('turns a success without watcherRev into a hard error', async () => {
    const { client, commands, results } = await freshBridge();
    const pending = client.sendCommand('ping', '__test__', {});
    const cmd = await nextCommand(commands);
    await writeResult(results, cmd, { outputs: {} });
    const res = await pending;
    expect(res.status).toBe('error');
    expect(res.error?.type).toBe('WatcherRevisionMismatch');
    expect(res.error?.message).toMatch(/astropilot-watcher/);
  });

  it('turns a lower watcherRev into a hard error', async () => {
    const { client, commands, results } = await freshBridge();
    const pending = client.sendCommand('ping', '__test__', {});
    const cmd = await nextCommand(commands);
    await writeResult(results, cmd, { outputs: { watcherRev: EXPECTED_WATCHER_REV - 1 } });
    const res = await pending;
    expect(res.status).toBe('error');
    expect(res.error?.type).toBe('WatcherRevisionMismatch');
  });

  it('warns once for a newer watcher but stays success', async () => {
    const { client, commands, results } = await freshBridge();
    for (const expectWarning of [true, false]) {
      const pending = client.sendCommand('ping', '__test__', {});
      const cmd = await nextCommand(commands);
      await fs.rm(path.join(commands, `${cmd.id}.json`));
      await writeResult(results, cmd, { outputs: { watcherRev: EXPECTED_WATCHER_REV + 1 } });
      const res = await pending;
      expect(res.status).toBe('success');
      expect(/WARNING:.*newer/s.test(res.message ?? '')).toBe(expectWarning);
    }
  });

  it('returns a Timeout error when no result appears', async () => {
    const { client } = await freshBridge();
    const res = await client.sendCommand('void', '__test__', {}, { timeoutMs: 300 });
    expect(res.status).toBe('error');
    expect(res.error?.type).toBe('Timeout');
  });

  it('reaps old/malformed json and old .tmp, keeps fresh', async () => {
    const { client, commands } = await freshBridge();
    const old = new Date(Date.now() - 20 * 60_000);
    await fs.writeFile(
      path.join(commands, 'old.json'),
      JSON.stringify({ id: 'old', timestamp: old.toISOString() }),
    );
    await fs.writeFile(
      path.join(commands, 'fresh.json'),
      JSON.stringify({ id: 'fresh', timestamp: new Date().toISOString() }),
    );
    await fs.writeFile(path.join(commands, 'garbage.json'), 'not json');
    await fs.writeFile(path.join(commands, 'old.tmp'), '{}');
    await fs.utimes(path.join(commands, 'old.tmp'), old, old);
    await fs.writeFile(path.join(commands, 'fresh.tmp'), '{}');

    const cleaned = await client.cleanStaleCommands();
    expect(cleaned).toBe(3);
    expect((await fs.readdir(commands)).sort()).toEqual(['fresh.json', 'fresh.tmp']);
  });

  it('reaps orphaned results by mtime', async () => {
    const { client, results } = await freshBridge();
    const old = new Date(Date.now() - 20 * 60_000);
    await fs.writeFile(path.join(results, 'orphan.json'), JSON.stringify({ id: 'orphan' }));
    await fs.utimes(path.join(results, 'orphan.json'), old, old);
    await fs.writeFile(path.join(results, 'orphan.tmp'), '{}');
    await fs.utimes(path.join(results, 'orphan.tmp'), old, old);
    await fs.writeFile(path.join(results, 'fresh.json'), JSON.stringify({ id: 'fresh' }));

    const cleaned = await client.cleanStaleCommands();
    expect(cleaned).toBe(2);
    expect((await fs.readdir(results)).sort()).toEqual(['fresh.json']);
  });
});
