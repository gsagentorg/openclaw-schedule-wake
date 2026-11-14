#!/usr/bin/env node
/**
 * Offline browser QA for the session-wakes Control UI page.
 *
 * This is NOT a real lab E2E test. It boots a loopback-only fixture page, a
 * synthetic in-memory host, and the real browser/main.js + browser/main.css
 * from this repository. No gateway RPC, no real API, no external requests.
 *
 * Required environment (supplied by the parent/runner):
 *   PLAYWRIGHT_MODULE_PATH  absolute path to playwright-core/index.js (or its package dir)
 *   CHROME_BIN              absolute path to a cached headless Chrome executable
 *   SW_UI_ARTIFACT_DIR      absolute output directory for screenshots/result.json
 *
 * Usage:
 *   PLAYWRIGHT_MODULE_PATH=/abs/playwright-core/index.js \
 *   CHROME_BIN=/abs/chrome \
 *   SW_UI_ARTIFACT_DIR=/abs/artifacts \
 *   node e2e/ui-smoke.mjs
 */

import { createServer } from 'node:http';
import { existsSync, statSync } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, '..');
const fixtureFile = path.join(scriptDir, 'ui-fixture.html');
const mainJsFile = path.join(projectRoot, 'dist', 'control-ui', 'source', 'main.js');
const mainCssFile = path.join(projectRoot, 'dist', 'control-ui', 'source', 'main.css');

const playwrightModuleEnv = process.env.PLAYWRIGHT_MODULE_PATH;
const chromeBinEnv = process.env.CHROME_BIN;
const artifactDirEnv = process.env.SW_UI_ARTIFACT_DIR;

function configError(message) {
  console.error(`[ui-smoke] configuration error: ${message}`);
  process.exit(2);
}

if (!playwrightModuleEnv) configError('PLAYWRIGHT_MODULE_PATH is required (absolute playwright-core/index.js path)');
if (!chromeBinEnv) configError('CHROME_BIN is required (absolute headless Chrome executable path)');
if (!artifactDirEnv) configError('SW_UI_ARTIFACT_DIR is required (absolute output directory)');

const playwrightEntry = (() => {
  const absolute = path.resolve(playwrightModuleEnv);
  try {
    if (statSync(absolute).isDirectory()) return path.join(absolute, 'index.js');
  } catch {
    configError(`PLAYWRIGHT_MODULE_PATH does not exist: ${absolute}`);
  }
  return absolute;
})();
const chromeBin = path.resolve(chromeBinEnv);
const artifactDir = path.resolve(artifactDirEnv);

if (!existsSync(playwrightEntry)) configError(`playwright entry does not exist: ${playwrightEntry}`);
if (!existsSync(chromeBin)) configError(`CHROME_BIN does not exist: ${chromeBin}`);
const artifactRelativeToSource = path.relative(projectRoot, artifactDir);
if (
  artifactRelativeToSource === ''
  || (!artifactRelativeToSource.startsWith('..') && !path.isAbsolute(artifactRelativeToSource))
) {
  configError(`SW_UI_ARTIFACT_DIR must be outside the source tree: ${artifactDir}`);
}
if (!existsSync(fixtureFile)) configError(`fixture does not exist: ${fixtureFile}`);
if (!existsSync(mainJsFile)) configError(`browser/main.js does not exist: ${mainJsFile}`);
if (!existsSync(mainCssFile)) configError(`browser/main.css does not exist: ${mainCssFile}`);

class SkipTest extends Error {
  constructor(message, evidence) {
    super(message);
    this.name = 'SkipTest';
    this.skip = true;
    this.evidence = evidence;
  }
}

function check(condition, message, evidence) {
  if (condition) return;
  const error = new Error(message);
  error.evidence = evidence;
  throw error;
}

function checkEqual(actual, expected, message, evidence) {
  if (Object.is(actual, expected)) return;
  const error = new Error(
    `${message}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`,
  );
  error.evidence = evidence ?? { expected, actual };
  throw error;
}

function parsePx(value) {
  const n = Number.parseFloat(String(value ?? ''));
  return Number.isFinite(n) ? n : 0;
}

function parseColor(value) {
  const match = String(value ?? '').match(/rgba?\(([^)]+)\)/i);
  if (!match) return null;
  const parts = match[1].split(/[\s,/]+/).map(Number).filter((n) => Number.isFinite(n));
  if (parts.length < 3) return null;
  return { r: parts[0], g: parts[1], b: parts[2], a: parts.length >= 4 ? parts[3] : 1 };
}

function colorLuminance(value) {
  const color = parseColor(value);
  if (!color) return null;
  const channel = (v) => {
    const x = v / 255;
    return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b);
}

