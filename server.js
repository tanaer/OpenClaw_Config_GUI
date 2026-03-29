#!/usr/bin/env node
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const CONFIG_PATH = process.env.OPENCLAW_CONFIG || '/root/.openclaw/openclaw.json';
const BACKUP_DIR = process.env.BACKUP_DIR || '/root/.openclaw/config-backups';
const NODES_FILE = process.env.NODES_FILE || '/root/.openclaw/registered-nodes.json';
const TASKS_FILE = process.env.TASKS_FILE || '/root/.openclaw/pending-tasks.json';

// 预置命令映射
const PRESET_COMMANDS = {
  'doctor-fix': 'openclaw doctor --fix',
  'doctor-deep': 'openclaw doctor --deep',
  'restart-gateway': 'openclaw gateway restart',
  'status': 'openclaw status'
};

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.sh':   'text/plain; charset=utf-8',
  '.ico':  'image/x-icon',
  '.png':  'image/png',
  '.svg':  'image/svg+xml',
};

// 确保备份目录存在
if (!fs.existsSync(BACKUP_DIR)) {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
}

// 加载/保存已注册的节点
function loadRegisteredNodes() {
  try {
    if (fs.existsSync(NODES_FILE)) {
      return JSON.parse(fs.readFileSync(NODES_FILE, 'utf-8'));
    }
  } catch (e) {
    console.error('Failed to load nodes:', e.message);
  }
  return [];
}

function saveRegisteredNodes(nodes) {
  try {
    fs.writeFileSync(NODES_FILE, JSON.stringify(nodes, null, 2), 'utf-8');
    return true;
  } catch (e) {
    console.error('Failed to save nodes:', e.message);
    return false;
  }
}

// 加载/保存任务队列
function loadTasks() {
  try {
    if (fs.existsSync(TASKS_FILE)) {
      return JSON.parse(fs.readFileSync(TASKS_FILE, 'utf-8'));
    }
  } catch (e) {
    console.error('Failed to load tasks:', e.message);
  }
  return [];
}

function saveTasks(tasks) {
  try {
    fs.writeFileSync(TASKS_FILE, JSON.stringify(tasks, null, 2), 'utf-8');
    return true;
  } catch (e) {
    console.error('Failed to save tasks:', e.message);
    return false;
  }
}

// 生成任务 ID
function generateTaskId() {
  return 'task-' + Date.now().toString(36) + '-' + Math.random().toString(36).substr(2, 6);
}

function serve(res, filePath, status = 200) {
  const ext = path.extname(filePath);
  const mime = MIME[ext] || 'application/octet-stream';
  try {
    const data = fs.readFileSync(filePath);
    // 禁止缓存 JS 和 HTML 文件，确保用户总是获取最新版本
    const headers = { 
      'Content-Type': mime, 
      'Content-Length': data.length 
    };
    if (ext === '.js' || ext === '.html' || ext === '.css') {
      headers['Cache-Control'] = 'no-store, no-cache, must-revalidate';
      headers['Pragma'] = 'no-cache';
      headers['Expires'] = '0';
    }
    res.writeHead(status, headers);
    res.end(data);
  } catch (e) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found: ' + filePath);
  }
}

function sendJson(res, data, status = 200) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
}

function sendError(res, message, status = 500) {
  sendJson(res, { error: true, message }, status);
}

