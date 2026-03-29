/**
 * OpenClaw 配置管理器
 * 用于可视化管理 OpenClaw 配置文件
 */

// ===== 默认配置模板 =====
const DEFAULT_CONFIG = {
    meta: {
        lastTouchedVersion: "2026.1.29",
        lastTouchedAt: new Date().toISOString()
    },
    wizard: {
        lastRunAt: new Date().toISOString(),
        lastRunVersion: "2026.1.29",
        lastRunCommand: "onboard",
        lastRunMode: "local"
    },
    auth: {
        profiles: {}
    },
    models: {
        providers: {}
    },
    agents: {
        defaults: {
            model: {
                primary: "",
                fallbacks: []
            },
            models: {},
            workspace: "",
            maxConcurrent: 4,
            subagents: {
                maxConcurrent: 8
            }
        }
    },
    messages: {
        ackReactionScope: "group-mentions"
    },
    commands: {
        native: "auto",
        nativeSkills: "auto",
        restart: true
    },
    hooks: {
        internal: {
            enabled: true,
            entries: {
                "boot-md": { enabled: true },
                "session-memory": { enabled: true }
            }
        }
    },
    channels: {},
    gateway: {
        port: 18789,
        mode: "local",
        bind: "loopback",
        auth: {
            mode: "token",
            token: ""
        },
        tailscale: {
            mode: "off",
            resetOnExit: false
        }
    },
    skills: {
        install: {
            nodeManager: "npm"
        }
    },
    plugins: {
        entries: {}
    }
};

// ===== API 配置 =====
// 支持通过 URL 参数或 localStorage 配置 API endpoint
// 例如: ?api=http://localhost:3000 或 localStorage.setItem('openclaw-api', 'http://localhost:3000')
function getApiBase() {
    // 优先级: URL 参数 > localStorage > 默认（当前域名）
    const urlParams = new URLSearchParams(window.location.search);
    const urlApi = urlParams.get('api');
    if (urlApi) {
        localStorage.setItem('openclaw-api', urlApi);
        return urlApi;
    }
    return localStorage.getItem('openclaw-api') || '';
}
const API_BASE = getApiBase();

// API fetch helper - 自动添加 API_BASE 前缀
function apiFetch(path, options = {}) {
    const url = API_BASE + path;
    return fetch(url, options);
}

// ===== 应用状态 =====
let config = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
let editingProvider = null;
let editingModel = null;
let editingChannel = null;

// 缓存状态
let cachedConfig = null; // 上传时的原始配置
let isModified = false;  // 配置是否已修改

// 复制/粘贴状态（提供商与模型）
let selectedProviders = new Set();
let selectedModels = new Map();
const CLIPBOARD_KEY = 'openclaw-config-clipboard-v1';

// ===== DOM 元素引用 =====
const elements = {
    // Navigation
    navItems: document.querySelectorAll('.nav-item'),
    sections: document.querySelectorAll('.section'),

    // Buttons
    importBtn: document.getElementById('importBtn'),
    exportBtn: document.getElementById('exportBtn'),
    addProviderBtn: document.getElementById('addProviderBtn'),
    addChannelBtn: document.getElementById('addChannelBtn'),
    addFallbackBtn: document.getElementById('addFallbackBtn'),
    formatJsonBtn: document.getElementById('formatJsonBtn'),
    toggleTokenBtn: document.getElementById('toggleTokenBtn'),
    generateTokenBtn: document.getElementById('generateTokenBtn'),

    // Containers
    providersList: document.getElementById('providersList'),
    channelsList: document.getElementById('channelsList'),
    fallbackModels: document.getElementById('fallbackModels'),

    // Form fields
    primaryModel: document.getElementById('primaryModel'),
    workspace: document.getElementById('workspace'),
    maxConcurrent: document.getElementById('maxConcurrent'),
    gatewayPort: document.getElementById('gatewayPort'),
    gatewayBind: document.getElementById('gatewayBind'),
    gatewayToken: document.getElementById('gatewayToken'),
    rawJson: document.getElementById('rawJson'),

    // File input
    fileInput: document.getElementById('fileInput'),

    // Toast
    toast: document.getElementById('toast'),

    // Provider Modal
    providerModal: document.getElementById('providerModal'),
    providerModalTitle: document.getElementById('providerModalTitle'),
    providerName: document.getElementById('providerName'),
    providerBaseUrl: document.getElementById('providerBaseUrl'),
    providerApiKey: document.getElementById('providerApiKey'),
    providerApiMode: document.getElementById('providerApiMode'),
    closeProviderModal: document.getElementById('closeProviderModal'),
    cancelProviderBtn: document.getElementById('cancelProviderBtn'),
    saveProviderBtn: document.getElementById('saveProviderBtn'),

    // Model Modal
    modelModal: document.getElementById('modelModal'),
    modelModalTitle: document.getElementById('modelModalTitle'),
    modelProviderName: document.getElementById('modelProviderName'),
    modelId: document.getElementById('modelId'),
    modelName: document.getElementById('modelName'),
    modelContextWindow: document.getElementById('modelContextWindow'),
    modelMaxTokens: document.getElementById('modelMaxTokens'),
    modelReasoning: document.getElementById('modelReasoning'),
    modelVision: document.getElementById('modelVision'),
    modelApiMode: document.getElementById('modelApiMode'),
    closeModelModal: document.getElementById('closeModelModal'),
    cancelModelBtn: document.getElementById('cancelModelBtn'),
    saveModelBtn: document.getElementById('saveModelBtn'),

    // Channel Modal
    channelModal: document.getElementById('channelModal'),
    channelModalTitle: document.getElementById('channelModalTitle'),
    channelType: document.getElementById('channelType'),
    channelEnabled: document.getElementById('channelEnabled'),
    channelBotToken: document.getElementById('channelBotToken'),
    channelAllowFrom: document.getElementById('channelAllowFrom'),
    channelProxy: document.getElementById('channelProxy'),
    closeChannelModal: document.getElementById('closeChannelModal'),
    cancelChannelBtn: document.getElementById('cancelChannelBtn'),
    saveChannelBtn: document.getElementById('saveChannelBtn'),

    // Cache buttons
    revertConfigBtn: document.getElementById('revertConfigBtn'),
    saveCacheBtn: document.getElementById('saveCacheBtn'),
    cacheStatus: document.getElementById('cacheStatus'),

    // Commands
    cmdUsername: document.getElementById('cmdUsername'),
    cmdPath: document.getElementById('cmdPath'),
    commandsList: document.getElementById('commandsList'),

    // Agent extended settings
    subagentMaxConcurrent: document.getElementById('subagentMaxConcurrent'),
    sandboxMode: document.getElementById('sandboxMode')
};

// ===== 工具函数 =====

function showToast(message, type = 'success') {
    const icons = {
        success: '✓',
        error: '✗',
        warning: '!'
    };

    elements.toast.className = `toast ${type}`;
    elements.toast.querySelector('.toast-icon').textContent = icons[type] || icons.success;
    elements.toast.querySelector('.toast-message').textContent = message;
    elements.toast.classList.remove('hidden');

    setTimeout(() => {
        elements.toast.classList.add('hidden');
    }, 3000);
}

