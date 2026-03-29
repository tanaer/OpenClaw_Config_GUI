#!/usr/bin/env node
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile, exec } = require('child_process');

// ── Config ────────────────────────────────────────────────────────────────────
const HOME = process.env.OPENCLAW_HOME || path.join(os.homedir(), '.openclaw');
const TOKEN_FILE = path.join(HOME, 'agent-token');
const NODE_ID_FILE = path.join(HOME, 'agent-node-id');
const CONFIG_FILE = path.join(HOME, 'openclaw.json');
const PID_FILE = path.join(HOME, 'agent.pid');
const MANAGER_URL = process.env.MANAGER_URL || '';
const POLL_INTERVAL = 5000; // 5 seconds

let PORT = 18790;
let TOKEN = '';
let pollTimer = null;

// Parse CLI args
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--port' && args[i+1]) PORT = parseInt(args[++i]);
  if (args[i] === '--token' && args[i+1]) TOKEN = args[++i];
}

// Load token from file if not passed via CLI
if (!TOKEN && fs.existsSync(TOKEN_FILE)) {
  TOKEN = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
}
if (!TOKEN) {
  console.error('[agent] ERROR: No token configured. Use --token or write to ' + TOKEN_FILE);
  process.exit(1);
}

// Write PID
fs.mkdirSync(HOME, { recursive: true });
fs.writeFileSync(PID_FILE, String(process.pid));

// ── Helpers ───────────────────────────────────────────────────────────────────
function safePath(rel) {
  const resolved = path.resolve(HOME, rel);
  if (!resolved.startsWith(HOME + path.sep) && resolved !== HOME) return null;
  return resolved;
}

function json(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, X-Agent-Token',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => { data += c; if (data.length > 2e6) reject(new Error('too large')); });
    req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch(e) { reject(e); } });
    req.on('error', reject);
  });
}

function auth(req) {
  return req.headers['x-agent-token'] === TOKEN;
}

const ALLOWED_COMMANDS = ['start', 'stop', 'restart', 'status'];

// Predefined task commands mapping
const TASK_COMMANDS = {
  'doctor-fix': ['openclaw', 'doctor', '--fix', '--non-interactive'],
  'doctor-deep': ['openclaw', 'doctor', '--deep', '--non-interactive'],
  'restart-gateway': ['systemctl', '--user', 'restart', 'openclaw-gateway'],
  'status': ['openclaw', 'gateway', 'status']
};

function runCommand(cmd, args, timeout) {
  return new Promise((resolve) => {
    const t = setTimeout(() => {
      child.kill();
      resolve({ exitCode: -1, stdout: '', stderr: 'Timeout after ' + timeout + 'ms' });
    }, timeout);
    const child = execFile(cmd, args, { timeout }, (err, stdout, stderr) => {
      clearTimeout(t);
      resolve({ exitCode: err ? (err.code || 1) : 0, stdout: stdout || '', stderr: stderr || '' });
    });
  });
}

// ── Manager Polling ───────────────────────────────────────────────────────────
async function httpRequest(method, url, body = null) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const options = {
      hostname: urlObj.hostname,
      port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
      path: urlObj.pathname + urlObj.search,
      method: method,
      headers: {
        'Content-Type': 'application/json',
        'X-Agent-Token': TOKEN
      },
      timeout: 10000
    };
    if (body) {
      options.headers['Content-Length'] = Buffer.byteLength(JSON.stringify(body));
    }

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data || '{}') });
        } catch(e) {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });
    req.on('error', (e) => resolve({ status: 0, error: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, error: 'timeout' }); });
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function executeTask(task) {
  const taskId = task.id || task.taskId;
  const taskType = task.type || task.command;
  
  if (!TASK_COMMANDS[taskType]) {
    return { taskId, success: false, error: 'Unknown task type: ' + taskType };
  }

  const [cmd, ...args] = TASK_COMMANDS[taskType];
  console.log('[agent] Executing task:', taskId, '→', taskType);
  
  const result = await runCommand(cmd, args, 60000);
  console.log('[agent] Task result:', taskId, 'exitCode:', result.exitCode);
  
  return {
    taskId,
    success: result.exitCode === 0,
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr
  };
}

async function reportResult(taskId, result) {
  if (!MANAGER_URL) return;
  
  try {
    const reportUrl = MANAGER_URL.replace(/\/$/, '') + '/api/tasks/' + taskId + '/result';
    const resp = await httpRequest('POST', reportUrl, {
      success: result.success,
      output: result.output,
      error: result.error
    });
    console.log('[agent] Reported result for:', taskId, 'status:', resp.status);
  } catch(e) {
    console.error('[agent] Failed to report result:', e.message);
  }
}

