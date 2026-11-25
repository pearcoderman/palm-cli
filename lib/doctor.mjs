// `palm doctor`: what Palm's local tools need on this machine, and exactly how to install what's missing.
// Importable: `import { checks } from '@yuzool/palm/doctor'`.
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { rpc, readKey } from './client.mjs';

const OS = process.platform; // darwin, linux, win32
const how = (mac, linux, win) => (OS === 'darwin' ? mac : OS === 'win32' ? win : linux);
const onPath = (cmd, args = ['--version']) => { try { execFileSync(cmd, args, { stdio: 'ignore', timeout: 8000 }); return true; } catch { return false; } };

// The same lookup the Palm tools use (site-render.mjs findChrome).
export function findChrome() {
  const c = [process.env.PALM_CHROME, process.env.CHROME_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium',
    'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'];
  return c.find((x) => x && existsSync(x)) || '';
}
const hasModule = (name, cwd) => { for (const base of [process.env.PALM_NODE_MODULES, cwd].filter(Boolean)) { try { createRequire(join(base, 'x.js')).resolve(name); return true; } catch {} } return false; };

export async function checks({ cwd = process.cwd(), network = true } = {}) {
  const out = [];
  const add = (id, ok, need, detail, fix) => out.push({ id, ok, need, detail, fix: ok ? '' : fix });
  const major = Number(process.versions.node.split('.')[0]);
  add('node', major >= 18, 'all', `Node ${process.versions.node}`, how('brew install node', 'install Node 18+ from nodejs.org or your package manager', 'winget install OpenJS.NodeJS.LTS'));
  const chrome = findChrome();
  add('chrome', !!chrome, 'render and check tools (most of them), palm design, invoice and proposal PDFs', chrome || 'no Chrome, Edge or Chromium found', how('brew install --cask google-chrome   (or set PALM_CHROME to a Chromium-based browser)', 'sudo apt install chromium   (or set PALM_CHROME)', 'winget install Google.Chrome   (or set PALM_CHROME)'));
  add('puppeteer-core', hasModule('puppeteer-core', cwd), 'render and check tools, palm design, invoice and proposal PDFs', hasModule('puppeteer-core', cwd) ? 'installed here' : 'not installed in this project', 'npm i puppeteer-core   (or: palm setup)');
  add('jsqr', hasModule('jsqr', cwd), 'menu-check (QR codes)', hasModule('jsqr', cwd) ? 'installed here' : 'not installed in this project', 'npm i jsqr   (or: palm setup)');
  const ff = onPath('ffmpeg', ['-version']) && onPath('ffprobe', ['-version']);
  add('ffmpeg', ff, 'store-media, store-shots, video-check', ff ? 'ffmpeg and ffprobe found' : 'ffmpeg/ffprobe not found', how('brew install ffmpeg', 'sudo apt install ffmpeg', 'winget install Gyan.FFmpeg'));
  const pdf = ['gs', 'pdftoppm', 'mutool'].find((c) => onPath(c, c === 'gs' ? ['--version'] : c === 'pdftoppm' ? ['-v'] : ['-v'])) || (onPath('python3', ['-c', 'import fitz']) ? 'PyMuPDF' : '');
  add('pdf-renderer', !!pdf, 'print-check, deck-check, menu-check, cover pages (PDF pages as images)', pdf || 'no Ghostscript, pdftoppm, mutool or PyMuPDF', how('brew install ghostscript   (or brew install poppler)', 'sudo apt install ghostscript   (or poppler-utils)', 'winget install ArtifexSoftware.GhostScript'));
  if (network) {
    let reach = false, tier = 'free', note = '';
    try {
      const r = await rpc('tools/call', { name: 'palm_get', arguments: { id: 'review-check' } });
      reach = true;
      const text = (r.content || []).map((c) => c.text || '').join('');
      tier = /is part of Palm Pro/.test(text) ? 'free' : 'pro';
    } catch (e) { reach = e.code === 3; note = e.message; if (e.code === 3) tier = 'free'; }
    add('palm-server', reach, 'all', reach ? 'reached www.yuzool.com/palm/mcp' : `couldn't reach Palm: ${note}`, 'check your connection, or PALM_SERVER if you set it');
    const key = readKey();
    out.push({ id: 'key', ok: true, need: 'Pro sheets and tools', detail: !key ? 'no key: free tier (Pro: palm login)' : tier === 'pro' ? 'Pro key works' : 'a key is set but Palm treats it as free (expired, wrong or not a Palm Pro key)', fix: '' });
  }
  return out;
}