function generateToken(length = 48) {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let result = '';
    for (let i = 0; i < length; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
}

function getProviderIcon(name) {
    const icons = {
        'anthropic': '🤖',
        'openai': '🧠',
        'qwen': '🔮',
        'demo-api': '🧪',
        'default': '🏢'
    };
    return icons[name.toLowerCase()] || icons.default;
}

function getChannelIcon(type) {
    const icons = {
        'telegram': '✈️',
        'discord': '🎮',
        'whatsapp': '💬',
        'default': '📱'
    };
    return icons[type.toLowerCase()] || icons.default;
}

function getAllModels() {
    const models = [];
    const providers = config.models?.providers || {};

    for (const [providerName, provider] of Object.entries(providers)) {
        const providerModels = provider.models || [];
        for (const model of providerModels) {
            models.push({
                id: providerName + '/' + model.id,
                name: model.name || model.id,
                provider: providerName
            });
        }
    }

    return models;
}

// ===== 导航 =====

function initNavigation() {
    elements.navItems.forEach(item => {
        item.addEventListener('click', () => {
            const section = item.dataset.section;
            switchSection(section);
        });
    });
}

function switchSection(sectionId) {
    // Update navigation
    elements.navItems.forEach(item => {
        item.classList.toggle('active', item.dataset.section === sectionId);
    });

    // Update sections
    elements.sections.forEach(section => {
        section.classList.toggle('hidden', section.id !== `section-${sectionId}`);
    });

    // Refresh section content
    if (sectionId === 'raw') {
        elements.rawJson.value = JSON.stringify(config, null, 2);
    } else if (sectionId === 'agent') {
        renderAgentSettings();
    }
}

// ===== Provider 管理 =====

function renderProviders() {
    const providers = config.models?.providers || {};

    if (Object.keys(providers).length === 0) {
        elements.providersList.innerHTML = `
            <div class="empty-state">
                <div class="empty-state-icon">🏢</div>
                <div class="empty-state-text">暂无模型提供商</div>
                <button class="btn btn-primary" onclick="openProviderModal()">
                    <span class="icon">+</span> 添加第一个提供商
                </button>
            </div>
        `;
        return;
    }

    let html = '';
    for (const [name, provider] of Object.entries(providers)) {
        const models = provider.models || [];
        const provChecked = selectedProviders.has(name) ? 'checked' : '';
        html += `
            <div class="provider-card" data-provider="${name}">
                <div class="provider-header" onclick="toggleProvider('${name}')">
                    <div class="provider-info">
                        <input type="checkbox" class="provider-checkbox" data-provider="${name}" ${provChecked}
                            onclick="event.stopPropagation(); toggleSelectProvider('${name}', this.checked)">
                        <div class="provider-icon">${getProviderIcon(name)}</div>
                        <div>
                            <div class="provider-name">${name}</div>
                            <div class="provider-url">${provider.baseUrl || ''}</div>
                        </div>
                    </div>
                    <div class="provider-actions">
                        <button class="btn btn-secondary btn-sm" onclick="event.stopPropagation(); openProviderModal('${name}')">编辑</button>
                        <button class="btn btn-danger btn-sm" onclick="event.stopPropagation(); deleteProvider('${name}')">删除</button>
                    </div>
                </div>
                <div class="provider-body" id="provider-body-${name}">
                    <div class="model-list">
                        ${models.map((model, index) => {
                            const mKey = name + '/' + model.id;
                            const mChecked = selectedModels.has(mKey) ? 'checked' : '';
                            return `
                            <div class="model-item">
                                <input type="checkbox" class="model-checkbox" data-key="${mKey}" ${mChecked}
                                    onclick="toggleSelectModel('${mKey}', '${name}', ${index}, this.checked)">
                                <div class="model-info">
                                    <div class="model-id">${model.id}</div>
                                    <div class="model-meta">
                                        <span>${model.name || ''}</span>
                                        ${model.reasoning ? '<span class="model-badge">🧠 推理</span>' : ''}
                                        ${model.input?.includes('image') ? '<span class="model-badge">👁️ 视觉</span>' : ''}
                                    </div>
                                </div>
                                <div class="model-actions">
                                    <button class="btn btn-icon" onclick="openModelModal('${name}', ${index})">✏️</button>
                                    <button class="btn btn-icon" onclick="deleteModel('${name}', ${index})">🗑️</button>
                                </div>
                            </div>`;
                        }).join('')}
                    </div>
                    <button class="add-model-btn" onclick="openModelModal('${name}')">
                        + 添加模型
                    </button>
                </div>
            </div>
        `;
    }

    elements.providersList.innerHTML = html;
}

// ===== 多选 & 复制粘贴 =====

function toggleSelectProvider(name, checked) {
    if (checked) { selectedProviders.add(name); } else { selectedProviders.delete(name); }
}

function toggleSelectModel(key, providerName, index, checked) {
    if (checked) { selectedModels.set(key, { providerName, index }); } else { selectedModels.delete(key); }
}

function copySelectedProviders() {
    const clip = { providers: {} };
    const provs = config.models?.providers || {};

    // 整个提供商被选中 → 拷贝整体
    for (const name of selectedProviders) {
        if (provs[name]) clip.providers[name] = JSON.parse(JSON.stringify(provs[name]));
    }

    // 单独被勾选的模型 → 也加入对应提供商
    for (const [key, { providerName, index }] of selectedModels) {
        if (selectedProviders.has(providerName)) continue; // 整体已包含
        if (!provs[providerName]) continue;
        const model = provs[providerName].models?.[index];
        if (!model) continue;
        if (!clip.providers[providerName]) {
            // 只复制提供商头信息 + 选中的模型
            const { models, ...meta } = JSON.parse(JSON.stringify(provs[providerName]));
            clip.providers[providerName] = { ...meta, models: [] };
        }
        clip.providers[providerName].models.push(JSON.parse(JSON.stringify(model)));
    }

    if (Object.keys(clip.providers).length === 0) {
        showToast('请先勾选要复制的提供商或模型', 'warning');
        return;
    }

    localStorage.setItem(CLIPBOARD_KEY, JSON.stringify(clip));
    const pCount = Object.keys(clip.providers).length;
    const mCount = Object.values(clip.providers).reduce((s, p) => s + (p.models?.length || 0), 0);
    showToast(`已复制 ${pCount} 个提供商，${mCount} 个模型 📋`);
}

function copyAllProviders() {
    const provs = config.models?.providers || {};
    if (Object.keys(provs).length === 0) {
        showToast('暂无提供商可复制', 'warning');
        return;
    }
    const clip = { providers: JSON.parse(JSON.stringify(provs)) };
    localStorage.setItem(CLIPBOARD_KEY, JSON.stringify(clip));
    const mCount = Object.values(provs).reduce((s, p) => s + (p.models?.length || 0), 0);
    showToast(`已复制全部 ${Object.keys(provs).length} 个提供商，${mCount} 个模型 📚`);
}

function pasteProviders() {
    const raw = localStorage.getItem(CLIPBOARD_KEY);
    if (!raw) { showToast('剪贴板为空', 'warning'); return; }

    let clip;
    try { clip = JSON.parse(raw); } catch { showToast('剪贴板数据无效', 'error'); return; }
    if (!clip.providers || Object.keys(clip.providers).length === 0) { showToast('剪贴板无提供商数据', 'warning'); return; }

    if (!config.models) config.models = { providers: {} };
    if (!config.models.providers) config.models.providers = {};

    let addedP = 0, addedM = 0, mergedM = 0;
    for (const [name, provider] of Object.entries(clip.providers)) {
        if (!config.models.providers[name]) {
            // 新提供商：直接添加
            config.models.providers[name] = JSON.parse(JSON.stringify(provider));
            addedP++;
            addedM += provider.models?.length || 0;
        } else {
            // 同名提供商：合并模型（同 ID 覆盖）
            const existing = config.models.providers[name];
            if (!existing.models) existing.models = [];
            for (const model of (provider.models || [])) {
                const idx = existing.models.findIndex(m => m.id === model.id);
                if (idx >= 0) { existing.models[idx] = JSON.parse(JSON.stringify(model)); mergedM++; }
                else { existing.models.push(JSON.parse(JSON.stringify(model))); addedM++; }
            }
            // 更新 baseUrl / apiKey / api（如果剪贴板中有值）
            if (provider.baseUrl) existing.baseUrl = provider.baseUrl;
            if (provider.apiKey) existing.apiKey = provider.apiKey;
            if (provider.api) existing.api = provider.api;
        }
    }

    renderProviders();
    updateModelSelectors();
    onConfigChanged();
    showToast(`粘贴完成：新增 ${addedP} 个提供商、${addedM} 个模型，覆盖 ${mergedM} 个同名模型 ✓`);
}

function clearSelection() {
    selectedProviders.clear();
    selectedModels.clear();
    renderProviders();
    showToast('已清空选择');
}

window.toggleSelectProvider = toggleSelectProvider;
window.toggleSelectModel = toggleSelectModel;

function toggleProvider(name) {
    const body = document.getElementById(`provider-body-${name}`);
    if (body) {
        body.classList.toggle('collapsed');
    }
}

function openProviderModal(name = null) {
    editingProvider = name;

    if (name) {
        // 编辑模式
        elements.providerModalTitle.textContent = '编辑提供商';
        const provider = config.models.providers[name];
        elements.providerName.value = name;
        elements.providerName.disabled = false; // 允许修改名称
        elements.providerBaseUrl.value = provider.baseUrl || '';
        elements.providerApiKey.value = provider.apiKey || '';
        elements.providerApiMode.value = provider.api || provider.models?.[0]?.api || 'openai-completions';
    } else {
        // 添加模式
        elements.providerModalTitle.textContent = '添加提供商';
        elements.providerName.value = '';
        elements.providerName.disabled = false;
        elements.providerBaseUrl.value = '';
        elements.providerApiKey.value = '';
        elements.providerApiMode.value = 'openai-completions';
    }

    elements.providerModal.classList.remove('hidden');
}

function closeProviderModalHandler() {
    elements.providerModal.classList.add('hidden');
    editingProvider = null;
}

function saveProvider() {
    const name = elements.providerName.value.trim();
    const baseUrl = elements.providerBaseUrl.value.trim();
    const apiKey = elements.providerApiKey.value.trim();
    const apiMode = elements.providerApiMode.value;

    if (!name) {
        showToast('请输入提供商名称', 'error');
        return;
    }

    if (!baseUrl) {
        showToast('请输入 API Base URL', 'error');
        return;
    }

    if (!apiKey) {
        showToast('请输入 API Key', 'error');
        return;
    }

    if (!config.models) {
        config.models = { providers: {} };
    }
    if (!config.models.providers) {
        config.models.providers = {};
    }

    // 检查是否重命名了提供商
    const isRenaming = editingProvider && editingProvider !== name;

    // 如果重命名，检查新名称是否已存在
    if (isRenaming && config.models.providers[name]) {
        showToast(`提供商 "${name}" 已存在，请使用其他名称`, 'error');
        return;
    }

    // 获取现有模型
    const existingModels = editingProvider ? (config.models.providers[editingProvider]?.models || []) : [];

    // 如果是重命名，删除旧的提供商
    if (isRenaming) {
        delete config.models.providers[editingProvider];

        // 更新 Agent 设置中的模型引用
        updateModelReferences(editingProvider, name);
    }

    config.models.providers[name] = {
        baseUrl: baseUrl,
        apiKey: apiKey,
        api: apiMode,
        models: existingModels
    };

    closeProviderModalHandler();
    renderProviders();
    updateModelSelectors();
    onConfigChanged();
    showToast(editingProvider ? (isRenaming ? '提供商已重命名' : '提供商已更新') : '提供商已添加');
}

function deleteProvider(name) {
    if (!confirm(`确定要删除提供商 "${name}" 吗？这将同时删除所有相关模型。`)) {
        return;
    }

    delete config.models.providers[name];
    renderProviders();
    updateModelSelectors();
    onConfigChanged();
    showToast('提供商已删除');
}

// 更新模型引用（当提供商重命名时）
function updateModelReferences(oldProviderName, newProviderName) {
    // 更新主模型
    if (config.agents?.defaults?.model?.primary) {
        const primary = config.agents.defaults.model.primary;
        if (primary.startsWith(oldProviderName + '/')) {
            config.agents.defaults.model.primary = primary.replace(oldProviderName + '/', newProviderName + '/');
        }
    }

    // 更新备用模型
    if (config.agents?.defaults?.model?.fallbacks) {
        config.agents.defaults.model.fallbacks = config.agents.defaults.model.fallbacks.map(fallback => {
            if (fallback.startsWith(oldProviderName + '/')) {
                return fallback.replace(oldProviderName + '/', newProviderName + '/');
            }
            return fallback;
        });
    }

    // 更新模型别名
    if (config.agents?.defaults?.models) {
        const newModels = {};
        for (const [key, value] of Object.entries(config.agents.defaults.models)) {
            if (key.startsWith(oldProviderName + '/')) {
                const newKey = key.replace(oldProviderName + '/', newProviderName + '/');
                newModels[newKey] = value;
            } else {
                newModels[key] = value;
            }
        }
        config.agents.defaults.models = newModels;
    }
}

// ===== Model 管理 =====

function openModelModal(providerName, modelIndex = null) {
    elements.modelProviderName.value = providerName;
    editingModel = modelIndex;

    if (modelIndex !== null) {
        // 编辑模式
        elements.modelModalTitle.textContent = '编辑模型';
        const model = config.models.providers[providerName].models[modelIndex];
        elements.modelId.value = model.id || '';
        elements.modelName.value = model.name || '';
        elements.modelContextWindow.value = model.contextWindow || 200000;
        elements.modelMaxTokens.value = model.maxTokens || 32000;
        elements.modelReasoning.checked = model.reasoning !== false;
        elements.modelVision.checked = model.input?.includes('image') !== false;
        if (elements.modelApiMode) {
            elements.modelApiMode.value = model.api || config.models.providers[providerName].api || 'openai-completions';
        }
    } else {
        // 添加模式
        elements.modelModalTitle.textContent = '添加模型';
        elements.modelId.value = '';
        elements.modelName.value = '';
        elements.modelContextWindow.value = 200000;
        elements.modelMaxTokens.value = 32000;
        elements.modelReasoning.checked = true;
        elements.modelVision.checked = true;
        if (elements.modelApiMode) {
            elements.modelApiMode.value = config.models.providers[providerName]?.api || 'openai-completions';
        }
    }

    elements.modelModal.classList.remove('hidden');
}

function closeModelModalHandler() {
    elements.modelModal.classList.add('hidden');
    editingModel = null;
}

function saveModel() {
    const providerName = elements.modelProviderName.value;
    const modelId = elements.modelId.value.trim();
    const modelName = elements.modelName.value.trim();
    const contextWindow = parseInt(elements.modelContextWindow.value) || 200000;
    const maxTokens = parseInt(elements.modelMaxTokens.value) || 32000;
    const reasoning = elements.modelReasoning.checked;
    const vision = elements.modelVision.checked;

    if (!modelId) {
        showToast('请输入模型 ID', 'error');
        return;
    }

    const modelApiMode = elements.modelApiMode ? elements.modelApiMode.value : null;
    const model = {
        id: modelId,
        name: modelName || modelId,
        ...(modelApiMode ? { api: modelApiMode } : {}),
        reasoning: reasoning,
        input: vision ? ['text', 'image'] : ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: contextWindow,
        maxTokens: maxTokens
    };

    const provider = config.models.providers[providerName];
    if (!provider.models) {
        provider.models = [];
    }

    if (editingModel !== null) {
        provider.models[editingModel] = model;
    } else {
        provider.models.push(model);
    }

    closeModelModalHandler();
    renderProviders();
    updateModelSelectors();
    onConfigChanged();
    showToast(editingModel !== null ? '模型已更新' : '模型已添加');
}

function deleteModel(providerName, modelIndex) {
    const model = config.models.providers[providerName].models[modelIndex];
    if (!confirm(`确定要删除模型 "${model.id}" 吗？`)) {
        return;
    }

    config.models.providers[providerName].models.splice(modelIndex, 1);
    renderProviders();
    updateModelSelectors();
    onConfigChanged();
    showToast('模型已删除');
}

// ===== Agent 设置 =====

function renderAgentSettings() {
    updateModelSelectors();

    const defaults = config.agents?.defaults || {};
    elements.workspace.value = defaults.workspace || '';
    elements.maxConcurrent.value = defaults.maxConcurrent || 4;

    // 子 Agent 并发数
    if (elements.subagentMaxConcurrent) {
        elements.subagentMaxConcurrent.value = defaults.subagents?.maxConcurrent || 8;
    }

    // 沙箱模式
    if (elements.sandboxMode) {
        elements.sandboxMode.value = defaults.sandbox?.mode || '';
    }

    // Render fallback models
    renderFallbackModels();
}

function updateModelSelectors() {
    const models = getAllModels();
    const primary = config.agents?.defaults?.model?.primary || '';

    let optionsHtml = '<option value="">选择模型...</option>';
    models.forEach(model => {
        const selected = model.id === primary ? 'selected' : '';
        optionsHtml += `<option value="${model.id}" ${selected}>${model.id} (${model.name})</option>`;
    });

    elements.primaryModel.innerHTML = optionsHtml;
}

function renderFallbackModels() {
    const fallbacks = config.agents?.defaults?.model?.fallbacks || [];
    const allModels = getAllModels();

    let html = '';
    fallbacks.forEach((fallback, index) => {
        let optionsHtml = '<option value="">选择模型...</option>';
        allModels.forEach(model => {
            const selected = model.id === fallback ? 'selected' : '';
            optionsHtml += `<option value="${model.id}" ${selected}>${model.id}</option>`;
        });

        html += `
            <div class="fallback-item">
                <select class="select fallback-select" data-index="${index}" onchange="updateFallback(${index}, this.value)">
                    ${optionsHtml}
                </select>
                <button class="btn btn-icon" onclick="removeFallback(${index})">🗑️</button>
            </div>
        `;
    });

    elements.fallbackModels.innerHTML = html;
}

function addFallback() {
    if (!config.agents) config.agents = { defaults: { model: { fallbacks: [] } } };
    if (!config.agents.defaults) config.agents.defaults = { model: { fallbacks: [] } };
    if (!config.agents.defaults.model) config.agents.defaults.model = { fallbacks: [] };
    if (!config.agents.defaults.model.fallbacks) config.agents.defaults.model.fallbacks = [];

    config.agents.defaults.model.fallbacks.push('');
    renderFallbackModels();
    onConfigChanged();
}

function updateFallback(index, value) {
    config.agents.defaults.model.fallbacks[index] = value;
    onConfigChanged();
}

function removeFallback(index) {
    config.agents.defaults.model.fallbacks.splice(index, 1);
    renderFallbackModels();
    onConfigChanged();
}

// ===== Channel 管理 =====

function renderChannels() {
    const channels = config.channels || {};

    if (Object.keys(channels).length === 0) {
        elements.channelsList.innerHTML = `
            <div class="empty-state">
                <div class="empty-state-icon">📱</div>
                <div class="empty-state-text">暂无渠道配置</div>
                <button class="btn btn-primary" onclick="openChannelModal()">
                    <span class="icon">+</span> 添加渠道
                </button>
            </div>
        `;
        return;
    }

    let html = '';
    for (const [type, channel] of Object.entries(channels)) {
        html += `
            <div class="channel-card" data-channel="${type}">
                <div class="channel-header">
                    <div class="channel-info">
                        <span class="channel-icon">${getChannelIcon(type)}</span>
                        <span class="channel-name">${type.charAt(0).toUpperCase() + type.slice(1)}</span>
                    </div>
                    <div>
                        <span class="channel-status ${channel.enabled ? 'enabled' : 'disabled'}">
                            ${channel.enabled ? '已启用' : '已禁用'}
                        </span>
                    </div>
                </div>
                <div class="form-group">
                    <label>Bot Token</label>
                    <input type="password" class="input" value="${channel.botToken || ''}" readonly>
                </div>
                ${channel.allowFrom ? `
                    <div class="form-group">
                        <label>允许的用户</label>
                        <div class="model-meta">${channel.allowFrom.join(', ')}</div>
                    </div>
                ` : ''}
                ${channel.proxy ? `
                    <div class="form-group">
                        <label>代理</label>
                        <div class="model-meta">${channel.proxy}</div>
                    </div>
                ` : ''}
                <div style="display: flex; gap: 8px; margin-top: 16px;">
                    <button class="btn btn-secondary btn-sm" onclick="openChannelModal('${type}')">编辑</button>
                    <button class="btn btn-danger btn-sm" onclick="deleteChannel('${type}')">删除</button>
                </div>
            </div>
        `;
    }

    elements.channelsList.innerHTML = html;
}

function openChannelModal(type = null) {
    editingChannel = type;

    if (type) {
        elements.channelModalTitle.textContent = '编辑渠道';
        const channel = config.channels[type];
        elements.channelType.value = type;
        elements.channelType.disabled = true;
        elements.channelEnabled.checked = channel.enabled !== false;
        elements.channelBotToken.value = channel.botToken || '';
        elements.channelAllowFrom.value = (channel.allowFrom || []).join(', ');
        elements.channelProxy.value = channel.proxy || '';
    } else {
        elements.channelModalTitle.textContent = '添加渠道';
        elements.channelType.value = 'telegram';
        elements.channelType.disabled = false;
        elements.channelEnabled.checked = true;
        elements.channelBotToken.value = '';
        elements.channelAllowFrom.value = '';
        elements.channelProxy.value = '';
    }

    elements.channelModal.classList.remove('hidden');
}

function closeChannelModalHandler() {
    elements.channelModal.classList.add('hidden');
    editingChannel = null;
}

function saveChannel() {
    const type = elements.channelType.value;
    const enabled = elements.channelEnabled.checked;
    const botToken = elements.channelBotToken.value.trim();
    const allowFromStr = elements.channelAllowFrom.value.trim();
    const proxy = elements.channelProxy.value.trim();

    if (!botToken) {
        showToast('请输入 Bot Token', 'error');
        return;
    }

    const allowFrom = allowFromStr
        ? allowFromStr.split(',').map(s => {
            const num = parseInt(s.trim());
            return isNaN(num) ? s.trim() : num;
        })
        : [];

    if (!config.channels) config.channels = {};

    config.channels[type] = {
        enabled: enabled,
        dmPolicy: 'pairing',
        botToken: botToken,
        allowFrom: allowFrom,
        groupPolicy: 'allowlist',
        streamMode: 'partial',
        ...(proxy ? { proxy: proxy } : {})
    };

    // Update plugins
    if (!config.plugins) config.plugins = { entries: {} };
    if (!config.plugins.entries) config.plugins.entries = {};
    config.plugins.entries[type] = { enabled: enabled };

    closeChannelModalHandler();
    renderChannels();
    onConfigChanged();
    showToast(editingChannel ? '渠道已更新' : '渠道已添加');
}

function deleteChannel(type) {
    if (!confirm(`确定要删除渠道 "${type}" 吗？`)) {
        return;
    }

    delete config.channels[type];
    if (config.plugins?.entries) {
        delete config.plugins.entries[type];
    }

    renderChannels();
    onConfigChanged();
    showToast('渠道已删除');
}

// ===== Gateway 设置 =====

function renderGateway() {
    const gateway = config.gateway || {};
    elements.gatewayPort.value = gateway.port || 18789;
    elements.gatewayBind.value = gateway.bind || 'loopback';
    elements.gatewayToken.value = gateway.auth?.token || '';
}

function saveGatewaySettings() {
    if (!config.gateway) config.gateway = {};

    config.gateway.port = parseInt(elements.gatewayPort.value) || 18789;
    config.gateway.bind = elements.gatewayBind.value;

    if (!config.gateway.auth) config.gateway.auth = { mode: 'token' };
    config.gateway.auth.token = elements.gatewayToken.value;
}

// ===== Raw JSON =====

function updateRawJson() {
    try {
        config = JSON.parse(elements.rawJson.value);
        renderAll();
        showToast('配置已更新');
    } catch (e) {
        showToast('JSON 格式错误: ' + e.message, 'error');
    }
}

function formatJson() {
    try {
        const parsed = JSON.parse(elements.rawJson.value);
        elements.rawJson.value = JSON.stringify(parsed, null, 2);
        showToast('JSON 已格式化');
    } catch (e) {
        showToast('JSON 格式错误: ' + e.message, 'error');
    }
}

// ===== 导入/导出 =====

function importConfig() {
    elements.fileInput.click();
}

function handleFileImport(event) {
    const file = event.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (e) => {
        try {
            config = JSON.parse(e.target.result);
            renderAll();
            showToast(`配置文件 "${file.name}" 已导入`);
        } catch (err) {
            showToast('无法解析配置文件: ' + err.message, 'error');
        }
    };
    reader.readAsText(file);

    // Reset file input
    event.target.value = '';
}

function exportConfig() {
    // Update config from form fields
    saveAllSettings();

    // Update meta
    config.meta = config.meta || {};
    config.meta.lastTouchedAt = new Date().toISOString();

    const json = JSON.stringify(config, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);

    const a = document.createElement('a');
    a.href = url;
    a.download = 'openclaw.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    showToast('配置已导出为 openclaw.json');
}

function saveAllSettings() {
    // Agent settings
    if (!config.agents) config.agents = { defaults: {} };
    if (!config.agents.defaults) config.agents.defaults = {};
    if (!config.agents.defaults.model) config.agents.defaults.model = {};

    config.agents.defaults.model.primary = elements.primaryModel.value;
    config.agents.defaults.workspace = elements.workspace.value;
    config.agents.defaults.maxConcurrent = parseInt(elements.maxConcurrent.value) || 4;

    // Gateway settings
    saveGatewaySettings();
}

// ===== 初始化 =====

function renderAll() {
    renderProviders();
    renderAgentSettings();
    renderChannels();
    renderGateway();
}

function initEventListeners() {
    // Navigation
    initNavigation();

    // Import/Export
    elements.importBtn.addEventListener('click', importConfig);
    elements.exportBtn.addEventListener('click', exportConfig);
    elements.fileInput.addEventListener('change', handleFileImport);

    // Provider Modal
    elements.addProviderBtn.addEventListener('click', () => openProviderModal());
    elements.closeProviderModal.addEventListener('click', closeProviderModalHandler);
    elements.cancelProviderBtn.addEventListener('click', closeProviderModalHandler);
    elements.saveProviderBtn.addEventListener('click', saveProvider);

    // Model Modal
    elements.closeModelModal.addEventListener('click', closeModelModalHandler);
    elements.cancelModelBtn.addEventListener('click', closeModelModalHandler);
    elements.saveModelBtn.addEventListener('click', saveModel);

    // Channel Modal
    elements.addChannelBtn.addEventListener('click', () => openChannelModal());
    elements.closeChannelModal.addEventListener('click', closeChannelModalHandler);
    elements.cancelChannelBtn.addEventListener('click', closeChannelModalHandler);
    elements.saveChannelBtn.addEventListener('click', saveChannel);

    // Agent settings
    elements.addFallbackBtn.addEventListener('click', addFallback);
    elements.primaryModel.addEventListener('change', (e) => {
        if (!config.agents) config.agents = { defaults: { model: {} } };
        if (!config.agents.defaults) config.agents.defaults = { model: {} };
        if (!config.agents.defaults.model) config.agents.defaults.model = {};
        config.agents.defaults.model.primary = e.target.value;
        onConfigChanged();
    });

    // Gateway settings
    elements.toggleTokenBtn.addEventListener('click', () => {
        const type = elements.gatewayToken.type;
        elements.gatewayToken.type = type === 'password' ? 'text' : 'password';
    });
    elements.generateTokenBtn.addEventListener('click', () => {
        elements.gatewayToken.value = generateToken();
        saveGatewaySettings();
        onConfigChanged();
        showToast('已生成新的认证 Token');
    });

    // Raw JSON
    elements.formatJsonBtn.addEventListener('click', formatJson);
    elements.rawJson.addEventListener('blur', updateRawJson);

    // Close modals on overlay click
    [elements.providerModal, elements.modelModal, elements.channelModal].forEach(modal => {
        modal.addEventListener('click', (e) => {
            if (e.target === modal) modal.classList.add('hidden');
        });
    });

    // Close new modals on overlay click
    ['nodeModal', 'rescueModal', 'installModal'].forEach(id => {
        const modal = document.getElementById(id);
        if (modal) modal.addEventListener('click', (e) => {
            if (e.target === modal) modal.classList.add('hidden');
        });
    });

    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            elements.providerModal.classList.add('hidden');
            elements.modelModal.classList.add('hidden');
            elements.channelModal.classList.add('hidden');
            ['nodeModal', 'rescueModal', 'installModal'].forEach(id => {
                const m = document.getElementById(id);
                if (m) m.classList.add('hidden');
            });
        }
    });
}