async function pollManager() {
  if (!MANAGER_URL) return;
  
  try {
    // Read nodeId from file (set during registration)
    let nodeId = '';
    if (fs.existsSync(NODE_ID_FILE)) {
      nodeId = fs.readFileSync(NODE_ID_FILE, 'utf8').trim();
    }
    if (!nodeId) {
      nodeId = os.hostname(); // fallback to hostname
    }
    
    const pollUrl = MANAGER_URL.replace(/\/$/, '') + '/api/tasks/poll/' + nodeId;
    const resp = await httpRequest('GET', pollUrl);
    
    if (resp.status === 200 && resp.body && resp.body.hasTask && resp.body.task) {
      const task = resp.body.task;
      console.log('[agent] Received task:', task.command, task.commandType);
      
      const result = await executeTask(task);
      await reportResult(task.id, result);
    } else if (resp.status === 200 && resp.body && !resp.body.hasTask) {
      // No pending tasks
    } else if (resp.error) {
      console.error('[agent] Poll error:', resp.error);
    } else {
      console.log('[agent] Poll response:', resp.status, resp.body);
    }
  } catch(e) {
    console.error('[agent] Poll failed:', e.message);
  }
}

function startPolling() {
  if (!MANAGER_URL) {
    console.log('[agent] No MANAGER_URL set, polling disabled');
    return;
  }
  
  console.log('[agent] Starting polling to:', MANAGER_URL);
  pollTimer = setInterval(pollManager, POLL_INTERVAL);
  // Poll immediately on start
  pollManager();
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

// ── Request Handler ───────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const pathname = url.pathname;

  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, X-Agent-Token',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
    });
    return res.end();
  }

  // Health — no auth
  if (pathname === '/health' && req.method === 'GET') {
    return json(res, 200, { ok: true, version: '1.1.0', hostname: os.hostname(), platform: os.platform(), home: HOME });
  }

  // GET /instances — detect all OpenClaw instances (no auth)
  if (pathname === '/instances' && req.method === 'GET') {
    try {
      const homeDir = os.homedir();
      const entries = fs.readdirSync(homeDir, { withFileTypes: true });
      const instances = entries
        .filter(e => e.isDirectory() && e.name.startsWith('.openclaw'))
        .map(e => {
          const name = e.name === '.openclaw' ? 'default' : e.name.replace(/^\.openclaw-?/, '') || 'default';
          const instancePath = path.join(homeDir, e.name);
          const configFile = path.join(instancePath, 'openclaw.json');
          const hasConfig = fs.existsSync(configFile);
          return { name, path: instancePath, hasConfig };
        });
      return json(res, 200, { ok: true, instances, current: HOME });
    } catch(e) {
      return json(res, 500, { ok: false, error: e.message });
    }
  }
  // Auth check for all other routes
  if (!auth(req)) return json(res, 401, { ok: false, error: 'unauthorized' });

  // GET /config
  if (pathname === '/config' && req.method === 'GET') {
    if (!fs.existsSync(CONFIG_FILE)) return json(res, 200, { ok: false, error: 'not_found' });
    try {
      const raw = fs.readFileSync(CONFIG_FILE, 'utf8');
      const cfg = JSON.parse(raw);
      return json(res, 200, { ok: true, config: cfg });
    } catch(e) {
      const raw = fs.readFileSync(CONFIG_FILE, 'utf8');
      return json(res, 200, { ok: false, error: 'parse_error', raw });
    }
  }

  // POST /config
  if (pathname === '/config' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      if (!body.config) return json(res, 400, { ok: false, error: 'missing config' });
      const ts = Date.now();
      const bakFile = CONFIG_FILE + '.bak.' + ts;
      if (fs.existsSync(CONFIG_FILE)) fs.copyFileSync(CONFIG_FILE, bakFile);
      const tmp = CONFIG_FILE + '.tmp.' + ts;
      fs.writeFileSync(tmp, JSON.stringify(body.config, null, 2), 'utf8');
      fs.renameSync(tmp, CONFIG_FILE);
      return json(res, 200, { ok: true, backedUpTo: fs.existsSync(bakFile) ? bakFile : null });
    } catch(e) {
      return json(res, 500, { ok: false, error: e.message });
    }
  }

  // POST /command
  if (pathname === '/command' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const cmd = body.command;
      if (!ALLOWED_COMMANDS.includes(cmd)) return json(res, 400, { ok: false, error: 'command not allowed' });
      const result = await runCommand('openclaw', ['gateway', cmd], 30000);
      return json(res, 200, { ok: true, ...result });
    } catch(e) {
      return json(res, 500, { ok: false, error: e.message });
    }
  }

  // GET /files/list
  if (pathname === '/files/list' && req.method === 'GET') {
    try {
      const entries = fs.readdirSync(HOME, { withFileTypes: true });
      const files = entries.map(e => {
        try {
          const st = fs.statSync(path.join(HOME, e.name));
          return { name: e.name, size: st.size, mtime: st.mtimeMs, isDir: e.isDirectory() };
        } catch { return { name: e.name, size: 0, mtime: 0, isDir: false }; }
      });
      return json(res, 200, { ok: true, files });
    } catch(e) {
      return json(res, 500, { ok: false, error: e.message });
    }
  }

  // GET /files/read?path=...
  if (pathname === '/files/read' && req.method === 'GET') {
    const rel = url.searchParams.get('path');
    if (!rel) return json(res, 400, { ok: false, error: 'missing path' });
    const abs = safePath(rel);
    if (!abs) return json(res, 403, { ok: false, error: 'path not allowed' });
    try {
      const content = fs.readFileSync(abs, 'utf8');
      return json(res, 200, { ok: true, content });
    } catch(e) {
      return json(res, 404, { ok: false, error: e.message });
    }
  }

  // POST /rescue
  if (pathname === '/rescue' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const mode = body.mode;
      const instance = body.instance || 'default';
      
      // Build instance path
      const homeDir = os.homedir();
      const instanceHome = instance === 'default' 
        ? path.join(homeDir, '.openclaw')
        : path.join(homeDir, '.openclaw' + (instance.startsWith('-') ? instance : '-' + instance));
      const instanceConfig = path.join(instanceHome, 'openclaw.json');
      
      // Helper to run command with instance environment
      async function runInstanceCommand(cmd, args, timeout) {
        return new Promise((resolve) => {
          const t = setTimeout(() => { child.kill(); resolve({ exitCode: -1, stdout: '', stderr: 'Timeout after ' + timeout + 'ms' }); }, timeout);
          const child = execFile(cmd, args, { timeout, env: { ...process.env, OPENCLAW_HOME: instanceHome } }, (err, stdout, stderr) => {
            clearTimeout(t);
            resolve({ exitCode: err ? (err.code || 1) : 0, stdout: stdout || '', stderr: stderr || '' });
          });
        });
      }
      
      let result = '';

      if (mode === 'status') {
        const r = await runInstanceCommand('openclaw', ['gateway', 'status'], 10000);
        result = r.stdout + r.stderr;
      } else if (mode === 'kill-gateway') {
        await runInstanceCommand('pkill', ['-f', 'openclaw gateway'], 5000);
        const r = await runInstanceCommand('openclaw', ['gateway', 'status'], 5000);
        result = 'Killed. Status: ' + r.stdout + r.stderr;
      } else if (mode === 'reset-config') {
        const ts = Date.now();
        const bak = instanceConfig + '.rescue-backup.' + ts;
        if (fs.existsSync(instanceConfig)) fs.copyFileSync(instanceConfig, bak);
        const minimal = { meta: { version: '1' }, gateway: { port: 18789 }, models: { providers: {} }, channels: {}, agents: { defaults: {} } };
        fs.writeFileSync(instanceConfig, JSON.stringify(minimal, null, 2));
        result = 'Config reset. Backup: ' + bak;
      } else if (mode === 'restore-backup') {
        const files = fs.readdirSync(instanceHome).filter(f => f.startsWith('openclaw.json.bak.')).sort().reverse();
        if (!files.length) return json(res, 200, { ok: false, error: 'No backup found' });
        fs.copyFileSync(path.join(instanceHome, files[0]), instanceConfig);
        result = 'Restored from: ' + files[0];
      } else if (mode === 'clear-locks') {
        const removed = [];
        fs.readdirSync(instanceHome).forEach(f => {
          if (f.endsWith('.lock') || f.endsWith('.swp') || f.endsWith('.swo')) {
            fs.unlinkSync(path.join(instanceHome, f)); removed.push(f);
          }
        });
        result = removed.length ? 'Removed: ' + removed.join(', ') : 'No lock files found';
      } else if (mode === 'doctor-fix') {
        const r = await runInstanceCommand('openclaw', ['doctor', '--fix', '--non-interactive'], 60000);
        result = r.stdout + r.stderr;
      } else if (mode === 'doctor-deep') {
        const r = await runInstanceCommand('openclaw', ['doctor', '--deep', '--non-interactive'], 60000);
        result = r.stdout + r.stderr;
      } else if (mode === 'factory-reset') {
        await runInstanceCommand('openclaw', ['gateway', 'stop'], 10000);
        if (fs.existsSync(instanceConfig)) fs.unlinkSync(instanceConfig);
        result = 'Factory reset complete. Re-run: openclaw onboard';
      } else {
        return json(res, 400, { ok: false, error: 'unknown rescue mode' });
      }
      return json(res, 200, { ok: true, result });
    } catch(e) {
      return json(res, 500, { ok: false, error: e.message });
    }
  }

  return json(res, 404, { ok: false, error: 'not found' });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('[openclaw-agent] Listening on 0.0.0.0:' + PORT);
  console.log('[openclaw-agent] Home: ' + HOME);
  // Start polling manager for tasks
  startPolling();
});

process.on('SIGTERM', () => { stopPolling(); try { fs.unlinkSync(PID_FILE); } catch{} process.exit(0); });
process.on('SIGINT',  () => { stopPolling(); try { fs.unlinkSync(PID_FILE); } catch{} process.exit(0); });