function isTransparentColor(value) {
  const color = parseColor(value);
  return Boolean(color && color.a === 0);
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function safeFilePart(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 70) || 'test';
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function startFixtureServer() {
  const server = createServer(async (request, response) => {
    try {
      if (request.method !== 'GET') {
        response.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' });
        response.end('method not allowed');
        return;
      }
      const url = new URL(request.url || '/', 'http://127.0.0.1');
      let file = null;
      let type = 'application/octet-stream';
      if (url.pathname === '/' || url.pathname === '/ui-fixture.html') {
        file = fixtureFile;
        type = 'text/html; charset=utf-8';
      } else if (url.pathname === '/browser/main.js') {
        file = mainJsFile;
        type = 'text/javascript; charset=utf-8';
      } else if (url.pathname === '/browser/main.css') {
        file = mainCssFile;
        type = 'text/css; charset=utf-8';
      } else if (url.pathname === '/favicon.ico') {
        response.writeHead(204);
        response.end();
        return;
      } else {
        response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        response.end('not found');
        return;
      }
      const body = await readFile(file);
      response.writeHead(200, {
        'content-type': type,
        'cache-control': 'no-store',
        'content-length': body.length,
      });
      response.end(body);
    } catch (error) {
      response.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      response.end(`fixture server error: ${String(error)}`);
    }
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

async function closeServer(server) {
  if (!server) return;
  await new Promise((resolve) => server.close(() => resolve()));
}

async function openPage(suite, options = {}) {
  const theme = options.theme === 'light' ? 'light' : 'dark';
  const context = await suite.browser.newContext({
    viewport: options.viewport ?? { width: 1280, height: 900 },
    colorScheme: theme,
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    deviceScaleFactor: 1,
    reducedMotion: 'reduce',
  });

  const externalRequests = [];
  await context.route('**/*', async (route) => {
    const url = route.request().url();
    if (url.startsWith(`${suite.baseUrl}/`) || url === suite.baseUrl || /^(data|blob|about):/i.test(url)) {
      await route.continue();
      return;
    }
    externalRequests.push(url);
    await route.abort('blockedbyclient');
  });

  const page = await context.newPage();
  page.setDefaultTimeout(options.timeout ?? 8000);
  page.setDefaultNavigationTimeout(options.navigationTimeout ?? 10000);

  const consoleMessages = [];
  const pageErrors = [];
  page.on('console', (message) => {
    consoleMessages.push({ type: message.type(), text: message.text() });
  });
  page.on('pageerror', (error) => {
    pageErrors.push({ name: error.name, message: error.message, stack: error.stack });
  });

  const query = new URLSearchParams(options.query ?? {});
  if (!query.has('theme')) query.set('theme', theme);
  if (options.manual && !query.has('manual')) query.set('manual', '1');

  await page.goto(`${suite.baseUrl}/ui-fixture.html?${query.toString()}`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.testHost && window.testHost.ready === true);
  await page.evaluate(() => document.fonts.ready);

  const fatal = await page.evaluate(() => window.testHost.fatal || null);
  if (fatal) {
    throw new Error(`Fixture/plugin failed to initialize: ${fatal.message}\n${fatal.stack || ''}`);
  }

  if (options.waitForList !== false) {
    try {
      await page.waitForFunction(() => {
        const calls = window.testHost.state.calls;
        return calls.listCompleted + calls.listFailed >= 1;
      });
    } catch (error) {
      const mountError = await page.evaluate(() => window.testHost.mountError || null);
      if (mountError) {
        throw new Error(`Initial mount/list failed: ${mountError.message}\n${mountError.stack || ''}`);
      }
      throw error;
    }
    await page.waitForTimeout(40);
  }

  return {
    context,
    page,
    consoleMessages,
    pageErrors,
    externalRequests,
    async close() {
      await context.close();
    },
  };
}

async function withPage(suite, testName, options, fn) {
  const opened = await openPage(suite, options);
  try {
    const result = await fn(opened);
    if (opened.pageErrors.length > 0) {
      throw new Error(
        `Unexpected pageerror(s):\n${opened.pageErrors.map((e) => e.stack || e.message).join('\n')}`,
      );
    }
    const unexpectedMethods = await opened.page.evaluate(() => window.testHost.state.unexpectedMethods.slice());
    if (unexpectedMethods.length > 0) {
      throw new Error(`Unexpected host method(s) called by the page: ${unexpectedMethods.join(', ')}`);
    }
    if (opened.externalRequests.length > 0) {
      throw new Error(`Unexpected external request(s): ${opened.externalRequests.join(', ')}`);
    }
    return result;
  } catch (error) {
    if (options.screenshotOnFailure !== false) {
      const failureFile = path.join(artifactDir, `failure-${safeFilePart(testName)}.png`);
      try {
        await opened.page.screenshot({ path: failureFile, fullPage: true });
        error.failureScreenshot = failureFile;
      } catch {
        // Preserve the original test error; screenshot failure is secondary.
      }
    }
    throw error;
  } finally {
    await opened.close().catch(() => {});
  }
}

async function mountManual(page) {
  await page.evaluate(() => {
    window.testHost.mount();
  });
  await page.waitForFunction(() => {
    const state = window.testHost.state;
    return state.mounted && state.calls.listCompleted + state.calls.listFailed >= 1;
  });
  await page.waitForTimeout(40);
}

async function triggerPoll(page) {
  const triggered = await page.evaluate(() => window.testHost.triggerPoll());
  check(triggered === true, 'Expected a captured self-chained 20s poll timer; none was found');
  await page.waitForTimeout(40);
  return triggered;
}

async function mountText(page) {
  return page.evaluate(() => {
    const root = document.querySelector('#mount');
    return root ? root.innerText : '';
  });
}

async function statusText(page) {
  return page.evaluate(() => {
    const root = document.querySelector('#mount');
    if (!root) return '';
    const nodes = [...root.querySelectorAll('[role="status"], [aria-live], header, footer, [data-status]')];
    const fragments = nodes.map((node) => `${node.textContent || ''} ${node.getAttribute('aria-label') || ''}`);
    return `${fragments.join(' | ')} | ${root.innerText || ''}`;
  });
}

async function selectSession(page, key) {
  await page.locator('.sw-key').selectOption(key);
}

async function localDateTimeInPage(page, offsetMs) {
  return page.evaluate((offset) => {
    const date = new Date(Date.now() + offset);
    date.setSeconds(0, 0);
    const pad = (value) => String(value).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }, offsetMs);
}

async function collectStyleReport(page) {
  return page.evaluate(() => {
    const root = document.querySelector('#mount');
    const rootStyle = root ? getComputedStyle(root) : null;
    const bodyStyle = getComputedStyle(document.body);
    const px = (value) => {
      const parsed = Number.parseFloat(String(value || ''));
      return Number.isFinite(parsed) ? parsed : 0;
    };
    const isVisible = (element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    };
    const className = (element) => {
      const value = element.className;
      if (typeof value === 'string') return value.slice(0, 120);
      return String(value && value.baseVal ? value.baseVal : '').slice(0, 120);
    };
    const formTags = new Set(['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON', 'OPTION', 'LABEL']);
    const elements = root ? [root, ...root.querySelectorAll('*')] : [];
    const colors = [];
    const candidates = [];
    const grids = [];
    const borders = [];
    const addColor = (value) => {
      if (value && colors.length < 6000) colors.push(String(value));
    };

    for (const element of elements) {
      if (!element || !isVisible(element)) continue;
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      const radius = px(style.borderTopLeftRadius);
      const borderWidth = px(style.borderTopWidth);
      const background = style.backgroundColor;
      const shadow = style.boxShadow;
      const backgroundVisible = background && background !== 'rgba(0, 0, 0, 0)' && background !== 'transparent';
      addColor(style.color);
      addColor(background);
      addColor(style.borderTopColor);
      addColor(style.borderRightColor);
      addColor(style.borderBottomColor);
      addColor(style.borderLeftColor);
      addColor(style.outlineColor);
      addColor(shadow);

      if (radius > 0 || borderWidth > 0 || backgroundVisible) {
        borders.push({
          tag: element.tagName.toLowerCase(),
          cls: className(element),
          radius,
          borderWidth,
          borderColor: style.borderTopColor,
          background,
          shadow,
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        });
      }

      if (
        rect.width >= 160
        && rect.height >= 36
        && !formTags.has(element.tagName)
        && (radius > 0 || borderWidth > 0 || backgroundVisible || (shadow && shadow !== 'none'))
      ) {
        candidates.push({
          tag: element.tagName.toLowerCase(),
          cls: className(element),
          radius,
          borderWidth,
          borderColor: style.borderTopColor,
          background,
          shadow,
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        });
      }

      if ((style.display === 'grid' || style.display === 'flex') && rect.width >= 300) {
        grids.push({
          tag: element.tagName.toLowerCase(),
          cls: className(element),
          display: style.display,
          flexDirection: style.flexDirection,
          gridTemplateColumns: style.gridTemplateColumns,
          gap: style.gap,
          rowGap: style.rowGap,
          columnGap: style.columnGap,
          childCount: element.children.length,
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        });
      }
    }

    const controls = {};
    for (const selector of ['.sw-key', '.sw-at', '.sw-msg', '.sw-add']) {
      const element = document.querySelector(selector);
      if (!element) {
        controls[selector] = null;
        continue;
      }
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      controls[selector] = {
        tag: element.tagName.toLowerCase(),
        type: element.getAttribute('type') || '',
        value: 'value' in element ? element.value : null,
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        background: style.backgroundColor,
        color: style.color,
        borderTopWidth: style.borderTopWidth,
        borderTopStyle: style.borderTopStyle,
        borderTopColor: style.borderTopColor,
        borderRadius: style.borderTopLeftRadius,
        paddingTop: style.paddingTop,
        paddingRight: style.paddingRight,
        paddingBottom: style.paddingBottom,
        paddingLeft: style.paddingLeft,
        fontFamily: style.fontFamily,
        fontSize: style.fontSize,
        boxShadow: style.boxShadow,
        cursor: style.cursor,
        disabled: Boolean(element.disabled),
        ariaDisabled: element.getAttribute('aria-disabled'),
      };
    }

    const cssVars = {};
    for (const name of ['--bg', '--bg-accent', '--bg-elevated', '--text', '--muted', '--border', '--accent', '--accent-foreground']) {
      cssVars[name] = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    }

    return {
      bodyBackground: bodyStyle.backgroundColor,
      bodyColor: bodyStyle.color,
      rootBackground: rootStyle ? rootStyle.backgroundColor : null,
      rootColor: rootStyle ? rootStyle.color : null,
      cssVars,
      stylesheets: [...document.styleSheets].map((sheet) => sheet.href).filter(Boolean),
      controls,
      candidates,
      grids,
      borders: borders.slice(0, 250),
      colors,
      text: root ? root.innerText.slice(0, 800) : '',
    };
  });
}

function assertThemeAndDesign(theme, report) {
  const expected = theme === 'dark'
    ? {
      background: 'rgb(14, 16, 21)',
      color: 'rgb(188, 188, 192)',
      accentPattern: /255[,\s]+92[,\s]+92/,
      elevated: ['rgb(25, 28, 36)', 'rgb(19, 21, 27)'],
    }
    : {
      background: 'rgb(250, 249, 247)',
      color: 'rgb(64, 60, 53)',
      accentPattern: /189[,\s]+69[,\s]+49/,
      elevated: ['rgb(255, 255, 255)', 'rgb(244, 241, 236)'],
    };

  checkEqual(report.bodyBackground, expected.background, `${theme}: fixture body --bg token was not applied`);
  checkEqual(report.bodyColor, expected.color, `${theme}: fixture body --text token was not applied`);

  const stylesheetLoaded = report.stylesheets.some((href) => /\/browser\/main\.css(?:\?|$)/.test(href));
  check(stylesheetLoaded, `${theme}: browser/main.css was not loaded`, { stylesheets: report.stylesheets });

  const controls = report.controls;
  check(controls['.sw-key'], `${theme}: .sw-key is missing`);
  checkEqual(controls['.sw-key'].tag, 'select', `${theme}: .sw-key must be a select`);
  check(controls['.sw-at'], `${theme}: .sw-at is missing`);
  checkEqual(controls['.sw-at'].tag, 'input', `${theme}: .sw-at must be an input`);
  checkEqual(controls['.sw-at'].type, 'datetime-local', `${theme}: .sw-at must be input[type=datetime-local]`);
  check(controls['.sw-msg'], `${theme}: .sw-msg is missing`);
  checkEqual(controls['.sw-msg'].tag, 'textarea', `${theme}: .sw-msg must be a textarea`);
  check(controls['.sw-add'], `${theme}: .sw-add is missing`);
  checkEqual(controls['.sw-add'].tag, 'button', `${theme}: .sw-add must be a button`);

  for (const selector of ['.sw-key', '.sw-at', '.sw-msg']) {
    const control = controls[selector];
    check(control.width > 20 && control.height > 20, `${theme}: ${selector} is not visibly sized`, control);
    const radius = parsePx(control.borderRadius);
    const paddingTop = parsePx(control.paddingTop);
    const paddingBottom = parsePx(control.paddingBottom);
    const luminance = colorLuminance(control.background);
    const surfaceOk = isTransparentColor(control.background)
      || (theme === 'dark' ? luminance !== null && luminance < 0.35 : luminance !== null && luminance > 0.62);
    const fontOk = /system-ui|Noto Sans|PingFang|Microsoft YaHei|sans-serif/i.test(control.fontFamily);
    check(radius >= 6, `${theme}: ${selector} computed border-radius is ${control.borderRadius}, expected >= 6px (still barebones?)`, control);
    check(
      paddingTop >= 6 && paddingBottom >= 6,
      `${theme}: ${selector} computed vertical padding is too small (${control.paddingTop}/${control.paddingBottom})`,
      control,
    );
    check(surfaceOk, `${theme}: ${selector} background ${control.background} does not fit the ${theme} theme surface`, control);
    check(fontOk, `${theme}: ${selector} does not use the system sans font stack`, control);
  }

  const add = controls['.sw-add'];
  const addRadius = parsePx(add.borderRadius);
  const addPaddingX = parsePx(add.paddingLeft) + parsePx(add.paddingRight);
  const addBg = String(add.background || '');
  const defaultButtonBg = /rgba?\(\s*239\s*,\s*239\s*,\s*239/i.test(addBg)
    || (theme === 'dark' && /rgba?\(\s*255\s*,\s*255\s*,\s*255/i.test(addBg));
  const addAccent = expected.accentPattern.test(String(add.borderTopColor || ''))
    || expected.accentPattern.test(String(add.boxShadow || ''));
  const buttonSignals = [
    addRadius >= 8,
    addPaddingX >= 20,
    !defaultButtonBg && !isTransparentColor(addBg),
    addAccent || (add.boxShadow && add.boxShadow !== 'none'),
  ];
  const buttonSignalCount = buttonSignals.filter(Boolean).length;
  check(
    buttonSignalCount >= 3,
    `${theme}: .sw-add still looks like a bare UA button (signals ${JSON.stringify(buttonSignals)})`,
    { add, buttonSignals },
  );

  const styledSurfaces = report.candidates.filter((surface) => {
    const backgroundVisible = surface.background
      && surface.background !== 'rgba(0, 0, 0, 0)'
      && surface.background !== 'transparent';
    const exactElevated = expected.elevated.includes(surface.background);
    return (surface.radius >= 10 && backgroundVisible)
      || (surface.shadow && surface.shadow !== 'none')
      || exactElevated;
  });
  check(
    styledSurfaces.length >= 2,
    `${theme}: expected at least two styled card/section surfaces; found ${styledSurfaces.length}`,
    { styledSurfaces, candidates: report.candidates.slice(0, 20) },
  );

  const largeRounded = report.candidates.filter((surface) => surface.radius >= 10);
  const shadowed = report.candidates.filter((surface) => surface.shadow && surface.shadow !== 'none');
  const accentUsed = report.colors.some((color) => expected.accentPattern.test(color));
  const layoutPresent = report.grids.some(
    (grid) => (grid.display === 'grid' || (grid.display === 'flex' && grid.flexDirection === 'row'))
      && parsePx(grid.gap) >= 8
      && grid.width >= 600
      && grid.childCount >= 2,
  );
  check(layoutPresent, `${theme}: no wide grid/row-flex layout with a visible gap was found`, {
    grids: report.grids.slice(0, 20),
  });

  const aestheticSignals = [largeRounded.length > 0, shadowed.length > 0, accentUsed];
  check(
    aestheticSignals.filter(Boolean).length >= 1,
    `${theme}: no accent color, no shadow, and no >=10px rounded card surface found (design CSS may not be applied)`,
    { accentUsed, largeRounded: largeRounded.slice(0, 10), shadowed: shadowed.slice(0, 10) },
  );

  return {
    theme,
    bodyBackground: report.bodyBackground,
    bodyColor: report.bodyColor,
    stylesheetLoaded,
    controlsStyled: true,
    buttonSignals,
    styledSurfaces: styledSurfaces.length,
    largeRounded: largeRounded.length,
    shadowed: shadowed.length,
    accentUsed,
    layoutPresent,
    wideLayouts: report.grids
      .filter((grid) => grid.width >= 600 && grid.height >= 200 && grid.childCount >= 2)
      .slice(0, 5),
  };
}

async function findRoleFilter(page, name) {
  for (const role of ['tab', 'button', 'radio', 'link']) {
    const exact = page.getByRole(role, { name, exact: true });
    if (await exact.count()) return { role, locator: exact.first() };
    const prefixed = page.getByRole(role, { name: new RegExp(`^${escapeRegExp(name)}(?:\\s|（|\\(|$)`) });
    if (await prefixed.count()) return { role, locator: prefixed.first() };
  }
  return null;
}

const tests = [];
function registerTest(name, fn) {
  tests.push({ name, fn });
}

registerTest('activation + synchronous mount + Chinese page shell', async (suite) => (
  withPage(suite, 'activation-mount', {}, async ({ page }) => {
    const info = await page.evaluate(() => {
      const testHost = window.testHost;
      const root = document.querySelector('#mount');
      const text = root ? root.innerText : '';
      const cjk = text.match(/[\u4e00-\u9fff]/g) || [];
      return {
        fatal: testHost.fatal,
        mountError: testHost.mountError,
        registerPageCalls: testHost.state.calls.registerPage,
        invalidateCalls: testHost.state.calls.invalidate,
        pageCount: testHost.pages.length,
        pageId: testHost.pages[0] && testHost.pages[0].id,
        pageLabel: testHost.pages[0] && testHost.pages[0].label,
        activationDisposeType: typeof testHost.activationDispose,
        mountCount: testHost.state.mountCount,
        mounted: testHost.state.mounted,
        rowsExists: Boolean(document.querySelector('.sw-rows')),
        keyExists: Boolean(document.querySelector('.sw-key')),
        addExists: Boolean(document.querySelector('.sw-add')),
        text,
        cjkTotal: cjk.length,
        cjkDistinct: new Set(cjk).size,
        unexpectedMethods: testHost.state.unexpectedMethods.slice(),
      };
    });

    check(!info.fatal, 'Fixture reported a plugin initialization fatal', info.fatal);
    check(!info.mountError, 'page.mount(container, ctx) failed', info.mountError);
    check(info.registerPageCalls >= 1, 'activate(host) did not call host.ui.registerPage()', info);
    checkEqual(info.pageCount, 1, 'Expected exactly one registered page');
    checkEqual(info.pageId, 'session-wakes', 'Registered page id must be session-wakes');
    checkEqual(info.activationDisposeType, 'function', 'activate(host) must return a retained disposer');
    check(info.mountCount >= 1 && info.mounted, 'mount(container, ctx) was not invoked or did not remain mounted', info);
    check(info.rowsExists, '.sw-rows queue area is missing after mount');
    check(info.keyExists, '.sw-key select is missing after mount');
    check(info.addExists, '.sw-add button is missing after mount');
    check(info.text.includes('Session Wakes'), 'Product name "Session Wakes" is not visible', { text: info.text.slice(0, 500) });
    check(
      info.cjkTotal >= 6 && info.cjkDistinct >= 4,
      'Page does not look localized to Chinese (too few CJK characters)',
      { cjkTotal: info.cjkTotal, cjkDistinct: info.cjkDistinct, text: info.text.slice(0, 500) },
    );
    checkEqual(info.unexpectedMethods.length, 0, 'Fixture received unexpected host methods', info.unexpectedMethods);

    return { ...info, text: info.text.slice(0, 300) };
  })
));

registerTest('visual baselines: dark/light desktop, 390px, empty state', async (suite) => {
  const screenshots = [];

  async function capture(name, file, options, assertPage) {
    const result = await withPage(suite, `screenshot-${name}`, { ...options, screenshotOnFailure: false }, async ({ page }) => {
      await page.evaluate(() => document.fonts.ready);
      if (assertPage) await assertPage(page);
      await page.waitForTimeout(100);
      const target = path.join(artifactDir, file);
      await page.screenshot({ path: target, fullPage: true });
      const fileStat = await stat(target);
      check(fileStat.size > 0, `Screenshot ${file} is empty`);
      const pageSize = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        scrollHeight: document.documentElement.scrollHeight,
      }));
      return { name, file: target, bytes: fileStat.size, ...pageSize };
    });
    screenshots.push(result);
    return result;
  }

  await capture('dark-desktop', '01-dark-desktop.png', { theme: 'dark' }, async (page) => {
    const text = await mountText(page);
    check(text.includes('YOUR-PENDING-MESSAGE-HERE-1'), 'Populated dark screenshot has no queue rows', { text });
  });
  await capture('light-desktop', '02-light-desktop.png', { theme: 'light' }, async (page) => {
    const text = await mountText(page);
    check(text.includes('YOUR-PENDING-MESSAGE-HERE-1'), 'Populated light screenshot has no queue rows', { text });
  });
  await capture('narrow-390', '03-narrow-390.png', { theme: 'dark', viewport: { width: 390, height: 844 } }, async (page) => {
    const text = await mountText(page);
    check(text.includes('YOUR-PENDING-MESSAGE-HERE-1'), 'Populated narrow screenshot has no queue rows', { text });
  });
  await capture('empty-dark', '04-empty-dark.png', { theme: 'dark', query: { empty: '1' } }, async (page) => {
    const text = await mountText(page);
    check(!text.includes('YOUR-PENDING-MESSAGE-HERE-1'), 'Empty fixture unexpectedly rendered queue rows', { text });
  });
  await capture('narrow-390-long', '05-narrow-390-long.png', {
    theme: 'dark',
    viewport: { width: 390, height: 844 },
    query: { long: '1' },
  }, async (page) => {
    const text = await page.evaluate(() => document.querySelector('#mount').textContent || '');
    check(text.includes('YOUR-LONG-MESSAGE-HERE'), 'Long-content narrow screenshot has no long queue message', { text: text.slice(0, 500) });
  });

  return { screenshots };
});

registerTest('computed styles from main.css (dark + light, not string snapshots)', async (suite) => {
  const evidence = [];
  for (const theme of ['dark', 'light']) {
    const result = await withPage(suite, `styles-${theme}`, { theme }, async ({ page }) => {
      const report = await collectStyleReport(page);
      return assertThemeAndDesign(theme, report);
    });
    evidence.push(result);
  }
  return { themes: evidence };
});

registerTest('title, connection status, default message 继续', async (suite) => (
  withPage(suite, 'title-connection', {}, async ({ page }) => {
    const initial = await page.evaluate(() => {
      const root = document.querySelector('#mount');
      const textarea = document.querySelector('.sw-msg');
      const headings = [...root.querySelectorAll('h1, h2, h3, h4, [role="heading"]')]
        .map((node) => node.textContent.trim())
        .filter(Boolean);
      return { headings, text: root.innerText, defaultMessage: textarea ? textarea.value : null };
    });

    check(
      initial.headings.some((heading) => /Session Wakes/i.test(heading)) || /Session Wakes/i.test(initial.text),
      'Product heading "Session Wakes" is missing',
      { headings: initial.headings, text: initial.text.slice(0, 500) },
    );
    checkEqual(initial.defaultMessage, '继续', 'Message textarea must default to 继续');
    const connectedText = await statusText(page);
    check(
      /已连接|连接正常|在线|connected/i.test(connectedText),
      'Connected state is not visible in the page status text',
      { connectedText: connectedText.slice(0, 500) },
    );

    await page.evaluate(() => window.testHost.setConnection(false));
    await triggerPoll(page);
    const offlineText = await statusText(page);
    check(
      /未连接|离线|断开|offline|disconnected/i.test(offlineText),
      'Disconnected state is not visible after host.connection.connected=false',
      { offlineText: offlineText.slice(0, 500) },
    );

    return {
      headings: initial.headings,
      defaultMessage: initial.defaultMessage,
      connectedText: connectedText.slice(0, 200),
      offlineText: offlineText.slice(0, 200),
    };
  })
));

registerTest('friendly session titles + full key in create payload', async (suite) => (
  withPage(suite, 'session-options', {}, async ({ page }) => {
    const fixture = await page.evaluate(() => ({
      rows: window.testHost.state.sessions.rows.map((row) => ({ ...row })),
      options: [...document.querySelectorAll('.sw-key option')].map((option) => ({
        value: option.value,
        text: (option.textContent || '').trim(),
        title: option.title,
        disabled: option.disabled,
      })),
    }));

    const sessionOptions = fixture.options.filter((option) => option.value.startsWith('agent:'));
    checkEqual(sessionOptions.length, fixture.rows.length, 'Session option count does not match host.sessions.rows', fixture);
    for (const row of fixture.rows) {
      const option = sessionOptions.find((candidate) => candidate.value === row.key);
      check(option, `Full session key is not used as an option value: ${row.key}`, { sessionOptions });
      check(option.text, `Session option for ${row.key} has no friendly label`, option);
      check(option.text !== row.key, `Session option label leaks the raw full key instead of a friendly title`, option);
      check(
        option.text.includes(row.displayName),
        `Session option label does not include the friendly displayName (${row.displayName})`,
        { option, displayName: row.displayName },
      );
      checkEqual(option.title, row.key, 'Session option title attribute must retain the full key', option);
    }

    const firstRow = fixture.rows[0];
    await selectSession(page, firstRow.key);
    await page.locator('.sw-msg').fill('YOUR-MESSAGE-HERE-PAYLOAD');
    await page.evaluate(() => { window.testHost.state.delays.create = 60; });
    await page.locator('.sw-add').click();
    await page.waitForFunction(() => window.testHost.state.calls.createCompleted >= 1);
    await page.waitForTimeout(120);

    const calls = await page.evaluate(() => ({
      create: window.testHost.state.calls.create,
      params: window.testHost.state.lastCreateParams,
      wake: window.testHost.state.lastCreatedWake,
      unexpected: window.testHost.state.unexpectedMethods.slice(),
    }));
    checkEqual(calls.create, 1, 'One click must submit exactly one create request');
    checkEqual(calls.params.key, firstRow.key, 'Create payload did not preserve the full session key');
    checkEqual(calls.params.message, 'YOUR-MESSAGE-HERE-PAYLOAD', 'Create payload message mismatch');
    check(
      !('deliverAt' in calls.params) || calls.params.deliverAt == null || calls.params.deliverAt === '',
      'Immediate create must omit/empty deliverAt',
      calls.params,
    );
    checkEqual(calls.wake.status, 'pending', 'Created wake should be pending in the mock');
    checkEqual(calls.unexpected.length, 0, 'Unexpected host methods were called', calls.unexpected);

    return { sessionOptions: sessionOptions.length, createParams: calls.params };
  })
));

registerTest('selection and typed fields survive 20s poll refresh', async (suite) => (
  withPage(suite, 'refresh-survival', {}, async ({ page }) => {
    const rows = await page.evaluate(() => window.testHost.state.sessions.rows.map((row) => ({ ...row })));
    const selected = rows[2];
    const message = 'YOUR-MESSAGE-HERE-REFRESH';
    const localTime = await localDateTimeInPage(page, 90 * 60 * 1000);
    await selectSession(page, selected.key);
    await page.locator('.sw-msg').fill(message);
    await page.locator('.sw-at').fill(localTime);

    await page.evaluate(() => {
      window.__fixtureShortTimer = false;
      setTimeout(() => { window.__fixtureShortTimer = true; }, 25);
    });
    await page.waitForFunction(() => window.__fixtureShortTimer === true);

    const before = await page.evaluate(() => ({
      create: window.testHost.state.calls.create,
      delete: window.testHost.state.calls.delete,
      list: window.testHost.state.calls.list,
      poll: window.testHost.getLatestPoll(),
    }));
    check(
      before.poll && before.poll.delay === 20000,
      'Self-chained polling must use a 20s timeout',
      { poll: before.poll },
    );
    await triggerPoll(page);
    await page.waitForTimeout(80);

    const after = await page.evaluate(() => ({
      selected: document.querySelector('.sw-key').value,
      message: document.querySelector('.sw-msg').value,
      at: document.querySelector('.sw-at').value,
      create: window.testHost.state.calls.create,
      delete: window.testHost.state.calls.delete,
      list: window.testHost.state.calls.list,
      queueText: document.querySelector('.sw-rows').innerText,
    }));

    checkEqual(after.selected, selected.key, 'Selected session was reset by the poll refresh');
    checkEqual(after.message, message, 'Typed message was reset by the poll refresh');
    checkEqual(after.at, localTime, 'Typed datetime-local value was reset by the poll refresh');
    checkEqual(after.create, before.create, 'A poll refresh unexpectedly submitted a create request');
    checkEqual(after.delete, before.delete, 'A poll refresh unexpectedly submitted a delete request');
    check(after.list > before.list, 'triggerPoll() did not cause a list refresh');
    check(after.queueText.includes('YOUR-PENDING-MESSAGE-HERE-1'), 'Queue was not reloaded by the poll refresh');

    return { selected: after.selected, message: after.message, at: after.at, listCallsBefore: before.list, listCallsAfter: after.list };
  })
));

registerTest('immediate create: exactly one request, no deliverAt', async (suite) => (
  withPage(suite, 'immediate-create', {}, async ({ page }) => {
    const rows = await page.evaluate(() => window.testHost.state.sessions.rows.map((row) => ({ ...row })));
    const initialLength = await page.evaluate(() => window.testHost.state.wakes.length);
    await selectSession(page, rows[0].key);
    await page.locator('.sw-at').fill('');
    await page.locator('.sw-msg').fill('YOUR-MESSAGE-HERE-IMMEDIATE');
    await page.evaluate(() => { window.testHost.state.delays.create = 140; });

    await page.locator('.sw-add').click();
    await page.waitForFunction(() => window.testHost.state.calls.createCompleted >= 1);
    await page.waitForTimeout(220);

    const result = await page.evaluate(() => ({
      calls: window.testHost.state.calls.create,
      params: window.testHost.state.lastCreateParams,
      wake: window.testHost.state.lastCreatedWake,
      wakesLength: window.testHost.state.wakes.length,
      createdIds: window.testHost.state.createdIds.slice(),
      queueText: document.querySelector('.sw-rows').innerText,
    }));

    checkEqual(result.calls, 1, 'Delayed immediate create was submitted more than once');
    checkEqual(result.params.key, rows[0].key, 'Immediate create used the wrong full session key');
    checkEqual(result.params.message, 'YOUR-MESSAGE-HERE-IMMEDIATE', 'Immediate create message mismatch');
    check(
      !('deliverAt' in result.params) || result.params.deliverAt == null || result.params.deliverAt === '',
      'Immediate create must not send a deliverAt value',
      result.params,
    );
    checkEqual(result.wakesLength, initialLength + 1, 'Mock wake state did not gain exactly one wake');
    checkEqual(result.createdIds.length, 1, 'Mock recorded an unexpected number of created wakes');
    checkEqual(result.wake.status, 'pending', 'New wake should be pending');
    check(result.queueText.includes('YOUR-MESSAGE-HERE-IMMEDIATE'), 'Newly created wake is not visible in the queue', {
      queueText: result.queueText.slice(0, 800),
    });

    return { createCalls: result.calls, params: result.params, wakesLength: result.wakesLength };
  })
));

registerTest('scheduled create: ISO deliverAt, exactly one delayed request', async (suite) => (
  withPage(suite, 'scheduled-create', {}, async ({ page }) => {
    const rows = await page.evaluate(() => window.testHost.state.sessions.rows.map((row) => ({ ...row })));
    const initialLength = await page.evaluate(() => window.testHost.state.wakes.length);
    const localTime = await localDateTimeInPage(page, 45 * 60 * 1000);
    const expectedIso = await page.evaluate((value) => new Date(value).toISOString(), localTime);

    await selectSession(page, rows[1].key);
    await page.locator('.sw-at').fill(localTime);
    await page.locator('.sw-msg').fill('YOUR-MESSAGE-HERE-SCHEDULED');
    await page.evaluate(() => { window.testHost.state.delays.create = 170; });

    await page.locator('.sw-add').click();
    await page.waitForFunction(() => window.testHost.state.calls.createCompleted >= 1);
    await page.waitForTimeout(240);

    const result = await page.evaluate(() => ({
      calls: window.testHost.state.calls.create,
      params: window.testHost.state.lastCreateParams,
      wake: window.testHost.state.lastCreatedWake,
      wakesLength: window.testHost.state.wakes.length,
      queueText: document.querySelector('.sw-rows').innerText,
    }));

    checkEqual(result.calls, 1, 'Delayed scheduled create was submitted more than once');
    checkEqual(result.params.key, rows[1].key, 'Scheduled create used the wrong full session key');
    checkEqual(result.params.deliverAt, expectedIso, 'Scheduled create deliverAt is not the expected ISO timestamp');
    checkEqual(new Date(result.params.deliverAt).toISOString(), result.params.deliverAt, 'deliverAt must be an ISO string');
    checkEqual(result.wakesLength, initialLength + 1, 'Mock wake state did not gain exactly one scheduled wake');
    checkEqual(result.wake.deliverAt, expectedIso, 'Mock wake did not retain the scheduled ISO time');
    check(result.queueText.includes('YOUR-MESSAGE-HERE-SCHEDULED'), 'Scheduled wake is not visible in the queue', {
      queueText: result.queueText.slice(0, 800),
    });

    return { createCalls: result.calls, localTime, expectedIso, params: result.params };
  })
));

registerTest('queue filters 全部/待唤醒/已投递/失败 by semantic role', async (suite) => (
  withPage(suite, 'queue-filters', {}, async ({ page }) => {
    const names = ['全部', '待唤醒', '已投递', '失败'];
    const found = {};
    const missing = [];
    for (const name of names) {
      const match = await findRoleFilter(page, name);
      if (match) found[name] = match;
      else missing.push(name);
    }
    if (missing.length > 0) {
      throw new SkipTest(
        'Filter controls were not identifiable by semantic role (tab/button/radio/link)',
        { missing, found: Object.keys(found) },
      );
    }

    const visibleTokens = {
      pending1: 'YOUR-PENDING-MESSAGE-HERE-1',
      pending2: 'YOUR-PENDING-MESSAGE-HERE-2',
      fired: 'YOUR-FIRED-MESSAGE-HERE',
      failed: 'YOUR-FAILED-MESSAGE-HERE',
    };
    const expectations = {
      '全部': { visible: Object.values(visibleTokens), hidden: [] },
      '待唤醒': { visible: [visibleTokens.pending1, visibleTokens.pending2], hidden: [visibleTokens.fired, visibleTokens.failed] },
      '已投递': { visible: [visibleTokens.fired], hidden: [visibleTokens.pending1, visibleTokens.pending2, visibleTokens.failed] },
      '失败': { visible: [visibleTokens.failed], hidden: [visibleTokens.pending1, visibleTokens.pending2, visibleTokens.fired] },
    };

    const evidence = [];
    for (const name of names) {
      await found[name].locator.click();
      await page.waitForTimeout(160);
      const rowsText = await page.locator('.sw-rows').innerText();
      const expectation = expectations[name];
      for (const token of expectation.visible) {
        check(rowsText.includes(token), `Filter "${name}" did not show expected row ${token}`, {
          filter: name,
          role: found[name].role,
          rowsText: rowsText.slice(0, 1000),
        });
      }
      for (const token of expectation.hidden) {
        check(!rowsText.includes(token), `Filter "${name}" still shows non-matching row ${token}`, {
          filter: name,
          role: found[name].role,
          rowsText: rowsText.slice(0, 1000),
        });
      }
      evidence.push({ name, role: found[name].role, text: rowsText.slice(0, 400) });
    }

    return { filters: evidence };
  })
));

registerTest('list error keeps stale queue, then recovers; empty state', async (suite) => (
  withPage(suite, 'error-recovery', {}, async ({ page }) => {
    const baseline = await page.evaluate(() => ({
      completed: window.testHost.state.calls.listCompleted,
      failed: window.testHost.state.calls.listFailed,
      wakes: window.testHost.state.wakes.length,
    }));

    await page.evaluate(() => {
      window.testHost.state.errors.list = 1;
      window.testHost.state.delays.list = 60;
    });
    await page.evaluate(() => window.testHost.triggerPoll());
    await page.waitForFunction(
      (failed) => window.testHost.state.calls.listFailed >= failed,
      baseline.failed + 1,
    );
    await page.waitForTimeout(80);

    const failureView = await page.evaluate(() => ({
      mountText: document.querySelector('#mount').innerText,
      bodyText: document.body.innerText,
      queueText: document.querySelector('.sw-rows').innerText,
      wakesLength: window.testHost.state.wakes.length,
    }));
    check(failureView.queueText.includes('YOUR-PENDING-MESSAGE-HERE-1'), 'List error cleared the stale queue', {
      queueText: failureView.queueText.slice(0, 1000),
    });
    checkEqual(failureView.wakesLength, baseline.wakes, 'List error changed the mock data unexpectedly');
    const errorSurfaced = /YOUR-LIST-ERROR-HERE|加载失败|读取失败|刷新失败|无法加载|出错了|error/i.test(
      `${failureView.mountText}\n${failureView.bodyText}`,
    );
    check(errorSurfaced, 'List error was swallowed; no visible error indicator was found', {
      mountText: failureView.mountText.slice(0, 1000),
    });

    await page.evaluate(() => { window.testHost.state.errors.list = 0; });
    await page.evaluate(() => window.testHost.triggerPoll());
    await page.waitForFunction(
      (completed) => window.testHost.state.calls.listCompleted >= completed,
      baseline.completed + 1,
    );
    await page.waitForTimeout(100);

    const recovered = await page.evaluate(() => ({
      mountText: document.querySelector('#mount').innerText,
      queueText: document.querySelector('.sw-rows').innerText,
    }));
    check(
      !/YOUR-LIST-ERROR-HERE|加载失败|读取失败|刷新失败|无法加载/.test(recovered.mountText),
      'List error indicator did not clear after a successful refresh',
      { mountText: recovered.mountText.slice(0, 1000) },
    );
    for (const token of ['YOUR-PENDING-MESSAGE-HERE-1', 'YOUR-FIRED-MESSAGE-HERE', 'YOUR-FAILED-MESSAGE-HERE']) {
      check(recovered.queueText.includes(token), `Queue data missing after recovery: ${token}`, {
        queueText: recovered.queueText.slice(0, 1000),
      });
    }

    await page.evaluate(() => { window.testHost.state.wakes = []; });
    await page.evaluate(() => window.testHost.triggerPoll());
    await page.waitForFunction(
      (completed) => window.testHost.state.calls.listCompleted >= completed,
      baseline.completed + 2,
    );
    await page.waitForTimeout(80);
    // A redesigned empty state may deliberately omit the row list itself; use
    // the whole page region for this check instead of assuming .sw-rows exists
    // when there are zero rows.
    const emptyText = await mountText(page);
    check(!/YOUR-PENDING-MESSAGE-HERE-1|YOUR-FIRED-MESSAGE-HERE|YOUR-FAILED-MESSAGE-HERE/.test(emptyText), 'Empty queue still shows stale rows', {
      emptyText: emptyText.slice(0, 1000),
    });
    check(/暂无|没有|还没有|空|No wakes|Nothing|empty/i.test(emptyText), 'Empty queue has no recognizable empty-state text', {
      emptyText: emptyText.slice(0, 1000),
    });

    return {
      failureQueueText: failureView.queueText.slice(0, 300),
      recoveredQueueText: recovered.queueText.slice(0, 300),
      emptyText: emptyText.slice(0, 300),
    };
  })
));

registerTest('delete failure surfaced; successful delete mutates mock state', async (suite) => (
  withPage(suite, 'delete-flow', {}, async ({ page }) => {
    const initial = await page.evaluate(() => ({
      wakes: window.testHost.state.wakes.map((wake) => ({ ...wake })),
      deleteButtons: document.querySelectorAll('.sw-rows [role="button"], .sw-rows button').length,
    }));
    const queueButtons = page.locator('.sw-rows').getByRole('button', { name: /删除|delete/i });
    const buttonCount = await queueButtons.count();
    check(buttonCount > 0, 'No queue button with an accessible name containing 删除 or delete was found', {
      initial,
    });

    await page.evaluate(() => {
      window.testHost.state.errors.delete = 1;
      window.testHost.state.delays.delete = 60;
    });
    await queueButtons.first().click();
    await page.waitForFunction(() => window.testHost.state.calls.deleteFailed >= 1);
    await page.waitForTimeout(100);

    const failed = await page.evaluate(() => ({
      wakes: window.testHost.state.wakes.map((wake) => ({ ...wake })),
      lastDeleteParams: window.testHost.state.lastDeleteParams,
      mountText: document.querySelector('#mount').innerText,
      buttons: document.querySelectorAll('.sw-rows [role="button"], .sw-rows button').length,
    }));
    check(failed.lastDeleteParams && failed.lastDeleteParams.id, 'Delete request did not include an id', failed);
    const failedId = failed.lastDeleteParams.id;
    checkEqual(failed.wakes.length, initial.wakes.length, 'Failed delete changed the mock wake list');
    check(failed.wakes.some((wake) => wake.id === failedId), 'Failed delete removed the wake from the mock');
    const deleteErrorSurfaced = /YOUR-DELETE-ERROR-HERE|删除失败|无法删除|操作失败|delete failed|failed to delete/i.test(failed.mountText);
    check(deleteErrorSurfaced, 'Delete failure was swallowed; no visible error text was found', {
      mountText: failed.mountText.slice(0, 1000),
    });
    check(failed.buttons >= 1, 'Queue rows disappeared after a failed delete', { buttons: failed.buttons });

    await page.evaluate(() => { window.testHost.state.errors.delete = 0; });
    await page.locator('.sw-rows').getByRole('button', { name: /删除|delete/i }).first().click();
    await page.waitForFunction(() => window.testHost.state.calls.deleteCompleted >= 1);
    await page.waitForTimeout(160);

    const succeeded = await page.evaluate(() => ({
      wakes: window.testHost.state.wakes.map((wake) => ({ ...wake })),
      deletedIds: window.testHost.state.deletedIds.slice(),
      buttons: document.querySelectorAll('.sw-rows [role="button"], .sw-rows button').length,
    }));
    checkEqual(succeeded.wakes.length, initial.wakes.length - 1, 'Successful delete did not remove exactly one wake from the mock');
    check(!succeeded.wakes.some((wake) => wake.id === failedId), 'Successfully deleted wake is still present in the mock');
    check(succeeded.deletedIds.includes(failedId), 'Successful delete did not record the removed id');
    check(succeeded.buttons < buttonCount, 'Queue did not shrink after a successful delete', {
      before: buttonCount,
      after: succeeded.buttons,
    });

    return {
      failedId,
      beforeCount: initial.wakes.length,
      afterCount: succeeded.wakes.length,
      buttonsBefore: buttonCount,
      buttonsAfter: succeeded.buttons,
    };
  })
));

registerTest('disconnected host disables create and blocks submission', async (suite) => (
  withPage(suite, 'disconnected', { manual: true, query: { connected: '0' }, waitForList: false }, async ({ page }) => {
    await mountManual(page);
    const rows = await page.evaluate(() => window.testHost.state.sessions.rows.map((row) => ({ ...row })));
    const add = page.locator('.sw-add');
    const disabled = await add.isDisabled();
    const ariaDisabled = await add.getAttribute('aria-disabled');
    check(disabled || ariaDisabled === 'true', 'Create button is not disabled while disconnected', { disabled, ariaDisabled });

    const offline = await statusText(page);
    check(/未连接|离线|断开|offline|disconnected/i.test(offline), 'Offline status is not visible in the disconnected state', {
      offlineText: offline.slice(0, 500),
    });

    await selectSession(page, rows[0].key);
    await page.locator('.sw-msg').fill('YOUR-MESSAGE-HERE-OFFLINE');
    await page.locator('.sw-add').evaluate((element) => element.click());
    await page.waitForTimeout(160);
    checkEqual(
      await page.evaluate(() => window.testHost.state.calls.create),
      0,
      'Programmatic click while disconnected still submitted a create request',
    );

    await page.evaluate(() => window.testHost.setConnection(true));
    await triggerPoll(page);
    await page.waitForFunction(() => {
      const element = document.querySelector('.sw-add');
      return Boolean(element) && !element.disabled && element.getAttribute('aria-disabled') !== 'true';
    });
    await page.locator('.sw-add').click();
    await page.waitForFunction(() => window.testHost.state.calls.createCompleted >= 1);
    checkEqual(
      await page.evaluate(() => window.testHost.state.calls.create),
      1,
      'Create did not recover after reconnecting',
    );

    return { disabled, ariaDisabled, offlineText: offline.slice(0, 200) };
  })
));

registerTest('HTML-like session/message text is escaped, no markup executed', async (suite) => (
  withPage(suite, 'xss-safety', { manual: true, query: { xss: '1' }, waitForList: false }, async ({ page }) => {
    await mountManual(page);
    const result = await page.evaluate(() => {
      const root = document.querySelector('#mount');
      return {
        sentinel: window.__SW_XSS__,
        images: root.querySelectorAll('img').length,
        scripts: root.querySelectorAll('script').length,
        onerrorElements: root.querySelectorAll('[onerror]').length,
        queueText: document.querySelector('.sw-rows').textContent || '',
        options: [...document.querySelectorAll('.sw-key option')].map((option) => option.textContent || ''),
        mountText: root.innerText,
      };
    });

    checkEqual(result.sentinel, undefined, 'HTML-like fixture text executed script (window.__SW_XSS__ was set)');
    checkEqual(result.images, 0, 'HTML-like text created an <img> element inside the page');
    checkEqual(result.scripts, 0, 'HTML-like text created a <script> element inside the page');
    checkEqual(result.onerrorElements, 0, 'HTML-like text created an element with an inline onerror attribute');
    check(result.queueText.includes('<img'), 'Queue message text is missing the literal escaped markup', {
      queueText: result.queueText.slice(0, 800),
    });
    check(result.options.some((text) => text.includes('<img')), 'Session option text is missing the literal escaped markup', {
      options: result.options,
    });

    return {
      sentinel: result.sentinel,
      images: result.images,
      scripts: result.scripts,
      onerrorElements: result.onerrorElements,
      queueText: result.queueText.slice(0, 300),
    };
  })
));

registerTest('dispose cancels polling and prevents stale async writes', async (suite) => (
  withPage(suite, 'dispose-timer', {}, async ({ page }) => {
    const before = await page.evaluate(() => ({
      list: window.testHost.state.calls.list,
      completed: window.testHost.state.calls.listCompleted,
      timers: window.testHost.getPollTimerCount(),
      disposeCount: window.testHost.state.disposeCount,
      abortCount: window.testHost.state.abortCount,
    }));
    check(before.timers >= 1, 'No captured 20s poll timer exists before dispose', before);

    const disposed = await page.evaluate(() => window.testHost.dispose());
    checkEqual(disposed, true, 'page dispose() did not report a disposed mount');
    const afterDispose = await page.evaluate(() => ({
      timers: window.testHost.getPollTimerCount(),
      mounted: window.testHost.state.mounted,
      disposeCount: window.testHost.state.disposeCount,
      abortCount: window.testHost.state.abortCount,
    }));
    checkEqual(afterDispose.timers, 0, 'Dispose did not clear the captured 20s poll timer');
    checkEqual(afterDispose.mounted, false, 'Dispose left the page marked as mounted');
    checkEqual(afterDispose.disposeCount, before.disposeCount + 1, 'Returned dispose handle was not invoked');
    checkEqual(afterDispose.abortCount, before.abortCount + 1, 'AbortSignal was not aborted on dispose');

    const triggeredAfterDispose = await page.evaluate(() => window.testHost.triggerPoll());
    checkEqual(triggeredAfterDispose, false, 'A poll could still be triggered after dispose');
    await sleep(120);
    checkEqual(
      await page.evaluate(() => window.testHost.state.calls.list),
      before.list,
      'List request was issued after dispose',
    );

    await page.evaluate(() => window.testHost.mount());
    await page.waitForFunction(
      (completed) => window.testHost.state.calls.listCompleted >= completed,
      before.completed + 1,
    );
    await page.waitForTimeout(40);

    await page.evaluate(() => {
      window.testHost.state.delays.list = 300;
      void window.testHost.triggerPoll();
    });
    await page.waitForFunction(() => window.testHost.state.calls.listInFlight === 1);
    const midFlight = await page.evaluate(() => {
      window.testHost.dispose();
      return {
        html: document.querySelector('#mount').innerHTML,
        timers: window.testHost.getPollTimerCount(),
        list: window.testHost.state.calls.list,
      };
    });
    checkEqual(midFlight.timers, 0, 'Dispose during an in-flight list did not clear timers');

    await sleep(520);
    const afterStale = await page.evaluate(() => ({
      html: document.querySelector('#mount').innerHTML,
      timers: window.testHost.getPollTimerCount(),
      inFlight: window.testHost.state.calls.listInFlight,
      triggered: false,
    }));
    checkEqual(afterStale.inFlight, 0, 'In-flight list request did not settle');
    checkEqual(afterStale.html, midFlight.html, 'Stale async list response wrote into the disposed page');
    checkEqual(afterStale.timers, 0, 'Poll timer was rescheduled after dispose');
    const postDisposeTrigger = await page.evaluate(() => window.testHost.triggerPoll());
    checkEqual(postDisposeTrigger, false, 'A poll could still be triggered after the second dispose');
    await sleep(100);
    checkEqual(
      await page.evaluate(() => window.testHost.state.calls.list),
      midFlight.list,
      'List request was issued after the second dispose',
    );

    return {
      timersBefore: before.timers,
      timersAfter: afterDispose.timers,
      htmlStable: afterStale.html === midFlight.html,
    };
  })
));

registerTest('390px viewport with long IDs/messages has no horizontal overflow', async (suite) => (
  withPage(suite, 'responsive-overflow', {
    theme: 'dark',
    viewport: { width: 390, height: 844 },
    query: { long: '1' },
  }, async ({ page }) => {
    const report = await page.evaluate(() => {
      const root = document.querySelector('#mount');
      const doc = document.documentElement;
      const offenders = [...root.querySelectorAll('*')]
        .filter((element) => {
          const rect = element.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0 && (rect.right > window.innerWidth + 1 || rect.left < -1);
        })
        .slice(0, 12)
        .map((element) => ({
          tag: element.tagName.toLowerCase(),
          cls: typeof element.className === 'string' ? element.className : '',
          right: Math.round(element.getBoundingClientRect().right),
          width: Math.round(element.getBoundingClientRect().width),
        }));
      return {
        innerWidth: window.innerWidth,
        clientWidth: doc.clientWidth,
        scrollWidth: doc.scrollWidth,
        bodyScrollWidth: document.body.scrollWidth,
        rootClientWidth: root.clientWidth,
        rootScrollWidth: root.scrollWidth,
        text: root.textContent || '',
        offenders,
      };
    });

    checkEqual(report.innerWidth, 390, 'Viewport is not 390px wide');
    check(
      report.scrollWidth <= report.clientWidth + 1,
      `Page has horizontal overflow at 390px: scrollWidth=${report.scrollWidth}, clientWidth=${report.clientWidth}`,
      report,
    );
    check(
      report.bodyScrollWidth <= report.innerWidth + 1,
      `Body has horizontal overflow at 390px: bodyScrollWidth=${report.bodyScrollWidth}`,
      report,
    );
    check(report.text.includes('YOUR-LONG-MESSAGE-HERE'), 'Long message fixture is missing from the rendered page');
    check(report.text.includes('YOUR-LONG-SESSION-NAME-HERE'), 'Long session name fixture is missing from the rendered page');

    return {
      innerWidth: report.innerWidth,
      scrollWidth: report.scrollWidth,
      bodyScrollWidth: report.bodyScrollWidth,
      rootClientWidth: report.rootClientWidth,
      rootScrollWidth: report.rootScrollWidth,
      offenders: report.offenders,
    };
  })
));

registerTest('native session action: right-click B never uses selected A', async (suite) => (
  withPage(suite, 'context-action', {}, async ({ page }) => {
    const r = await page.evaluate(async () => {
      const t = window.testHost;
      const a = t.actions.find(a => a.id === 'wake-settings');
      if (!a) throw new Error('Native session action not registered');
      const [first, second] = t.state.sessions.rows;
      t.host.sessions.selectedKey = first.key;
      const hidden = a.resolve({ sessionKey: 'not-a-session' }).hidden;
      await a.run({ sessionKey: second.key, session: second, host: t.host, signal: new AbortController().signal });
      const navigation = t.state.navigationCalls.at(-1);
      const beforeInvalid = t.state.navigationCalls.length;
      await a.run({ sessionKey: 'invalid' });
      const aborted = new AbortController(); aborted.abort();
      await a.run({ sessionKey: first.key, signal: aborted.signal });
      return { label: a.label, placement: a.placement, hidden, first: first.key, second: second.key, navigation,
        selected: document.querySelector('.sw-key').value, rows: document.querySelectorAll('.sw-row').length,
        allCount: document.querySelector('[data-filter="all"] .sw-filter-count').textContent,
        navigationUnchanged: beforeInvalid === t.state.navigationCalls.length,
        creates: t.state.calls.create, deletes: t.state.calls.delete };
    });
    checkEqual(r.label, '唤醒设置', 'Native action label');
    checkEqual(r.placement, 'session', 'Action must use native session menu');
    check(r.hidden && r.navigationUnchanged, 'Invalid/aborted actions must be inert', r);
    checkEqual(r.navigation.target.id, 'session-wakes', 'Correct plugin page target');
    checkEqual(r.navigation.target.params.sessionKey, r.second, 'Right-click B navigation target must remain B');
    checkEqual(r.selected, r.second, 'Composer must target B, not selected A');
    checkEqual(r.rows, 1, 'Scoped queue must exclude other sessions');
    checkEqual(r.allCount, '1', 'Scoped filter count must not count other sessions');
    checkEqual(r.creates + r.deletes, 0, 'Opening settings must not mutate any wakes');
    return r;
  })
));

registerTest('page props, same-page session changes and view-all remain coherent', async (suite) => (
  withPage(suite, 'context-scope', {}, async ({ page }) => {
    const keys = await page.evaluate(() => {
      const t = window.testHost; t.dispose();
      const keys = t.state.sessions.rows.map(r => r.key);
      t.mount({ sessionKey: keys[0] }); return keys;
    });
    await page.waitForFunction(() => window.testHost.state.calls.listInFlight === 0 && document.querySelectorAll('.sw-row').length === 1);
    checkEqual(await page.locator('.sw-key').inputValue(), keys[0], 'Initial mount must read context.props');
    const mounts = await page.evaluate(() => window.testHost.state.mountCount);
    await page.evaluate(key => window.testHost.updateProps({ sessionKey: key }), keys[1]);
    checkEqual(await page.locator('.sw-key').inputValue(), keys[1], 'Same-page update must select B');
    checkEqual(await page.locator('.sw-row').count(), 1, 'Same-page update keeps queue scoped');
    checkEqual(await page.evaluate(() => window.testHost.state.mountCount), mounts, 'Session update must not remount');
    await page.locator('.sw-key').selectOption(keys[0]);
    checkEqual(await page.evaluate(() => window.testHost.state.navigationCalls.at(-1).target.params.sessionKey), keys[0], 'Composer change updates scoped route');
    await page.getByRole('button', { name: '查看全部会话', exact: true }).click();
    checkEqual(await page.locator('.sw-row').count(), 4, 'View-all restores global queue');
    check(await page.locator('.sw-scope').isHidden(), 'View-all must hide session scope banner');
    checkEqual(await page.evaluate(() => window.testHost.state.calls.create + window.testHost.state.calls.delete), 0, 'Scope changes never mutate wakes');
    return { initialProps: true, samePageUpdate: true, viewAll: true };
  })
));

registerTest('unlisted targets, invalid props and action disposal are safe', async (suite) => (
  withPage(suite, 'context-safety', {}, async ({ page }) => {
    const key = 'agent:main:webchat:YOUR-UNLISTED-SESSION-HERE';
    await page.evaluate(key => window.testHost.updateProps({ sessionKey: key }), key);
    checkEqual(await page.locator('.sw-key').inputValue(), key, 'Unlisted full key must remain selected');
    checkEqual(await page.locator('.sw-row').count(), 0, 'Unlisted session cannot leak other queues');
    checkEqual(await page.locator('[data-filter="all"] .sw-filter-count').innerText(), '0', 'Unlisted session counts must be zero');
    await page.evaluate(() => window.testHost.updateProps({ sessionKey: '<img id="unsafe-context" src=x>' }));
    check(await page.locator('.sw-scope').isHidden(), 'Invalid query key must not become active scope');
    checkEqual(await page.locator('#unsafe-context').count(), 0, 'Query props must never inject markup');
    await page.evaluate(() => window.testHost.disposePlugin());
    checkEqual(await page.evaluate(() => window.testHost.actions.length), 0, 'Plugin disposal removes action');
    return { unlisted: true, invalidProps: true, disposed: true };
  })
));

registerTest('host display-contents mount preserves real vertical section spacing', async (suite) => (
  withPage(suite, 'host-layout-spacing', {}, async ({ page }) => {
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 900 });
      const report = await page.evaluate(() => {
        const mount = document.querySelector('#mount');
        const root = mount.querySelector('.sw-root');
        const header = root.querySelector('.sw-header').getBoundingClientRect();
        const metrics = root.querySelector('.sw-metrics').getBoundingClientRect();
        const layout = root.querySelector('.sw-layout').getBoundingClientRect();
        return { hostDisplay: getComputedStyle(mount).display, rootDisplay: getComputedStyle(root).display,
          separateRoot: root !== mount, headerGap: metrics.top - header.bottom,
          panelGap: layout.top - metrics.bottom, padding: parseFloat(getComputedStyle(root).paddingTop) };
      });
      checkEqual(report.hostDisplay, 'contents', 'Fixture must reproduce the real host mount');
      check(report.separateRoot && report.rootDisplay === 'grid', 'Layout must be plugin-owned', report);
      check(report.headerGap >= 16 && report.panelGap >= 16, 'Sections must not touch', report);
      check(report.padding >= 16, 'Page padding must survive host mount style', report);
    }
    return { desktopAndMobile: true, hostInlineDisplayContents: true };
  })
));