// Start the app
document.addEventListener('DOMContentLoaded', async () => {
    initTheme();
    initEventListeners();
    initAgentSettingsListeners();

    // 自动加载示例数据
    await loadExampleConfig();

    renderAll();
    showToast('欢迎使用 OpenClaw 配置管理器 🦞', 'success');
});

// 自动加载本地配置文件（优先）或示例配置
async function loadExampleConfig() {
    try {
        // 优先尝试从服务器加载本地配置
        const localResponse = await apiFetch('/api/config');
        if (localResponse.ok) {
            const data = await localResponse.json();
            if (data.exists && data.config) {
                config = data.config;
                cachedConfig = JSON.parse(JSON.stringify(config));
                isModified = false;
                console.log('Loaded local config from:', data.path);
                showToast('已加载本地配置文件 ✓', 'success');
                return;
            }
        }
    } catch (e) {
        console.log('Failed to load local config:', e.message);
    }
    
    // 回退到示例配置
    try {
        const response = await fetch('openclaw-example.json');
        if (response.ok) {
            const exampleConfig = await response.json();
            config = exampleConfig;
            cachedConfig = JSON.parse(JSON.stringify(config));
            isModified = false;
            console.log('Loaded example config');
        }
    } catch (e) {
        console.log('No example config found, using default');
    }
}

