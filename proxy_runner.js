const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const crypto = require('crypto');

const EXIT_CODE = {
    SUCCESS: 0,
    FATAL_ERROR: 1,
    PROXY_RETRY: 2,
    NOT_READY: 3,
    ALREADY_RENEWED: 4,
    LOGIN_FAILED: 5
};

const NON_RETRYABLE = new Set([
    EXIT_CODE.SUCCESS,
    EXIT_CODE.NOT_READY,
    EXIT_CODE.ALREADY_RENEWED,
    EXIT_CODE.LOGIN_FAILED
]);

const CONFIG = {
    MAX_PROXY_SWITCHES: 5,
    COOLDOWN_FILE: path.join(process.cwd(), 'proxy-cooldown.json'),
    COOLDOWN_HOURS: 4,
    PROXIES_FILE: path.join(process.cwd(), 'proxies.txt')
};

function loadCooldowns() {
    try {
        if (!fs.existsSync(CONFIG.COOLDOWN_FILE)) return {};
        const raw = fs.readFileSync(CONFIG.COOLDOWN_FILE, 'utf-8');
        return JSON.parse(raw);
    } catch (e) {
        console.log('[proxy-runner] 冷却文件读取失败，视为无冷却:', e.message);
        return {};
    }
}

function saveCooldowns(cooldowns) {
    try {
        fs.writeFileSync(CONFIG.COOLDOWN_FILE, JSON.stringify(cooldowns, null, 2), 'utf-8');
    } catch (e) {
        console.error('[proxy-runner] 保存冷却文件失败:', e.message);
    }
}

function addCooldown(cooldowns, proxyKey, reason) {
    const until = Math.floor(Date.now() / 1000) + CONFIG.COOLDOWN_HOURS * 3600;
    cooldowns[proxyKey] = { until, reason };
    saveCooldowns(cooldowns);
    console.log(`[proxy-runner] 代理 ${proxyKey} 加入冷却，持续 ${CONFIG.COOLDOWN_HOURS}h，原因: ${reason}`);
}

function removeExpiredCooldowns(cooldowns) {
    const now = Math.floor(Date.now() / 1000);
    let removed = 0;
    for (const key of Object.keys(cooldowns)) {
        if (cooldowns[key].until <= now) {
            delete cooldowns[key];
            removed++;
        }
    }
    if (removed > 0) {
        saveCooldowns(cooldowns);
        console.log(`[proxy-runner] 已清理 ${removed} 条过期冷却`);
    }
}

function loadProxies() {
    if (!fs.existsSync(CONFIG.PROXIES_FILE)) {
        console.log('[proxy-runner] proxies.txt 不存在，直接运行（无代理）');
        return [];
    }
    const raw = fs.readFileSync(CONFIG.PROXIES_FILE, 'utf-8');
    const lines = raw.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
    console.log(`[proxy-runner] proxies.txt 共 ${lines.length} 条有效代理`);
    return lines;
}

function selectRandomProxy(proxies, cooldowns) {
    const now = Math.floor(Date.now() / 1000);
    const available = proxies.filter(line => {
        const ip = line.split(':')[0];
        const port = line.split(':')[1];
        const key = `${ip}:${port}`;
        return !cooldowns[key] || cooldowns[key].until <= now;
    });

    if (available.length === 0) {
        console.log('[proxy-runner] 无可选代理（全部冷却中），清空冷却后重试');
        saveCooldowns({});
        return proxies.length > 0 ? { line: proxies[crypto.randomInt(proxies.length)], source: 'forced' } : null;
    }

    const line = available[crypto.randomInt(available.length)];
    const ip = line.split(':')[0];
    const port = line.split(':')[1];
    console.log(`[proxy-runner] 选择代理: ${ip}:${port}`);
    return { line, source: 'selected' };
}

function buildHttpProxy(line) {
    if (!line) return null;
    const parts = line.split(':');
    if (parts.length < 4) return null;
    return `http://${parts[2]}:${parts[3]}@${parts[0]}:${parts[1]}`;
}

function cleanChromeTemp() {
    const dir = '/tmp/chrome_user_data';
    try {
        if (fs.existsSync(dir)) {
            fs.rmSync(dir, { recursive: true, force: true });
            console.log('[proxy-runner] 已清理 Chrome 临时目录');
        }
    } catch (e) {
        console.log(`[proxy-runner] 清理 Chrome 目录失败: ${e.message}`);
    }
}

