const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { exec, execSync } = require('child_process');
const { app, dialog } = require('electron');

const REPO_OWNER = 'cirross2';
const REPO_NAME = 'BossFreeForm-';
const FALLBACK_REPO_NAME = 'FreeformDrive';
const BRANCH = 'main';
const APP_DISPLAY_NAME = 'BossFreeForm';

const LOCAL_APP_DATA = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
const INSTALLED_APP_ROOT = path.join(LOCAL_APP_DATA, 'Programs', 'BossFreeForm', 'resources', 'app');
const APP_ROOT = path.resolve(__dirname, '../..'); // resources/app (packaged) or e:\코딩\BossFreeForm (dev)
const META_FILE = path.join(APP_ROOT, '.github_update_meta.json');

class GitHubUpdater {
  constructor() {
    this.isChecking = false;
    this.isUpdating = false;
    this.updateAvailable = false;
    this.latestCommit = null;
    this.cachedToken = undefined;
    this.localSha = this.getLocalSha();
    this.onStatusChange = null;
  }

  getGitHubToken() {
    if (this.cachedToken !== undefined) return this.cachedToken;
    if (process.env.GITHUB_TOKEN || process.env.GH_TOKEN) {
      this.cachedToken = (process.env.GITHUB_TOKEN || process.env.GH_TOKEN).trim();
      return this.cachedToken;
    }
    try {
      const credOut = execSync('git credential fill', {
        input: 'protocol=https\nhost=github.com\n\n',
        encoding: 'utf-8',
        timeout: 2500,
        windowsHide: true
      });
      const passLine = credOut.split(/\r?\n/).find((l) => l.startsWith('password='));
      if (passLine) {
        const tok = passLine.replace(/^password=/, '').trim();
        if (tok) {
          this.cachedToken = tok;
          return this.cachedToken;
        }
      }
    } catch (_) {}
    this.cachedToken = null;
    return null;
  }

  findGitRepoRoot() {
    const candidates = [
      APP_ROOT,
      path.resolve(APP_ROOT, '../../..'), // if running inside dist/BossFreeForm/resources/app
      'e:\\코딩\\BossFreeForm'
    ];
    for (const dir of candidates) {
      try {
        if (fs.existsSync(path.join(dir, '.git'))) {
          return dir;
        }
      } catch (_) {}
    }
    return null;
  }

  getLocalSha() {
    try {
      if (fs.existsSync(META_FILE)) {
        const meta = JSON.parse(fs.readFileSync(META_FILE, 'utf-8'));
        if (meta && meta.sha) return String(meta.sha).trim();
      }
    } catch (_) {}

    const gitRoot = this.findGitRepoRoot();
    if (gitRoot) {
      try {
        const headPath = path.join(gitRoot, '.git', 'HEAD');
        if (fs.existsSync(headPath)) {
          const headContent = fs.readFileSync(headPath, 'utf-8').trim();
          if (headContent.startsWith('ref:')) {
            const refRel = headContent.replace(/^ref:\s*/, '').trim();
            const refFile = path.join(gitRoot, '.git', refRel);
            if (fs.existsSync(refFile)) {
              return fs.readFileSync(refFile, 'utf-8').trim();
            }
          } else if (/^[0-9a-f]{40}$/i.test(headContent)) {
            return headContent;
          }
        }
      } catch (_) {}
    }
    return null;
  }

  saveLocalMeta(sha, message = '') {
    this.localSha = sha;
    const payload = JSON.stringify({ sha, message, updatedAt: Date.now() }, null, 2);
    try {
      fs.writeFileSync(META_FILE, payload, 'utf-8');
    } catch (_) {}
    const gitRoot = this.findGitRepoRoot();
    if (gitRoot) {
      try {
        fs.writeFileSync(path.join(gitRoot, '.github_update_meta.json'), payload, 'utf-8');
        const distAppRoot = path.join(gitRoot, 'dist', 'BossFreeForm', 'resources', 'app');
        if (fs.existsSync(distAppRoot)) {
          fs.writeFileSync(path.join(distAppRoot, '.github_update_meta.json'), payload, 'utf-8');
        }
      } catch (_) {}
    }
    try {
      if (fs.existsSync(INSTALLED_APP_ROOT)) {
        fs.writeFileSync(path.join(INSTALLED_APP_ROOT, '.github_update_meta.json'), payload, 'utf-8');
      }
    } catch (_) {}
  }