// 保存到当前节点（本地或远程）
async function saveToLocalServer() {
    // 先保存所有表单设置
    saveAllSettings();
    
    // 更新 meta
    config.meta = config.meta || {};
    config.meta.lastTouchedAt = new Date().toISOString();
    
    // 判断当前是本地还是远程节点
    if (!activeNodeId) {
        // 保存到本地
        try {
            const response = await apiFetch('/api/config', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ config })
            });
            
            const data = await response.json();
            
            if (data.success) {
                cachedConfig = JSON.parse(JSON.stringify(config));
                isModified = false;
                updateCacheStatus();
                
                let msg = '配置已保存到本地 ✓';
                if (data.backup) {
                    msg += `\n备份: ${data.backup}`;
                }
                showToast(msg, 'success');
            } else if (data.validation && !data.validation.valid) {
                const errors = data.validation.errors.join('\n');
                showToast('配置验证失败:\n' + errors, 'error');
            } else {
                showToast('保存失败: ' + (data.message || '未知错误'), 'error');
            }
        } catch (e) {
            showToast('保存失败: ' + e.message, 'error');
        }
    } else {
        // 保存到远程节点
        const node = nodes.find(n => n.id === activeNodeId);
        if (!node) {
            showToast('节点不存在', 'error');
            return;
        }
        
        try {
            const data = await nodeFetch(node, '/config', {
                method: 'POST',
                body: JSON.stringify({ config })
            });
            
            if (data.ok) {
                cachedConfig = JSON.parse(JSON.stringify(config));
                isModified = false;
                updateCacheStatus();
                showToast(`配置已保存到 ${node.name} ✓`);
            } else {
                showToast('保存失败: ' + (data.error || '未知错误'), 'error');
            }
        } catch (e) {
            showToast('保存失败: ' + e.message, 'error');
        }
    }
}