// 深度验证 JSON 结构是否为有效的 OpenClaw 配置
function validateConfig(config) {
  const errors = [];
  
  // 基本类型检查
  if (typeof config !== 'object' || config === null || Array.isArray(config)) {
    errors.push('配置必须是一个对象');
    return { valid: false, errors };
  }
  
  // 检查关键字段类型
  if (config.gateway !== undefined) {
    if (typeof config.gateway !== 'object' || config.gateway === null) {
      errors.push('gateway 必须是一个对象');
    } else {
      if (config.gateway.port !== undefined && typeof config.gateway.port !== 'number') {
        errors.push('gateway.port 必须是数字');
      }
      if (config.gateway.bind !== undefined && typeof config.gateway.bind !== 'string') {
        errors.push('gateway.bind 必须是字符串');
      }
      if (config.gateway.auth !== undefined) {
        if (typeof config.gateway.auth !== 'object' || config.gateway.auth === null) {
          errors.push('gateway.auth 必须是一个对象');
        } else if (config.gateway.auth.token !== undefined && typeof config.gateway.auth.token !== 'string') {
          errors.push('gateway.auth.token 必须是字符串');
        }
      }
    }
  }
  
  if (config.models !== undefined) {
    if (typeof config.models !== 'object' || config.models === null) {
      errors.push('models 必须是一个对象');
    } else if (config.models.providers !== undefined) {
      if (typeof config.models.providers !== 'object' || config.models.providers === null) {
        errors.push('models.providers 必须是一个对象');
      } else {
        for (const [name, provider] of Object.entries(config.models.providers)) {
          if (typeof provider !== 'object' || provider === null) {
            errors.push(`models.providers.${name} 必须是一个对象`);
          } else {
            if (provider.baseUrl !== undefined && typeof provider.baseUrl !== 'string') {
              errors.push(`models.providers.${name}.baseUrl 必须是字符串`);
            }
            if (provider.models !== undefined && !Array.isArray(provider.models)) {
              errors.push(`models.providers.${name}.models 必须是数组`);
            }
          }
        }
      }
    }
  }
  
  if (config.channels !== undefined) {
    if (typeof config.channels !== 'object' || config.channels === null) {
      errors.push('channels 必须是一个对象');
    } else {
      for (const [name, channel] of Object.entries(config.channels)) {
        if (typeof channel !== 'object' || channel === null) {
          errors.push(`channels.${name} 必须是一个对象`);
        } else if (channel.enabled !== undefined && typeof channel.enabled !== 'boolean') {
          errors.push(`channels.${name}.enabled 必须是布尔值`);
        } else if (channel.botToken !== undefined && typeof channel.botToken !== 'string') {
          errors.push(`channels.${name}.botToken 必须是字符串`);
        }
      }
    }
  }
  
  if (config.agents !== undefined) {
    if (typeof config.agents !== 'object' || config.agents === null) {
      errors.push('agents 必须是一个对象');
    } else if (config.agents.defaults !== undefined) {
      if (typeof config.agents.defaults !== 'object' || config.agents.defaults === null) {
        errors.push('agents.defaults 必须是一个对象');
      } else {
        if (config.agents.defaults.maxConcurrent !== undefined && typeof config.agents.defaults.maxConcurrent !== 'number') {
          errors.push('agents.defaults.maxConcurrent 必须是数字');
        }
        if (config.agents.defaults.workspace !== undefined && typeof config.agents.defaults.workspace !== 'string') {
          errors.push('agents.defaults.workspace 必须是字符串');
        }
      }
    }
  }
  
  return { 
    valid: errors.length === 0, 
    errors,
    warnings: [] // 可以添加警告信息
  };
}

// 创建备份
function createBackup(reason = 'manual') {
  if (!fs.existsSync(CONFIG_PATH)) {
    return null;
  }
  
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const backupPath = path.join(BACKUP_DIR, `openclaw-${timestamp}-${reason}.json`);
  
  try {
    fs.copyFileSync(CONFIG_PATH, backupPath);
    
    // 保留最近 20 个备份
    const backups = fs.readdirSync(BACKUP_DIR)
      .filter(f => f.startsWith('openclaw-') && f.endsWith('.json'))
      .sort()
      .reverse();
    
    for (let i = 20; i < backups.length; i++) {
      fs.unlinkSync(path.join(BACKUP_DIR, backups[i]));
    }
    
    return backupPath;
  } catch (e) {
    console.error('Backup failed:', e);
    return null;
  }
}