async function runSuite() {
  await mkdir(artifactDir, { recursive: true });
  const startedAt = new Date();
  const startedMs = Date.now();
  const results = [];
  const screenshots = [];
  let server = null;
  let browser = null;
  let browserVersion = null;
  let baseUrl = null;
  let setupFatal = null;

  try {
    const playwrightModule = await import(pathToFileURL(playwrightEntry).href);
    const chromium = playwrightModule.chromium || (playwrightModule.default && playwrightModule.default.chromium);
    if (!chromium) throw new Error('playwright module does not expose chromium');

    server = await startFixtureServer();
    const address = server.address();
    baseUrl = `http://127.0.0.1:${address.port}`;

    browser = await chromium.launch({
      executablePath: chromeBin,
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-dev-shm-usage',
        '--disable-background-networking',
        '--disable-component-update',
        '--disable-default-apps',
        '--disable-extensions',
        '--disable-sync',
        '--metrics-recording-only',
        '--no-first-run',
        '--safebrowsing-disable-auto-update',
      ],
    });
    browserVersion = browser.version();
    const suite = { browser, baseUrl, artifactDir };

    console.log('[ui-smoke] mode=offline-synthetic-fixture (NOT real lab E2E)');
    console.log(`[ui-smoke] fixture=${fixtureFile}`);
    console.log(`[ui-smoke] artifacts=${artifactDir}`);
    console.log(`[ui-smoke] chrome=${chromeBin} (${browserVersion})`);
    console.log(`[ui-smoke] loopback=${baseUrl}`);

    for (const test of tests) {
      const testStarted = Date.now();
      try {
        const details = await test.fn(suite);
        const durationMs = Date.now() - testStarted;
        results.push({ name: test.name, status: 'passed', durationMs, details });
        if (details && Array.isArray(details.screenshots)) {
          screenshots.push(...details.screenshots);
        }
        console.log(`[PASS] ${test.name} (${durationMs}ms)`);
      } catch (error) {
        const durationMs = Date.now() - testStarted;
        if (error instanceof SkipTest || error.skip === true) {
          results.push({
            name: test.name,
            status: 'skipped',
            durationMs,
            reason: error.message,
            details: error.evidence ?? null,
          });
          console.log(`[SKIP] ${test.name} (${durationMs}ms): ${error.message}`);
          continue;
        }
        results.push({
          name: test.name,
          status: 'failed',
          durationMs,
          error: {
            name: error && error.name ? error.name : 'Error',
            message: String(error && error.message != null ? error.message : error),
            stack: String(error && error.stack ? error.stack : ''),
            evidence: error && error.evidence !== undefined ? error.evidence : null,
            failureScreenshot: error && error.failureScreenshot ? error.failureScreenshot : null,
          },
        });
        console.log(`[FAIL] ${test.name} (${durationMs}ms)`);
        console.error(error && error.stack ? error.stack : String(error));
      }
    }
  } catch (error) {
    setupFatal = {
      name: error && error.name ? error.name : 'Error',
      message: String(error && error.message != null ? error.message : error),
      stack: String(error && error.stack ? error.stack : ''),
    };
    results.push({ name: 'suite setup', status: 'failed', durationMs: 0, error: setupFatal });
    console.error('[ui-smoke] suite setup failed');
    console.error(error && error.stack ? error.stack : String(error));
  } finally {
    if (browser) {
      try { await browser.close(); } catch (error) { console.error(`[ui-smoke] browser close failed: ${String(error)}`); }
    }
    try { await closeServer(server); } catch (error) { console.error(`[ui-smoke] server close failed: ${String(error)}`); }
  }

  const finishedAt = new Date();
  const summary = {
    total: results.length,
    passed: results.filter((result) => result.status === 'passed').length,
    failed: results.filter((result) => result.status === 'failed').length,
    skipped: results.filter((result) => result.status === 'skipped').length,
  };
  const payload = {
    suite: 'session-wakes-ui-smoke',
    mode: 'offline-synthetic-fixture',
    realLabE2E: false,
    note: 'Offline synthetic fixture QA; this is NOT a real lab/gateway E2E result.',
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: Date.now() - startedMs,
    environment: {
      node: process.version,
      platform: process.platform,
      playwrightModulePath: playwrightEntry,
      chromeBin,
      chromeVersion: browserVersion,
      artifactDir,
      fixture: fixtureFile,
      baseUrl,
    },
    summary,
    ok: summary.failed === 0,
    tests: results,
    screenshots,
  };

  const resultFile = path.join(artifactDir, 'result.json');
  await writeFile(resultFile, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  console.log(`[ui-smoke] summary total=${summary.total} passed=${summary.passed} failed=${summary.failed} skipped=${summary.skipped}`);
  console.log(`[ui-smoke] result=${resultFile}`);
  screenshots.forEach((shot) => console.log(`[ui-smoke] screenshot=${shot.file}`));
  if (summary.failed > 0) console.log('[ui-smoke] FAIL (offline synthetic checks only; no real API was called)');
  else console.log('[ui-smoke] PASS (offline synthetic checks only; no real API was called)');
  return summary.failed > 0 ? 1 : 0;
}

let exitCode = 1;
try {
  exitCode = await runSuite();
} catch (error) {
  console.error('[ui-smoke] fatal error');
  console.error(error && error.stack ? error.stack : String(error));
  exitCode = 1;
}
process.exit(exitCode);