function runActionRenew(proxyLine) {
    return new Promise((resolve) => {
        const env = { ...process.env };

        if (proxyLine) {
            const proxyUrl = buildHttpProxy(proxyLine);
            if (proxyUrl) {
                env.HTTP_PROXY = proxyUrl;
                env.HTTPS_PROXY = proxyUrl;
                const ip = proxyLine.split(':')[0];
                const port = proxyLine.split(':')[1];
                console.log(`[proxy-runner] 设置 HTTP_PROXY=${ip}:${port}`);
            } else {
                delete env.HTTP_PROXY;
                delete env.HTTPS_PROXY;
            }
        } else {
            delete env.HTTP_PROXY;
            delete env.HTTPS_PROXY;
        }

        const scriptPath = path.join(process.cwd(), 'action_renew.js');
        console.log(`[proxy-runner] 启动 action_renew.js...`);

        const proc = spawn('node', [scriptPath], { env, stdio: 'inherit', shell: false });

        let timedOut = false;
        const timeout = setTimeout(() => {
            timedOut = true;
            console.error('[proxy-runner] action_renew.js 运行超时 (10min)，强制终止');
            proc.kill('SIGKILL');
        }, 10 * 60 * 1000);

        proc.on('exit', (code) => {
            clearTimeout(timeout);
            if (timedOut) {
                resolve({ code: EXIT_CODE.FATAL_ERROR, timedOut: true });
                return;
            }
            const safeCode = (code !== null && code !== undefined) ? code : EXIT_CODE.FATAL_ERROR;
            console.log(`[proxy-runner] action_renew.js 退出码: ${safeCode}`);
            resolve({ code: safeCode });
        });

        proc.on('error', (err) => {
            clearTimeout(timeout);
            console.error('[proxy-runner] 启动子进程失败:', err.message);
            resolve({ code: EXIT_CODE.FATAL_ERROR });
        });
    });
}

(async () => {
    console.log(`[proxy-runner] 启动代理轮换控制器`);
    console.log(`[proxy-runner] 最多尝试 ${CONFIG.MAX_PROXY_SWITCHES} 个代理，冷却 ${CONFIG.COOLDOWN_HOURS}h`);

    const proxies = loadProxies();
    let cooldowns = loadCooldowns();
    removeExpiredCooldowns(cooldowns);

    for (let attempt = 1; attempt <= CONFIG.MAX_PROXY_SWITCHES; attempt++) {
        console.log(`\n[proxy-runner] ===== 代理尝试 ${attempt}/${CONFIG.MAX_PROXY_SWITCHES} =====`);

        let proxyLine = null;
        let selection = null;

        if (proxies.length > 0) {
            selection = selectRandomProxy(proxies, cooldowns);
            if (selection) {
                proxyLine = selection.line;
                if (selection.source === 'selected') {
                    const ip = proxyLine.split(':')[0];
                    const port = proxyLine.split(':')[1];
                    console.log(`[proxy-runner] 选中代理: ${ip}:${port}`);
                }
            }
        } else {
            console.log('[proxy-runner] 无代理列表，直接运行');
        }

        cleanChromeTemp();

        const result = await runActionRenew(proxyLine);
        const code = result.code;

        if (NON_RETRYABLE.has(code)) {
            console.log(`[proxy-runner] 不可重试退出码 ${code}，结束本轮`);
            process.exit(code);
        }

        if (code === EXIT_CODE.PROXY_RETRY && proxyLine && selection) {
            const ip = proxyLine.split(':')[0];
            const port = proxyLine.split(':')[1];
            const key = `${ip}:${port}`;
            addCooldown(cooldowns, key, 'turnstile_failed_3_attempts');
            cooldowns = loadCooldowns();
            console.log(`[proxy-runner] 代理 ${ip}:${port} 已冷却，继续尝试下一个代理`);
            continue;
        }

        console.log(`[proxy-runner] 收到退出码 ${code}，尝试下一个代理`);
        continue;
    }

    console.log(`[proxy-runner] 已尝试 ${CONFIG.MAX_PROXY_SWITCHES} 个代理，均未成功`);
    process.exit(EXIT_CODE.FATAL_ERROR);
})();