// 处理 API 请求
function handleApi(req, res, urlPath) {
  // GET /api/config - 读取配置
  if (req.method === 'GET' && urlPath === '/api/config') {
    try {
      if (!fs.existsSync(CONFIG_PATH)) {
        return sendJson(res, { 
          exists: false, 
          config: null,
          message: '配置文件不存在' 
        });
      }
      
      const content = fs.readFileSync(CONFIG_PATH, 'utf-8');
      const config = JSON.parse(content);
      
      sendJson(res, { 
        exists: true, 
        config,
        path: CONFIG_PATH,
        lastModified: fs.statSync(CONFIG_PATH).mtime
      });
    } catch (e) {
      sendError(res, '读取配置文件失败: ' + e.message, 500);
    }
    return true;
  }
  
  // POST /api/config - 保存配置
  if (req.method === 'POST' && urlPath === '/api/config') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        const config = data.config;
        
        if (!config) {
          return sendError(res, '缺少 config 字段', 400);
        }
        
        // 验证配置
        const validation = validateConfig(config);
        if (!validation.valid) {
          return sendJson(res, { 
            error: true, 
            message: '配置验证失败',
            validation
          }, 400);
        }
        
        // 创建备份
        const backupPath = createBackup('before-save');
        
        // 格式化并保存
        const jsonContent = JSON.stringify(config, null, 2);
        
        // 先写入临时文件，再原子替换
        const tempPath = CONFIG_PATH + '.tmp';
        fs.writeFileSync(tempPath, jsonContent, 'utf-8');
        fs.renameSync(tempPath, CONFIG_PATH);
        
        sendJson(res, { 
          success: true, 
          message: '配置已保存',
          backup: backupPath,
          path: CONFIG_PATH,
          validation
        });
        
      } catch (e) {
        sendError(res, '保存配置失败: ' + e.message, 500);
      }
    });
    return true;
  }
  
  // POST /api/config/validate - 仅验证配置
  if (req.method === 'POST' && urlPath === '/api/config/validate') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        const config = data.config;
        
        if (!config) {
          return sendError(res, '缺少 config 字段', 400);
        }
        
        // 尝试解析（如果是字符串）
        let parsedConfig = config;
        if (typeof config === 'string') {
          try {
            parsedConfig = JSON.parse(config);
          } catch (e) {
            return sendJson(res, { 
              valid: false, 
              errors: ['JSON 解析失败: ' + e.message] 
            }, 400);
          }
        }
        
        const validation = validateConfig(parsedConfig);
        sendJson(res, validation);
        
      } catch (e) {
        sendError(res, '验证失败: ' + e.message, 500);
      }
    });
    return true;
  }
  
  // GET /api/backups - 列出备份
  if (req.method === 'GET' && urlPath === '/api/backups') {
    try {
      const backups = fs.readdirSync(BACKUP_DIR)
        .filter(f => f.startsWith('openclaw-') && f.endsWith('.json'))
        .sort()
        .reverse()
        .slice(0, 20)
        .map(f => {
          const filePath = path.join(BACKUP_DIR, f);
          const stat = fs.statSync(filePath);
          return {
            name: f,
            path: filePath,
            size: stat.size,
            modified: stat.mtime
          };
        });
      
      sendJson(res, { backups });
    } catch (e) {
      sendError(res, '读取备份列表失败: ' + e.message, 500);
    }
    return true;
  }
  
  // POST /api/restore - 从备份恢复
  if (req.method === 'POST' && urlPath === '/api/restore') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        const backupName = data.backup;
        
        if (!backupName) {
          return sendError(res, '缺少 backup 字段', 400);
        }
        
        // 安全检查：防止路径遍历
        const backupPath = path.resolve(BACKUP_DIR, backupName);
        if (!backupPath.startsWith(BACKUP_DIR)) {
          return sendError(res, '无效的备份名称', 403);
        }
        
        if (!fs.existsSync(backupPath)) {
          return sendError(res, '备份文件不存在', 404);
        }
        
        // 创建当前配置的备份
        const currentBackup = createBackup('before-restore');
        
        // 恢复备份
        fs.copyFileSync(backupPath, CONFIG_PATH);
        
        const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
        
        sendJson(res, { 
          success: true, 
          message: '已从备份恢复',
          restoredFrom: backupName,
          currentBackup,
          config
        });
        
      } catch (e) {
        sendError(res, '恢复失败: ' + e.message, 500);
      }
    });
    return true;
  }
  
  // GET /api/nodes - 获取已注册的节点列表
  if (req.method === 'GET' && urlPath === '/api/nodes') {
    const nodes = loadRegisteredNodes();
    sendJson(res, { nodes });
    return true;
  }
  
  // POST /api/nodes/register - 节点注册
  if (req.method === 'POST' && urlPath === '/api/nodes/register') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        const { name, host, port, token, ssl } = data;
        
        if (!host || !token) {
          return sendError(res, '缺少 host 或 token 字段', 400);
        }
        
        const nodes = loadRegisteredNodes();
        
        // 检查是否已存在（按 host:port 判断）
        const existingIndex = nodes.findIndex(n => n.host === host && n.port === (port || 18790));
        
        const nodeData = {
          id: existingIndex >= 0 ? nodes[existingIndex].id : Date.now().toString(36),
          name: name || host,
          host,
          port: parseInt(port) || 18790,
          token,
          ssl: !!ssl,
          registeredAt: new Date().toISOString(),
          lastSeen: new Date().toISOString()
        };
        
        if (existingIndex >= 0) {
          // 保留原有的名称，更新其他信息
          nodeData.name = nodes[existingIndex].name || nodeData.name;
          nodes[existingIndex] = nodeData;
        } else {
          nodes.push(nodeData);
        }
        
        saveRegisteredNodes(nodes);
        
        sendJson(res, { 
          success: true, 
          message: existingIndex >= 0 ? '节点已更新' : '节点已注册',
          node: nodeData
        });
        
      } catch (e) {
        sendError(res, '注册失败: ' + e.message, 500);
      }
    });
    return true;
  }
  
  // DELETE /api/nodes/:id - 删除节点
  if (req.method === 'DELETE' && urlPath.startsWith('/api/nodes/')) {
    const nodeId = urlPath.replace('/api/nodes/', '');
    const nodes = loadRegisteredNodes();
    const filtered = nodes.filter(n => n.id !== nodeId);
    
    if (filtered.length === nodes.length) {
      sendError(res, '节点不存在', 404);
    } else {
      saveRegisteredNodes(filtered);
      sendJson(res, { success: true, message: '节点已删除' });
    }
    return true;
  }

  // ── Task Queue API ─────────────────────────────────────────────────────────

  // GET /api/tasks - 获取所有任务状态
  if (req.method === 'GET' && urlPath === '/api/tasks') {
    const tasks = loadTasks();
    sendJson(res, { tasks, count: tasks.length });
    return true;
  }

  // POST /api/tasks - 创建任务（面板调用）
  if (req.method === 'POST' && urlPath === '/api/tasks') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        const { nodeId, command, params } = data;
        
        if (!nodeId) {
          return sendError(res, '缺少 nodeId 字段', 400);
        }
        
        // 验证节点存在
        const nodes = loadRegisteredNodes();
        const node = nodes.find(n => n.id === nodeId);
        if (!node) {
          return sendError(res, '节点不存在', 404);
        }
        
        // 解析命令（支持预置命令名或直接命令）
        let actualCommand = command;
        if (PRESET_COMMANDS[command]) {
          actualCommand = PRESET_COMMANDS[command];
        }
        
        if (!actualCommand) {
          return sendError(res, '缺少 command 字段', 400);
        }
        
        const tasks = loadTasks();
        const task = {
          id: generateTaskId(),
          nodeId,
          nodeName: node.name,
          command: actualCommand,
          commandType: PRESET_COMMANDS[command] ? command : 'custom',
          params: params || {},
          status: 'pending',
          result: null,
          createdAt: new Date().toISOString(),
          completedAt: null
        };
        
        tasks.push(task);
        saveTasks(tasks);
        
        sendJson(res, { 
          success: true, 
          message: '任务已创建',
          task
        });
        
      } catch (e) {
        sendError(res, '创建任务失败: ' + e.message, 500);
      }
    });
    return true;
  }

  // GET /api/tasks/poll/:nodeId - Agent poll 获取待执行任务
  if (req.method === 'GET' && urlPath.startsWith('/api/tasks/poll/')) {
    const nodeId = urlPath.replace('/api/tasks/poll/', '');
    
    const tasks = loadTasks();
    const pendingTasks = tasks.filter(t => t.nodeId === nodeId && t.status === 'pending');
    
    if (pendingTasks.length > 0) {
      // 将第一个待执行任务标记为 running
      const task = pendingTasks[0];
      const taskIndex = tasks.findIndex(t => t.id === task.id);
      if (taskIndex >= 0) {
        tasks[taskIndex].status = 'running';
        tasks[taskIndex].startedAt = new Date().toISOString();
        saveTasks(tasks);
      }
      
      sendJson(res, { 
        hasTask: true, 
        task: {
          id: task.id,
          command: task.command,
          params: task.params,
          commandType: task.commandType,
          createdAt: task.createdAt
        }
      });
    } else {
      sendJson(res, { hasTask: false, task: null });
    }
    return true;
  }

  // POST /api/tasks/:taskId/result - Agent 提交执行结果
  if (req.method === 'POST' && urlPath.match(/^\/api\/tasks\/task-[^\/]+\/result$/)) {
    const taskId = urlPath.replace('/api/tasks/', '').replace('/result', '');
    
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        const { success, output, error } = data;
        
        const tasks = loadTasks();
        const taskIndex = tasks.findIndex(t => t.id === taskId);
        
        if (taskIndex < 0) {
          return sendError(res, '任务不存在', 404);
        }
        
        tasks[taskIndex].status = success ? 'completed' : 'failed';
        tasks[taskIndex].result = {
          success: !!success,
          output: output || null,
          error: error || null
        };
        tasks[taskIndex].completedAt = new Date().toISOString();
        
        saveTasks(tasks);
        
        sendJson(res, { 
          success: true, 
          message: '任务结果已记录',
          task: tasks[taskIndex]
        });
        
      } catch (e) {
        sendError(res, '提交结果失败: ' + e.message, 500);
      }
    });
    return true;
  }

  // DELETE /api/tasks/:taskId - 删除任务
  if (req.method === 'DELETE' && urlPath.startsWith('/api/tasks/task-')) {
    const taskId = urlPath.replace('/api/tasks/', '');
    const tasks = loadTasks();
    const filtered = tasks.filter(t => t.id !== taskId);
    
    if (filtered.length === tasks.length) {
      sendError(res, '任务不存在', 404);
    } else {
      saveTasks(filtered);
      sendJson(res, { success: true, message: '任务已删除' });
    }
    return true;
  }

  // GET /api/tasks/presets - 获取支持的预置命令列表
  if (req.method === 'GET' && urlPath === '/api/tasks/presets') {
    sendJson(res, { 
      presets: Object.keys(PRESET_COMMANDS).map(key => ({
        id: key,
        command: PRESET_COMMANDS[key],
        description: {
          'doctor-fix': '执行 openclaw doctor --fix，自动修复问题',
          'doctor-deep': '执行 openclaw doctor --deep，深度检查',
          'restart-gateway': '重启 OpenClaw Gateway 服务',
          'status': '获取 OpenClaw 状态信息'
        }[key]
      }))
    });
    return true;
  }

  // ── Agent Proxy ─────────────────────────────────────────────────────────────
  // 代理请求到远程 Agent，解决 CORS 问题
  // GET/POST /api/proxy/:nodeId/* -> http://node:port/*
  const proxyMatch = urlPath.match(/^\/api\/proxy\/([^\/]+)(\/.*)$/);
  if (proxyMatch) {
    const nodeId = proxyMatch[1];
    const agentPath = proxyMatch[2];
    const nodes = loadRegisteredNodes();
    const node = nodes.find(n => n.id === nodeId);
    
    if (!node) {
      sendError(res, '节点不存在', 404);
      return true;
    }
    
    // 构建目标 URL
    const proto = node.ssl ? 'https' : 'http';
    const targetUrl = `${proto}://${node.host}:${node.port}${agentPath}`;
    
    // 读取请求体（如果是 POST/PUT）
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      const http = require('http');
      // 如果是 https，需要使用 https 模块
      const httpModule = node.ssl ? require('https') : require('http');
      
      const proxyReq = httpModule.request(targetUrl, {
        method: req.method,
        headers: {
          'Content-Type': 'application/json',
          'X-Agent-Token': node.token
        },
        timeout: 30000
      }, (proxyRes) => {
        let resBody = '';
        proxyRes.on('data', chunk => resBody += chunk);
        proxyRes.on('end', () => {
          // 设置 CORS 头并返回响应
          res.writeHead(proxyRes.statusCode, {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*'
          });
          res.end(resBody);
        });
      });
      
      proxyReq.on('error', (e) => {
        console.error('Proxy error:', e.message);
        sendJson(res, { ok: false, error: '无法连接到节点: ' + e.message }, 502);
      });
      
      proxyReq.on('timeout', () => {
        proxyReq.destroy();
        sendJson(res, { ok: false, error: '连接节点超时' }, 504);
      });
      
      if (body) {
        proxyReq.write(body);
      }
      proxyReq.end();
    });
    return true;
  }
  
  return false;
}