// 验证当前配置
async function validateCurrentConfig() {
    try {
        const response = await apiFetch('/api/config/validate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ config })
        });
        
        const data = await response.json();
        
        if (data.valid) {
            showToast('配置验证通过 ✓', 'success');
        } else {
            const errors = data.errors.join('\n');
            showToast('配置验证失败:\n' + errors, 'error');
        }
        
        return data;
    } catch (e) {
        showToast('验证失败: ' + e.message, 'error');
        return { valid: false, errors: [e.message] };
    }
}

// 加载备份列表
async function loadBackups() {
    try {
        const response = await apiFetch('/api/backups');
        const data = await response.json();
        return data.backups || [];
    } catch (e) {
        console.error('Failed to load backups:', e);
        return [];
    }
}

// 从备份恢复
async function restoreFromBackup(backupName) {
    if (!confirm(`确定要从备份 "${backupName}" 恢复吗？\n当前配置将被备份。`)) {
        return;
    }
    
    try {
        const response = await apiFetch('/api/restore', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ backup: backupName })
        });
        
        const data = await response.json();
        
        if (data.success) {
            config = data.config;
            cachedConfig = JSON.parse(JSON.stringify(config));
            isModified = false;
            renderAll();
            updateCacheStatus();
            updateRawJsonDisplay();
            showToast(`已从备份恢复 ✓\n${data.currentBackup ? '当前配置已备份到: ' + data.currentBackup : ''}`, 'success');
        } else {
            showToast('恢复失败: ' + (data.message || '未知错误'), 'error');
        }
    } catch (e) {
        showToast('恢复失败: ' + e.message, 'error');
    }
}

// Agent 设置事件监听
function initAgentSettingsListeners() {
    // 工作区路径
    if (elements.workspace) {
        elements.workspace.addEventListener('change', () => {
            if (!config.agents) config.agents = { defaults: {} };
            if (!config.agents.defaults) config.agents.defaults = {};
            config.agents.defaults.workspace = elements.workspace.value;
            onConfigChanged();
        });
    }

    // 最大并发数
    if (elements.maxConcurrent) {
        elements.maxConcurrent.addEventListener('change', () => {
            if (!config.agents) config.agents = { defaults: {} };
            if (!config.agents.defaults) config.agents.defaults = {};
            config.agents.defaults.maxConcurrent = parseInt(elements.maxConcurrent.value) || 4;
            onConfigChanged();
        });
    }

    // 子 Agent 并发数
    if (elements.subagentMaxConcurrent) {
        elements.subagentMaxConcurrent.addEventListener('change', () => {
            if (!config.agents) config.agents = { defaults: {} };
            if (!config.agents.defaults) config.agents.defaults = {};
            if (!config.agents.defaults.subagents) config.agents.defaults.subagents = {};
            config.agents.defaults.subagents.maxConcurrent = parseInt(elements.subagentMaxConcurrent.value) || 8;
            onConfigChanged();
        });
    }

    // 沙盒模式
    if (elements.sandboxMode) {
        elements.sandboxMode.addEventListener('change', () => {
            if (!config.agents) config.agents = { defaults: {} };
            if (!config.agents.defaults) config.agents.defaults = {};
            if (elements.sandboxMode.value) {
                if (!config.agents.defaults.sandbox) config.agents.defaults.sandbox = {};
                config.agents.defaults.sandbox.mode = elements.sandboxMode.value;
            } else {
                delete config.agents.defaults.sandbox;
            }
            onConfigChanged();
        });
    }
}

// ===== 主题切换 =====

function initTheme() {
    const savedTheme = localStorage.getItem('openclaw-theme') || 'light';
    document.documentElement.setAttribute('data-theme', savedTheme);
    updateThemeIcon(savedTheme);
}

function toggleTheme() {
    const currentTheme = document.documentElement.getAttribute('data-theme') || 'dark';
    const newTheme = currentTheme === 'dark' ? 'light' : 'dark';

    document.documentElement.setAttribute('data-theme', newTheme);
    localStorage.setItem('openclaw-theme', newTheme);
    updateThemeIcon(newTheme);

    showToast(`已切换到${newTheme === 'dark' ? '深色' : '明亮'}主题`);
}

function updateThemeIcon(theme) {
    const themeToggle = document.getElementById('themeToggle');
    if (themeToggle) {
        themeToggle.textContent = theme === 'dark' ? '🌙' : '☀️';
        themeToggle.title = theme === 'dark' ? '切换到明亮主题' : '切换到深色主题';
    }
}

// Add theme toggle event listener
document.addEventListener('DOMContentLoaded', () => {
    const themeToggle = document.getElementById('themeToggle');
    if (themeToggle) {
        themeToggle.addEventListener('click', toggleTheme);
    }
});

// Expose functions to global scope for inline handlers
window.openProviderModal = openProviderModal;
window.toggleProvider = toggleProvider;
window.deleteProvider = deleteProvider;
window.openModelModal = openModelModal;
window.deleteModel = deleteModel;
window.openChannelModal = openChannelModal;
window.deleteChannel = deleteChannel;
window.updateFallback = updateFallback;
window.removeFallback = removeFallback;
window.toggleTheme = toggleTheme;
window.copyCommand = copyCommand;
window.saveToLocalServer = saveToLocalServer;
window.validateCurrentConfig = validateCurrentConfig;
window.restoreFromBackup = restoreFromBackup;
window.renderBackupsList = renderBackupsList;

// ===== 实时同步 =====

// 每次配置变化时调用此函数
function onConfigChanged() {
    isModified = true;
    updateCacheStatus();
    updateRawJsonDisplay();

    // 如果当前在命令页面，重新渲染命令（确保写入配置命令包含最新配置）
    const commandsSection = document.getElementById('section-commands');
    if (commandsSection && !commandsSection.classList.contains('hidden')) {
        renderCommands();
    }
}

// 更新原始 JSON 显示
function updateRawJsonDisplay() {
    if (elements.rawJson) {
        elements.rawJson.value = JSON.stringify(config, null, 2);
    }
}

// 监听原始 JSON 的实时输入
function initRawJsonSync() {
    if (elements.rawJson) {
        elements.rawJson.addEventListener('input', () => {
            try {
                const parsed = JSON.parse(elements.rawJson.value);
                config = parsed;
                isModified = true;
                updateCacheStatus();
            } catch (e) {
                // JSON 格式不正确时不更新
            }
        });
    }
}

// ===== 缓存控制 =====

function updateCacheStatus() {
    if (!elements.cacheStatus) return;

    const statusText = elements.cacheStatus.querySelector('.status-text');

    if (!cachedConfig) {
        elements.cacheStatus.className = 'cache-status';
        statusText.textContent = '未导入配置';
    } else if (isModified) {
        elements.cacheStatus.className = 'cache-status modified';
        statusText.textContent = '已修改（未保存）';
    } else {
        elements.cacheStatus.className = 'cache-status saved';
        statusText.textContent = '已保存';
    }
}

function saveToCache() {
    cachedConfig = JSON.parse(JSON.stringify(config));
    isModified = false;
    updateCacheStatus();

    // 保存到 localStorage
    localStorage.setItem('openclaw-cache', JSON.stringify(config));
    localStorage.setItem('openclaw-cache-time', new Date().toISOString());

    showToast('配置已保存到缓存 💾');
}

function revertToCache() {
    if (!cachedConfig) {
        showToast('没有可恢复的缓存版本', 'warning');
        return;
    }

    if (!confirm('确定要恢复到上传时的版本吗？当前修改将丢失。')) {
        return;
    }

    config = JSON.parse(JSON.stringify(cachedConfig));
    isModified = false;
    renderAll();
    updateCacheStatus();
    showToast('已恢复到缓存版本 ↩️');
}

function loadFromLocalStorage() {
    const cached = localStorage.getItem('openclaw-cache');
    if (cached) {
        try {
            const parsed = JSON.parse(cached);
            const cacheTime = localStorage.getItem('openclaw-cache-time');
            if (confirm(`发现本地缓存（${cacheTime ? new Date(cacheTime).toLocaleString() : '未知时间'}），是否加载？`)) {
                config = parsed;
                cachedConfig = JSON.parse(JSON.stringify(parsed));
                isModified = false;
                renderAll();
                updateCacheStatus();
                showToast('已从本地缓存加载配置');
                return true;
            }
        } catch (e) {
            console.error('Failed to load cache:', e);
        }
    }
    return false;
}

