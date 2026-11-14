import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { browserCommands, HELP, parseArgs, runLauncher } from './launcher.js';

describe('parseArgs', () => {
  it('starts and opens the browser unless told otherwise', () => {
    expect(parseArgs([])).toEqual({ command: 'start', open: true, appWindow: false });
    expect(parseArgs(['start', '--no-open', '--port', '5000'])).toEqual({
      command: 'start',
      open: false,
      appWindow: false,
      port: 5000,
    });
    expect(parseArgs(['--app']).appWindow).toBe(true);
    expect(parseArgs(['--version']).command).toBe('version');
    expect(parseArgs(['--port=5001', 'stop'])).toMatchObject({ command: 'stop', port: 5001 });
    expect(parseArgs(['status']).command).toBe('status');
    expect(parseArgs(['--help']).command).toBe('help');
  });

  it('explains what it does not understand', () => {
    expect(() => parseArgs(['--port'])).toThrow(/--port needs a number/);
    expect(() => parseArgs(['--port', '99999'])).toThrow(/--port needs a number/);
    expect(() => parseArgs(['launch'])).toThrow(/Unknown option "launch"/);
    expect(() => parseArgs(['stop', 'start'])).toThrow(/Unknown option "start"/);
  });
});

describe('browserCommands', () => {
  const url = 'http://localhost:4400';
  it('uses each system’s own way to open a page', () => {
    expect(browserCommands(url, 'darwin', {})).toEqual([['open', [url]]]);
    expect(browserCommands(url, 'linux', {})).toEqual([['xdg-open', [url]]]);
    expect(browserCommands(url, 'win32', {})[0]![0]).toBe('cmd');
  });

  it('tries the browsers that can show an app window first, when asked to', () => {
    const commands = browserCommands(url, 'linux', {}, true);
    expect(commands[0]).toEqual(['google-chrome', [`--app=${url}`]]);
    // The usual way of opening a page is still there, for a computer without such a browser.
    expect(commands.at(-1)).toEqual(['xdg-open', [url]]);
  });

  it('reaches for the Windows browser from inside WSL', () => {
    const commands = browserCommands(url, 'linux', { WSL_DISTRO_NAME: 'Ubuntu' });
    expect(commands.map(([command]) => command)).toEqual(['wslview', 'explorer.exe', 'xdg-open']);
  });
});

describe('runLauncher', () => {
  let home: string;
  let lines: string[];
  const say = (line: string) => lines.push(line);
  // A port nothing listens on, so no test can find a real Symposium.
  const env = () => ({
    SYMPOSIUM_HOME: home,
    SYMPOSIUM_PORT: '4',
    SYMPOSIUM_UI_DIR: join(home, 'no-page'),
  });

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'symposium-launcher-'));
    lines = [];
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it('prints help', async () => {
    expect(await runLauncher(['--help'], env(), say)).toBe(0);
    expect(lines).toEqual([HELP]);
  });

  it('prints the version from package.json', async () => {
    expect(await runLauncher(['--version'], env(), say)).toBe(0);
    expect(lines[0]).toMatch(/^symposium \d+\.\d+\.\d+$/);
  });

  it('rejects a bad command line with exit code 2', async () => {
    expect(await runLauncher(['--bogus'], env(), say)).toBe(2);
    expect(lines[0]).toContain('Unknown option "--bogus"');
  });

  it('says how to build the page when it is missing, instead of starting', async () => {
    expect(await runLauncher(['--no-open'], env(), say)).toBe(1);
    expect(lines[0]).toContain('pnpm build');
  });

  it('reports that nothing is running, and clears a stale pid file', async () => {
    mkdirSync(home, { recursive: true });
    // Our own pid: if `stop` trusted the file alone, this test would kill itself.
    writeFileSync(join(home, 'engine.pid'), JSON.stringify({ pid: process.pid, port: 4 }));
    expect(await runLauncher(['status'], env(), say)).toBe(1);
    expect(await runLauncher(['stop'], env(), say)).toBe(0);
    expect(lines).toEqual(['Symposium is not running.', 'Symposium is not running.']);
  });
});