const server = http.createServer((req, res) => {
  let urlPath = req.url.split('?')[0];
  if (urlPath === '/') urlPath = '/index.html';

  // 处理 API 请求
  if (urlPath.startsWith('/api/')) {
    if (handleApi(req, res, urlPath)) {
      return;
    }
    return sendError(res, '未知的 API 端点', 404);
  }

  // Security: no path traversal
  const abs = path.resolve(ROOT, '.' + urlPath);
  if (!abs.startsWith(ROOT + path.sep) && abs !== ROOT) {
    res.writeHead(403); return res.end('Forbidden');
  }

  // Special: /install.sh — serve agent install script
  if (urlPath === '/install.sh') {
    return serve(res, path.join(ROOT, 'openclaw-agent', 'install.sh'));
  }

  // Serve static files
  if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
    return serve(res, abs);
  }

  // SPA fallback
  serve(res, path.join(ROOT, 'index.html'));
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`OpenClaw Config GUI running at http://0.0.0.0:${PORT}`);
  console.log(`Config file: ${CONFIG_PATH}`);
  console.log(`Backup dir:  ${BACKUP_DIR}`);
  console.log(`Agent install script: http://0.0.0.0:${PORT}/install.sh`);
  console.log(`Agent script:         http://0.0.0.0:${PORT}/openclaw-agent/agent.js`);
});