// ===== 常用命令生成 =====

function getCommands() {
    const username = elements.cmdUsername?.value || 'root';
    const basePath = elements.cmdPath?.value || `/Users/${username}/.openclaw/`;
    const configPath = basePath + 'openclaw.json';
    const jsonContent = JSON.stringify(config, null, 2).replace(/'/g, "'\\''");

    return [
        {
            id: 'stop-gateway',
            icon: '🛑',
            title: '停止网关',
            command: 'openclaw gateway stop',
            description: '停止 OpenClaw 网关服务'
        },
        {
            id: 'start-gateway',
            icon: '🚀',
            title: '启动网关',
            command: 'openclaw gateway start',
            description: '启动 OpenClaw 网关服务'
        },
        {
            id: 'restart-gateway',
            icon: '🔄',
            title: '重启网关',
            command: 'openclaw gateway restart',
            description: '重启 OpenClaw 网关服务'
        },
        {
            id: 'delete-config',
            icon: '🗑️',
            title: '删除配置文件',
            command: `rm -f ${configPath} && rm -f ${basePath}.openclaw.json.swp`,
            description: '删除配置文件及 vim 交换文件'
        },
        {
            id: 'view-config',
            icon: '👁️',
            title: '查看配置文件',
            command: `cat ${configPath}`,
            description: '显示当前配置文件内容'
        },
        {
            id: 'backup-config',
            icon: '💾',
            title: '备份配置文件',
            command: `cp ${configPath} ${configPath}.backup.$(date +%Y%m%d_%H%M%S)`,
            description: '创建带时间戳的配置文件备份'
        },
        {
            id: 'write-config',
            icon: '✏️',
            title: '写入配置文件',
            command: `cat > ${configPath} << 'EOFCONFIG'\n${JSON.stringify(config, null, 2)}\nEOFCONFIG`,
            description: '将当前配置写入服务器（heredoc 方式）'
        }
    ];
}

function renderCommands() {
    if (!elements.commandsList) return;

    const commands = getCommands();

    let html = commands.map(cmd => `
        <div class="command-card">
            <div class="command-header">
                <div class="command-title">
                    <span class="icon">${cmd.icon}</span>
                    <span>${cmd.title}</span>
                </div>
                <button class="copy-btn" onclick="copyCommand('${cmd.id}')">
                    <span class="icon">📋</span> 复制
                </button>
            </div>
            <div class="command-body">
                <div class="command-code" id="cmd-${cmd.id}">${escapeHtml(cmd.command)}</div>
                <div class="command-description">${cmd.description}</div>
            </div>
        </div>
    `).join('');

    elements.commandsList.innerHTML = html;
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function copyCommand(cmdId) {
    const commands = getCommands();
    const cmd = commands.find(c => c.id === cmdId);
    if (!cmd) return;

    navigator.clipboard.writeText(cmd.command).then(() => {
        const btn = document.querySelector(`[onclick="copyCommand('${cmdId}')"]`);
        if (btn) {
            btn.classList.add('copied');
            btn.innerHTML = '<span class="icon">✓</span> 已复制';
            setTimeout(() => {
                btn.classList.remove('copied');
                btn.innerHTML = '<span class="icon">📋</span> 复制';
            }, 2000);
        }
        showToast('命令已复制到剪贴板 📋');
    }).catch(err => {
        showToast('复制失败: ' + err.message, 'error');
    });
}

// 初始化命令输入监听
function initCommandsInput() {
    if (elements.cmdUsername) {
        elements.cmdUsername.addEventListener('input', () => {
            // 自动更新路径中的用户名
            const username = elements.cmdUsername.value;
            if (username && elements.cmdPath) {
                elements.cmdPath.value = `/Users/${username}/.openclaw/`;
            }
            renderCommands();
        });
    }
    if (elements.cmdPath) {
        elements.cmdPath.addEventListener('input', renderCommands);
    }
}

// 渲染备份列表
async function renderBackupsList() {
    const container = document.getElementById('backupsList');
    if (!container) return;
    
    container.innerHTML = '<div class="empty-state"><div class="empty-state-text">加载中...</div></div>';
    
    const backups = await loadBackups();
    
    if (backups.length === 0) {
        container.innerHTML = `
            <div class="empty-state">
                <div class="empty-state-icon">📦</div>
                <div class="empty-state-text">暂无备份</div>
            </div>`;
        return;
    }
    
    container.innerHTML = backups.map(backup => `
        <div class="backup-item">
            <div class="backup-info">
                <div class="backup-name">${escapeHtml(backup.name)}</div>
                <div class="backup-meta">
                    <span>${new Date(backup.modified).toLocaleString()}</span>
                    <span>·</span>
                    <span>${(backup.size / 1024).toFixed(1)} KB</span>
                </div>
            </div>
            <div class="backup-actions">
                <button class="btn btn-secondary btn-sm" onclick="restoreFromBackup('${backup.name}')">
                    ↩️ 恢复
                </button>
            </div>
        </div>
    `).join('');
}

// ===== 初始化扩展功能 =====

function initExtendedFeatures() {
    // 缓存按钮
    if (elements.revertConfigBtn) {
        elements.revertConfigBtn.addEventListener('click', revertToCache);
    }
    if (elements.saveCacheBtn) {
        elements.saveCacheBtn.addEventListener('click', saveToCache);
    }

    // 实时同步
    initRawJsonSync();

    // 命令输入
    initCommandsInput();

    // Gateway 设置自动保存
    if (elements.gatewayPort) {
        elements.gatewayPort.addEventListener('change', () => {
            saveGatewaySettings();
            onConfigChanged();
        });
    }
    if (elements.gatewayBind) {
        elements.gatewayBind.addEventListener('change', () => {
            saveGatewaySettings();
            onConfigChanged();
        });
    }
    if (elements.gatewayToken) {
        elements.gatewayToken.addEventListener('change', () => {
            saveGatewaySettings();
            onConfigChanged();
        });
    }

    // 初始化缓存状态
    updateCacheStatus();
}

// 修改 DOMContentLoaded 初始化
document.addEventListener('DOMContentLoaded', () => {
    initExtendedFeatures();

    // 新增按钮事件
    const saveToServerBtn = document.getElementById('saveToServerBtn');
    if (saveToServerBtn) saveToServerBtn.addEventListener('click', saveToLocalServer);

    const validateBtn = document.getElementById('validateBtn');
    if (validateBtn) validateBtn.addEventListener('click', validateCurrentConfig);

    const refreshBackupsBtn = document.getElementById('refreshBackupsBtn');
    if (refreshBackupsBtn) refreshBackupsBtn.addEventListener('click', renderBackupsList);

    // 复制粘贴按钮
    const copySelectedBtn = document.getElementById('copySelectedBtn');
    if (copySelectedBtn) copySelectedBtn.addEventListener('click', copySelectedProviders);
    const copyAllBtn = document.getElementById('copyAllBtn');
    if (copyAllBtn) copyAllBtn.addEventListener('click', copyAllProviders);
    const pasteOverwriteBtn = document.getElementById('pasteOverwriteBtn');
    if (pasteOverwriteBtn) pasteOverwriteBtn.addEventListener('click', pasteProviders);
    const clearSelectionBtn = document.getElementById('clearSelectionBtn');
    if (clearSelectionBtn) clearSelectionBtn.addEventListener('click', clearSelection);

    // 尝试从本地缓存加载
    loadFromLocalStorage();

    // 初始渲染命令
    renderCommands();
    loadNodesFromServer();
});

// 修改导入函数，保存原始缓存
const originalHandleFileImport = handleFileImport;
function handleFileImportWithCache(event) {
    const file = event.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (e) => {
        try {
            config = JSON.parse(e.target.result);
            cachedConfig = JSON.parse(JSON.stringify(config)); // 保存原始版本
            isModified = false;
            renderAll();
            updateCacheStatus();
            updateRawJsonDisplay();
            renderCommands(); // 确保命令立即更新
            showToast(`配置文件 "${file.name}" 已导入`);
        } catch (err) {
            showToast('无法解析配置文件: ' + err.message, 'error');
        }
    };
    reader.readAsText(file);
    event.target.value = '';
}

// 替换原有的文件导入处理
document.addEventListener('DOMContentLoaded', () => {
    if (elements.fileInput) {
        // 移除可能的旧监听器，添加新的
        elements.fileInput.removeEventListener('change', handleFileImport);
        elements.fileInput.addEventListener('change', handleFileImportWithCache);
    }
});

// ===== 远程节点管理 =====

let nodes = [];
let activeNodeId = null;

// 从服务器加载节点列表
async function loadNodesFromServer() {
    try {
        const response = await apiFetch('/api/nodes');
        const data = await response.json();
        nodes = data.nodes || [];
        updateNodeSwitcher();
        renderNodes();
    } catch (e) {
        console.error('Failed to load nodes from server:', e);
        // 回退到本地存储
        nodes = JSON.parse(localStorage.getItem('openclaw-nodes') || '[]');
        updateNodeSwitcher();
        renderNodes();
    }
}

// 更新顶部节点切换下拉框
function updateNodeSwitcher() {
    const select = document.getElementById('nodeSwitcher');
    if (!select) return;
    
    let html = '<option value="local">🖥️ 本地服务器</option>';
    nodes.forEach(node => {
        const selected = activeNodeId === node.id ? 'selected' : '';
        html += `<option value="${node.id}" ${selected}>${node.name}</option>`;
    });
    
    select.innerHTML = html;
}

// 切换到指定节点（local 或节点 ID）
async function switchToNode(nodeId) {
    const statusDot = document.getElementById('currentNodeStatus');
    
    if (nodeId === 'local') {
        // 切换到本地配置
        activeNodeId = null;
        if (statusDot) statusDot.textContent = '🟢';
        
        try {
            const response = await apiFetch('/api/config');
            const data = await response.json();
            if (data.exists && data.config) {
                config = data.config;
                cachedConfig = JSON.parse(JSON.stringify(config));
                isModified = false;
                renderAll();
                updateCacheStatus();
                updateRawJsonDisplay();
                showToast('已切换到本地配置');
            }
        } catch (e) {
            showToast('切换失败: ' + e.message, 'error');
        }
    } else {
        // 切换到远程节点
        const node = nodes.find(n => n.id === nodeId);
        if (!node) {
            showToast('节点不存在', 'error');
            return;
        }
        
        activeNodeId = nodeId;
        
        // 尝试连接并加载配置
        if (statusDot) statusDot.textContent = '🟡';
        
        try {
            const data = await nodeFetch(node, '/config');
            if (data.ok) {
                config = data.config;
                cachedConfig = JSON.parse(JSON.stringify(config));
                isModified = false;
                renderAll();
                updateCacheStatus();
                updateRawJsonDisplay();
                if (statusDot) statusDot.textContent = '🟢';
                showToast(`已切换到 ${node.name}`);
            } else {
                if (statusDot) statusDot.textContent = '🔴';
                showToast(`连接 ${node.name} 失败: ${data.error || '未知错误'}`, 'error');
            }
        } catch (e) {
            if (statusDot) statusDot.textContent = '🔴';
            showToast('连接失败: ' + e.message, 'error');
        }
    }
}

window.switchToNode = switchToNode;

function saveNodes() {
    // 兼容性：仍保留本地存储
    localStorage.setItem('openclaw-nodes', JSON.stringify(nodes));
}

function getNode(id) {
    return nodes.find(n => n.id === id);
}

function nodeApiUrl(node, path) {
    // 优先使用服务端代理（解决 CORS 问题）
    // 如果设置了 useProxy=true 或者当前页面是 HTTPS 但节点是 HTTP，则使用代理
    const isHttpsPage = window.location.protocol === 'https:';
    const nodeIsHttp = !node.ssl;
    
    if (node.useProxy || (isHttpsPage && nodeIsHttp)) {
        // 使用服务端代理
        return `${window.location.origin}/api/proxy/${node.id}${path}`;
    }
    
    // 直接访问（本地网络或同协议）
    const proto = node.ssl ? 'https' : 'http';
    return `${proto}://${node.host}:${node.port}${path}`;
}

async function nodeFetch(node, path, opts = {}) {
    const url = nodeApiUrl(node, path);
    const headers = { 'X-Agent-Token': node.token, 'Content-Type': 'application/json', ...(opts.headers || {}) };
    
    // 设置超时（默认 30 秒）
    const timeout = opts.timeout || 30000;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);
    
    try {
        const res = await fetch(url, { 
            ...opts, 
            headers,
            signal: controller.signal
        });
        clearTimeout(timeoutId);
        
        // 检查 HTTP 状态
        if (!res.ok) {
            // 尝试解析错误信息
            let errorMsg = `HTTP ${res.status}`;
            try {
                const errorData = await res.json();
                errorMsg = errorData.error || errorData.message || errorMsg;
            } catch (e) {
                // 无法解析 JSON，使用状态文本
                errorMsg = res.statusText || errorMsg;
            }
            return { ok: false, error: errorMsg };
        }
        
        // 解析 JSON 响应
        const data = await res.json();
        return data;
    } catch (e) {
        clearTimeout(timeoutId);
        
        // 处理不同类型的错误
        if (e.name === 'AbortError') {
            return { ok: false, error: '请求超时 (' + (timeout / 1000) + '秒)' };
        }
        if (e.message && e.message.includes('Failed to fetch')) {
            return { ok: false, error: '无法连接到节点 (网络错误或 CORS 被阻止)' };
        }
        if (e.message && e.message.includes('NetworkError')) {
            return { ok: false, error: '网络错误: 无法连接到节点' };
        }
        return { ok: false, error: '请求失败: ' + e.message };
    }
}

function renderNodes() {
    const container = document.getElementById('nodesList');
    if (!container) return;

    if (nodes.length === 0) {
        container.innerHTML = `
            <div class="empty-state">
                <div class="empty-state-icon">🖥️</div>
                <div class="empty-state-text">暂无远程节点</div>
                <button class="btn btn-primary" onclick="openNodeModal()">+ 添加节点</button>
            </div>`;
        return;
    }

    // 获取所有任务
    fetchTasks().then(tasks => {
        container.innerHTML = nodes.map(node => {
            const taskStatus = getNodeTaskStatus(node.id, tasks);
            const statusBadge = taskStatus 
                ? (taskStatus.status === 'completed' ? '✅' : taskStatus.status === 'running' ? '🔄' : '⏳')
                : '—';
            const statusText = taskStatus
                ? `${taskStatus.status} (${new Date(taskStatus.createdAt).toLocaleTimeString()})`
                : '无任务';
            
            return `
        <div class="node-card" id="node-card-${node.id}">
            <div class="node-header">
                <div class="node-info">
                    <span class="node-status-dot" id="dot-${node.id}">⚪</span>
                    <div>
                        <div class="node-name">${escapeHtml(node.name)}</div>
                        <div class="node-addr">${escapeHtml(node.host)}:${node.port}</div>
                    </div>
                </div>
                <div class="node-actions">
                    <button class="btn btn-secondary btn-sm" onclick="pingNode('${node.id}')">连接</button>
                    <button class="btn btn-primary btn-sm" onclick="loadNodeConfig('${node.id}')">读取配置</button>
                    <button class="btn btn-success btn-sm" onclick="pushNodeConfig('${node.id}')">写入配置</button>
                    <button class="btn btn-secondary btn-sm" onclick="openNodeRescue('${node.id}')">救援</button>
                    <button class="btn btn-secondary btn-sm" onclick="openNodeModal('${node.id}')">编辑</button>
                    <button class="btn btn-danger btn-sm" onclick="deleteNode('${node.id}')">删除</button>
                </div>
            </div>
            <div class="node-task-bar">
                <span class="task-status">${statusBadge} 任务状态: ${statusText}</span>
                <button class="btn btn-sm" onclick="quickTask('${node.id}', 'status')">📊 状态</button>
                <button class="btn btn-sm" onclick="quickTask('${node.id}', 'doctor-fix')">🔧 修复</button>
                <button class="btn btn-sm" onclick="quickTask('${node.id}', 'restart-gateway')">↺ 重启</button>
            </div>
            <div class="node-cmd-bar" id="node-cmd-${node.id}" style="display:none">
                <button class="btn btn-sm" onclick="runNodeCmd('${node.id}','start')">▶ 启动</button>
                <button class="btn btn-sm" onclick="runNodeCmd('${node.id}','stop')">■ 停止</button>
                <button class="btn btn-sm" onclick="runNodeCmd('${node.id}','restart')">↺ 重启</button>
                <button class="btn btn-sm" onclick="runNodeCmd('${node.id}','status')">? 状态</button>
            </div>
            <div class="node-output" id="node-out-${node.id}" style="display:none"></div>
        </div>
    `}).join('');
    });
}

// 快速创建任务
async function quickTask(nodeId, command) {
    const node = getNode(nodeId);
    if (!node) return;
    const data = await createTask(nodeId, command);
    if (data.success) {
        showToast(`✅ 任务已创建: ${command}`);
        setTimeout(renderNodes, 1000); // 刷新显示
    } else {
        showToast(`❌ 创建失败: ${data.error}`);
    }
}

async function pingNode(id) {
    const node = getNode(id);
    if (!node) return;
    const dot = document.getElementById('dot-' + id);
    if (dot) dot.textContent = '🟡';
    try {
        const data = await nodeFetch(node, '/health');
        if (data.ok) {
            if (dot) dot.textContent = '🟢';
            const bar = document.getElementById('node-cmd-' + id);
            if (bar) bar.style.display = 'flex';
            showNodeOutput(id, `✅ 已连接 — ${data.hostname || ''} (${data.platform || ''})`);
            showToast(`节点 "${node.name}" 连接成功`);
        } else {
            if (dot) dot.textContent = '🔴';
            showNodeOutput(id, '❌ 连接失败: ' + JSON.stringify(data));
        }
    } catch (e) {
        if (dot) dot.textContent = '🔴';
        showNodeOutput(id, '❌ 无法连接: ' + e.message);
        showToast(`节点 "${node.name}" 连接失败`, 'error');
    }
}

async function loadNodeConfig(id) {
    const node = getNode(id);
    if (!node) return;
    showNodeOutput(id, '⏳ 正在读取配置...');
    try {
        const data = await nodeFetch(node, '/config');
        if (data.ok) {
            config = data.config;
            cachedConfig = JSON.parse(JSON.stringify(config));
            isModified = false;
            renderAll();
            updateCacheStatus();
            updateRawJsonDisplay();
            activeNodeId = id;
            showNodeOutput(id, '✅ 配置已加载到编辑器');
            showToast(`已从 "${node.name}" 加载配置`);
        } else if (data.raw) {
            showNodeOutput(id, '⚠️ 配置解析失败，原始内容:\n' + data.raw.slice(0, 500));
            showToast('配置文件格式错误', 'error');
        } else {
            showNodeOutput(id, '❌ ' + (data.error || '未知错误'));
            showToast('读取配置失败', 'error');
        }
    } catch (e) {
        showNodeOutput(id, '❌ 请求失败: ' + e.message);
        showToast('读取配置失败', 'error');
    }
}

async function pushNodeConfig(id) {
    const node = getNode(id);
    if (!node) return;
    if (!confirm(`确定要将当前配置写入节点 "${node.name}" 吗？\n原配置将自动备份。`)) return;
    saveAllSettings();
    showNodeOutput(id, '⏳ 正在写入配置...');
    try {
        const data = await nodeFetch(node, '/config', {
            method: 'POST',
            body: JSON.stringify({ config })
        });
        if (data.ok) {
            showNodeOutput(id, `✅ 配置已写入${data.backedUpTo ? '\n备份: ' + data.backedUpTo : ''}`);
            showToast(`配置已写入 "${node.name}"`);
        } else {
            showNodeOutput(id, '❌ 写入失败: ' + (data.error || ''));
            showToast('写入配置失败', 'error');
        }
    } catch (e) {
        showNodeOutput(id, '❌ 请求失败: ' + e.message);
        showToast('写入配置失败', 'error');
    }
}

async function runNodeCmd(id, cmd) {
    const node = getNode(id);
    if (!node) return;
    showNodeOutput(id, `⏳ 执行: openclaw gateway ${cmd}...`);
    try {
        const data = await nodeFetch(node, '/command', {
            method: 'POST',
            body: JSON.stringify({ command: cmd })
        });
        const out = [data.stdout, data.stderr].filter(Boolean).join('\n') || '(无输出)';
        showNodeOutput(id, `$ openclaw gateway ${cmd}\n${out}\n退出码: ${data.exitCode}`);
    } catch (e) {
        showNodeOutput(id, '❌ 请求失败: ' + e.message);
    }
}

function showNodeOutput(id, text) {
    const el = document.getElementById('node-out-' + id);
    if (!el) return;
    el.style.display = 'block';
    el.textContent = text;
}

// ── Node Modal ────────────────────────────────────────────────────────────────

function openNodeModal(id = null) {
    const modal = document.getElementById('nodeModal');
    if (!modal) return;
    const node = id ? getNode(id) : null;
    document.getElementById('nodeModalTitle').textContent = node ? '编辑节点' : '添加节点';
    document.getElementById('nodeModalId').value = id || '';
    document.getElementById('nodeName').value = node ? node.name : '';
    document.getElementById('nodeHost').value = node ? node.host : '';
    document.getElementById('nodePort').value = node ? node.port : 18790;
    document.getElementById('nodeToken').value = node ? node.token : '';
    document.getElementById('nodeSsl').checked = node ? !!node.ssl : false;
    modal.classList.remove('hidden');
}

function closeNodeModal() {
    const modal = document.getElementById('nodeModal');
    if (modal) modal.classList.add('hidden');
}

function saveNode() {
    const id = document.getElementById('nodeModalId').value;
    const name = document.getElementById('nodeName').value.trim();
    const host = document.getElementById('nodeHost').value.trim();
    const port = parseInt(document.getElementById('nodePort').value) || 18790;
    const token = document.getElementById('nodeToken').value.trim();
    const ssl = document.getElementById('nodeSsl').checked;

    if (!name || !host || !token) {
        showToast('请填写节点名称、主机地址和 Token', 'error');
        return;
    }

    // 优先保存到服务器
    apiFetch('/api/nodes/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, host, port, token, ssl })
    }).then(res => res.json()).then(data => {
        if (data.success && data.node) {
            const idx = nodes.findIndex(n => n.id === data.node.id);
            if (idx >= 0) {
                nodes[idx] = data.node;
            } else {
                nodes.push(data.node);
            }
            saveNodes();
            closeNodeModal();
            renderNodes();
            showToast(id ? '节点已更新' : '节点已添加');
        } else {
            showToast('保存节点失败: ' + (data.message || '未知错误'), 'error');
        }
    }).catch(err => {
        showToast('保存节点失败: ' + err.message, 'error');
    });
}