  fetchJson(urlStr, useAuth = true) {
    return new Promise((resolve, reject) => {
      const headers = {
        'User-Agent': 'BossFreeForm-GitHubUpdater/1.3',
        Accept: 'application/vnd.github.v3+json'
      };
      const token = useAuth ? this.getGitHubToken() : null;
      if (token) {
        headers.Authorization = `Bearer ${token}`;
      }

      const req = https.get(
        urlStr,
        {
          headers,
          timeout: 8000
        },
        (res) => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            return this.fetchJson(res.headers.location, useAuth).then(resolve).catch(reject);
          }
          let raw = '';
          res.on('data', (c) => (raw += c));
          res.on('end', () => {
            if ((res.statusCode === 401 || res.statusCode === 403) && useAuth && token) {
              this.cachedToken = null;
              return this.fetchJson(urlStr, false).then(resolve).catch(reject);
            }
            if (res.statusCode !== 200) {
              return reject(new Error(`GitHub API HTTP ${res.statusCode}`));
            }
            try {
              resolve(JSON.parse(raw));
            } catch (e) {
              reject(e);
            }
          });
        }
      );
      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('GitHub API 요청 시간 초과'));
      });
    });
  }

  fetchLatestCommitViaGit() {
    return new Promise((resolve, reject) => {
      const gitRoot = this.findGitRepoRoot();
      if (gitRoot) {
        exec(
          `git -C "${gitRoot}" fetch origin ${BRANCH} && git -C "${gitRoot}" log -1 --format="%H%n%s%n%ct" origin/${BRANCH}`,
          { timeout: 10000, windowsHide: true },
          (err, stdout) => {
            if (!err && stdout) {
              const lines = stdout.trim().split(/\r?\n/);
              if (lines[0] && /^[0-9a-f]{40}$/i.test(lines[0].trim())) {
                return resolve({
                  sha: lines[0].trim(),
                  commit: {
                    message: lines[1] || 'GitHub 최신 업데이트',
                    committer: {
                      date: lines[2] ? new Date(parseInt(lines[2], 10) * 1000).toISOString() : new Date().toISOString()
                    }
                  }
                });
              }
            }
            this.fetchLsRemoteFallback().then(resolve).catch(reject);
          }
        );
      } else {
        this.fetchLsRemoteFallback().then(resolve).catch(reject);
      }
    });
  }

  fetchLsRemoteFallback() {
    return new Promise((resolve, reject) => {
      exec(
        `git ls-remote https://github.com/${REPO_OWNER}/${REPO_NAME}.git refs/heads/${BRANCH}`,
        { timeout: 8000, windowsHide: true },
        (err, stdout) => {
          if (err || !stdout) return reject(err || new Error('Git 원격 조회 실패'));
          const sha = stdout.trim().split(/\s+/)[0];
          if (sha && /^[0-9a-f]{40}$/i.test(sha)) {
            return resolve({
              sha,
              commit: {
                message: 'GitHub 원격 저장소 최신 커밋',
                committer: { date: new Date().toISOString() }
              }
            });
          }
          reject(new Error('유효한 커밋 해시를 찾을 수 없습니다.'));
        }
      );
    });
  }

  fetchBuffer(urlStr, useAuth = true) {
    return new Promise((resolve, reject) => {
      const headers = { 'User-Agent': 'BossFreeForm-GitHubUpdater/1.3' };
      const token = useAuth ? this.getGitHubToken() : null;
      if (token) {
        headers.Authorization = `Bearer ${token}`;
      }
      const req = https.get(
        urlStr,
        {
          headers,
          timeout: 12000
        },
        (res) => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            return this.fetchBuffer(res.headers.location, false).then(resolve).catch(reject);
          }
          if (res.statusCode !== 200) {
            res.resume();
            return reject(new Error(`Download HTTP ${res.statusCode}`));
          }
          const chunks = [];
          res.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
          res.on('end', () => resolve(Buffer.concat(chunks)));
        }
      );
      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('파일 다운로드 시간 초과'));
      });
    });
  }

  getMenuLabel() {
    if (this.isUpdating) return '⏳ GitHub 업데이트 설치 중...';
    if (this.isChecking) return '🔄 GitHub 업데이트 확인 중...';
    if (this.updateAvailable && this.latestCommit) {
      return `✨ GitHub 새 업데이트 적용 (${this.latestCommit.sha.slice(0, 7)})`;
    }
    const shortSha = this.localSha ? ` (${this.localSha.slice(0, 7)})` : '';
    return `🔄 GitHub 업데이트 확인${shortSha}`;
  }

  notifyMenuRefresh() {
    if (typeof this.onStatusChange === 'function') {
      try {
        this.onStatusChange();
      } catch (_) {}
    }
  }

  async checkForUpdates({ silent = true } = {}) {
    if (this.isChecking || this.isUpdating) return;
    this.isChecking = true;
    this.notifyMenuRefresh();

    try {
      const commitData = await this.fetchJson(
        `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/commits/${BRANCH}`
      )
        .catch(() =>
          this.fetchJson(`https://api.github.com/repos/${REPO_OWNER}/${FALLBACK_REPO_NAME}/commits/${BRANCH}`)
        )
        .catch(() => this.fetchLatestCommitViaGit());
      const remoteSha = commitData?.sha;
      const commitMsg = (commitData?.commit?.message || '').split('\n')[0];
      const commitDateMs = commitData?.commit?.committer?.date
        ? new Date(commitData.commit.committer.date).getTime()
        : 0;

      if (!remoteSha) throw new Error('커밋 정보를 가져올 수 없습니다.');

      this.latestCommit = {
        sha: remoteSha,
        message: commitMsg,
        dateMs: commitDateMs
      };

      const currentLocalSha = this.getLocalSha();
      if (!currentLocalSha) {
        const indexStat = fs.statSync(__filename);
        if (commitDateMs > indexStat.mtimeMs + 120000) {
          this.updateAvailable = true;
        } else {
          this.saveLocalMeta(remoteSha, commitMsg);
          this.updateAvailable = false;
        }
      } else {
        this.updateAvailable = currentLocalSha.toLowerCase() !== remoteSha.toLowerCase();
      }

      this.isChecking = false;
      this.notifyMenuRefresh();

      if (this.updateAvailable) {
        const res = await dialog.showMessageBox({
          type: 'info',
          title: `${APP_DISPLAY_NAME} — GitHub 업데이트 발견`,
          message: `GitHub에 새로운 업데이트가 있습니다! 지금 바로 업데이트할까요?`,
          detail: `• 최신 커밋: ${remoteSha.slice(0, 7)}\n• 변경 내역: ${commitMsg}\n• 현재 버전: ${
            currentLocalSha ? currentLocalSha.slice(0, 7) : '초기 설치본'
          }`,
          buttons: ['지금 업데이트 및 재시작', '나중에'],
          defaultId: 0,
          cancelId: 1
        });
        if (res.response === 0) {
          await this.performUpdate();
        }
      } else if (!silent) {
        const res = await dialog.showMessageBox({
          type: 'info',
          title: `${APP_DISPLAY_NAME} — 최신 버전 사용 중`,
          message: `현재 GitHub 최신 버전(${remoteSha.slice(0, 7)})을 사용 중입니다.`,
          detail: `• 최신 커밋 내역: ${commitMsg}`,
          buttons: ['확인', '강제 재동기화 및 재시작'],
          defaultId: 0,
          cancelId: 0
        });
        if (res.response === 1) {
          await this.performUpdate();
        }
      }
    } catch (err) {
      this.isChecking = false;
      this.notifyMenuRefresh();
      if (!silent) {
        dialog.showMessageBox({
          type: 'warning',
          title: `${APP_DISPLAY_NAME} — 업데이트 확인 실패`,
          message: `GitHub 서버와 통신할 수 없습니다.`,
          detail: err.message || String(err),
          buttons: ['확인']
        });
      }
    }
  }

  copyRecursiveSync(src, dest) {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
      const s = path.join(src, entry.name);
      const d = path.join(dest, entry.name);
      if (entry.isDirectory()) {
        this.copyRecursiveSync(s, d);
      } else {
        fs.copyFileSync(s, d);
      }
    }
  }

  async performUpdate() {
    if (this.isUpdating) return;
    this.isUpdating = true;
    this.notifyMenuRefresh();

    try {
      const gitRoot = this.findGitRepoRoot();
      let updatedViaGit = false;

      if (gitRoot) {
        updatedViaGit = await new Promise((resolve) => {
          exec(
            `git -C "${gitRoot}" fetch origin ${BRANCH} && git -C "${gitRoot}" reset --hard origin/${BRANCH}`,
            { timeout: 20000, windowsHide: true },
            (err) => {
              if (err) return resolve(false);
              try {
                const distAppDir = path.join(gitRoot, 'dist', 'BossFreeForm', 'resources', 'app');
                if (fs.existsSync(distAppDir) && path.resolve(distAppDir) !== path.resolve(gitRoot)) {
                  this.copyRecursiveSync(path.join(gitRoot, 'src'), path.join(distAppDir, 'src'));
                  this.copyRecursiveSync(path.join(gitRoot, 'assets'), path.join(distAppDir, 'assets'));
                  fs.copyFileSync(path.join(gitRoot, 'package.json'), path.join(distAppDir, 'package.json'));
                }
                if (path.resolve(APP_ROOT) !== path.resolve(gitRoot) && fs.existsSync(path.join(APP_ROOT, 'src'))) {
                  this.copyRecursiveSync(path.join(gitRoot, 'src'), path.join(APP_ROOT, 'src'));
                  this.copyRecursiveSync(path.join(gitRoot, 'assets'), path.join(APP_ROOT, 'assets'));
                  fs.copyFileSync(path.join(gitRoot, 'package.json'), path.join(APP_ROOT, 'package.json'));
                }
                if (
                  fs.existsSync(INSTALLED_APP_ROOT) &&
                  path.resolve(INSTALLED_APP_ROOT) !== path.resolve(gitRoot) &&
                  path.resolve(INSTALLED_APP_ROOT) !== path.resolve(APP_ROOT)
                ) {
                  this.copyRecursiveSync(path.join(gitRoot, 'src'), path.join(INSTALLED_APP_ROOT, 'src'));
                  this.copyRecursiveSync(path.join(gitRoot, 'assets'), path.join(INSTALLED_APP_ROOT, 'assets'));
                  fs.copyFileSync(path.join(gitRoot, 'package.json'), path.join(INSTALLED_APP_ROOT, 'package.json'));
                }
                resolve(true);
              } catch (_) {
                resolve(false);
              }
            }
          );
        });
      }

      if (!updatedViaGit) {
        // Standalone / Setup.exe installed build without .git: pull updated source tree directly via GitHub API + raw files
        const treeData = await this.fetchJson(
          `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/git/trees/${BRANCH}?recursive=1`
        );
        const filesToSync = (treeData?.tree || []).filter(
          (item) =>
            item.type === 'blob' &&
            (item.path.startsWith('src/') ||
              item.path.startsWith('assets/') ||
              item.path === 'package.json' ||
              item.path === 'setup.js')
        );

        for (const item of filesToSync) {
          const rawUrl = `https://raw.githubusercontent.com/${REPO_OWNER}/${REPO_NAME}/${BRANCH}/${item.path}`;
          const buf = await this.fetchBuffer(rawUrl);
          const targetPath = path.join(APP_ROOT, item.path);
          fs.mkdirSync(path.dirname(targetPath), { recursive: true });
          fs.writeFileSync(targetPath, buf);
        }
      }

      if (this.latestCommit?.sha) {
        this.saveLocalMeta(this.latestCommit.sha, this.latestCommit.message);
      }
      this.updateAvailable = false;
      this.isUpdating = false;
      this.notifyMenuRefresh();

      await dialog.showMessageBox({
        type: 'info',
        title: `${APP_DISPLAY_NAME} — 업데이트 완료`,
        message: '최신 GitHub 업데이트가 성공적으로 반영되었습니다!\n앱을 재시작합니다.',
        buttons: ['재시작']
      });

      app.relaunch();
      app.exit(0);
    } catch (err) {
      this.isUpdating = false;
      this.notifyMenuRefresh();
      dialog.showMessageBox({
        type: 'error',
        title: `${APP_DISPLAY_NAME} — 업데이트 실패`,
        message: 'GitHub 업데이트 적용 중 오류가 발생했습니다.',
        detail: err.message || String(err),
        buttons: ['확인']
      });
    }
  }
}

module.exports = new GitHubUpdater();