function deleteNode(id) {
    const node = getNode(id);
    if (!node || !confirm(`确定要删除节点 "${node.name}" 吗？`)) return;

    fetch(`/api/nodes/${id}`, { method: 'DELETE' })
        .then(res => res.json())
        .then(data => {
            if (data.success) {
                nodes = nodes.filter(n => n.id !== id);
                saveNodes();
                renderNodes();
                showToast('节点已删除');
            } else {
                showToast('删除失败: ' + (data.message || '未知错误'), 'error');
            }
        }).catch(err => {
            showToast('删除失败: ' + err.message, 'error');
        });
}

// ── Rescue Modal ──────────────────────────────────────────────────────────────

function openNodeRescue(id) {
    const modal = document.getElementById('rescueModal');
    if (!modal) return;
    document.getElementById('rescueNodeId').value = id;
    const node = getNode(id);
    document.getElementById('rescueNodeName').textContent = node ? node.name : id;
    document.getElementById('rescueOutput').textContent = '';
    modal.classList.remove('hidden');
}

function closeRescueModal() {
    const modal = document.getElementById('rescueModal');
    if (modal) modal.classList.add('hidden');
}

// ── 任务队列 API ────────────────────────────────────────────────────────────

// 创建任务（通过任务队列而不是直接连接）
async function createTask(nodeId, command) {
    try {
        const res = await apiFetch('/api/tasks', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ nodeId, command })
        });
        const data = await res.json();
        return data;
    } catch (e) {
        return { success: false, error: e.message };
    }
}

// 获取所有任务
async function fetchTasks() {
    try {
        const res = await apiFetch('/api/tasks');
        const data = await res.json();
        return data.tasks || [];
    } catch (e) {
        return [];
    }
}

// 获取节点的任务状态
function getNodeTaskStatus(nodeId, tasks) {
    const nodeTasks = tasks.filter(t => t.nodeId === nodeId);
    if (nodeTasks.length === 0) return null;
    // 返回最新任务
    return nodeTasks.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0];
}

// ── 救援操作（使用任务队列）────────────────────────────────────────────────

async function runRescue(mode) {
    const id = document.getElementById('rescueNodeId').value;
    const node = getNode(id);
    if (!node) return;
    const outEl = document.getElementById('rescueOutput');
    outEl.textContent = `⏳ 创建任务: ${mode}...\n(远程 Agent 将通过轮询获取并执行任务)`;
    
    try {
        // 使用任务队列而不是直接连接
        const data = await createTask(node.id, mode);
        if (data.success) {
            outEl.textContent = `✅ 任务已创建: ${data.task?.id}\n状态: pending\n等待 Agent 轮询执行...`;
            // 刷新任务列表
            setTimeout(() => refreshTaskStatus(node.id), 2000);
        } else {
            outEl.textContent = `❌ 创建任务失败: ${data.error}`;
        }
    } catch (e) {
        outEl.textContent = '❌ 请求失败: ' + e.message;
    }
}

// 刷新任务状态显示
async function refreshTaskStatus(nodeId) {
    const tasks = await fetchTasks();
    const status = getNodeTaskStatus(nodeId, tasks);
    const outEl = document.getElementById('rescueOutput');
    if (status && outEl) {
        const statusEmoji = status.status === 'completed' ? '✅' : status.status === 'running' ? '🔄' : '⏳';
        outEl.textContent += `\n\n${statusEmoji} 任务状态: ${status.status}`;
        if (status.result) {
            outEl.textContent += `\n结果: ${status.result.output || status.result.error || '无输出'}`;
        }
    }
}

// ── Install Script ────────────────────────────────────────────────────────────

function showInstallScript() {
    const modal = document.getElementById('installModal');
    if (!modal) return;
    updateInstallScript();
    modal.classList.remove('hidden');
}

function closeInstallModal() {
    const modal = document.getElementById('installModal');
    if (modal) modal.classList.add('hidden');
}

function updateInstallScript() {
    const port = document.getElementById('installPort')?.value || 18790;
    const token = document.getElementById('installToken')?.value || generateToken(32);
    const agentUrl = document.getElementById('installAgentUrl')?.value || '';
    const nodeName = document.getElementById('installNodeName')?.value || '';
    const out = document.getElementById('installScriptOut');
    if (!out) return;
    const envPart = agentUrl ? `AGENT_SCRIPT_URL="${agentUrl}" ` : '';
    const managerUrl = window.location.origin;
    const namePart = nodeName ? ` --name "${nodeName}"` : '';
    out.textContent = `${envPart}bash <(curl -fsSL ${window.location.origin}/install.sh) --token "${token}" --port ${port} --manager-url "${managerUrl}"${namePart}`;
}

function copyInstallScript() {
    const out = document.getElementById('installScriptOut');
    if (!out) return;
    navigator.clipboard.writeText(out.textContent).then(() => showToast('安装命令已复制'));
}

// 修改 switchSection，加入命令渲染
const originalSwitchSection = switchSection;
window.switchSection = function (sectionId) {
    // Update navigation
    elements.navItems.forEach(item => {
        item.classList.toggle('active', item.dataset.section === sectionId);
    });

    // Update sections
    elements.sections.forEach(section => {
        section.classList.toggle('hidden', section.id !== `section-${sectionId}`);
    });

    // Refresh section content
    if (sectionId === 'raw') {
        updateRawJsonDisplay();
        renderBackupsList();
    } else if (sectionId === 'agent') {
        renderAgentSettings();
    } else if (sectionId === 'commands') {
        renderCommands();
    } else if (sectionId === 'nodes') {
        renderNodes();
    }
};
