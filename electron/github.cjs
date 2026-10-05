// GitHub integration: token auth, repo listing, cloning, and pull requests.
// Git is authenticated per-command through environment variables, so the token is never
// written into .git/config or remote URLs.
const { execFile } = require('child_process')
const fs = require('fs')
const path = require('path')

const API = 'https://api.github.com'

async function gh(token, p, opts = {}) {
  const res = await fetch(API + p, {
    ...opts,
    headers: {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'wicked-code',
      Authorization: `Bearer ${token}`,
      ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
      ...(opts.headers || {}),
    },
    signal: opts.signal || AbortSignal.timeout(20_000),
  })
  const text = await res.text()
  const json = text ? JSON.parse(text) : null
  if (!res.ok) {
    const detail = json?.errors?.map((e) => e.message || e.code).filter(Boolean).join('; ')
    throw new Error(`GitHub ${res.status}: ${json?.message || res.statusText}${detail ? ` (${detail})` : ''}`)
  }
  return json
}

/** Environment variables that make git authenticate to github.com with the token. */
function gitAuthEnv(token) {
  if (!token) return { GIT_TERMINAL_PROMPT: '0' }
  const basic = Buffer.from(`x-access-token:${token}`).toString('base64')
  return {
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`,
  }
}

function git(args, { cwd, env, timeout = 600_000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, env: { ...process.env, ...env }, timeout, windowsHide: true, maxBuffer: 20 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const msg = String(stderr || err.message).trim()
        reject(new Error(err.code === 'ENOENT' ? 'Git is not installed. Install it from https://git-scm.com and restart Wicked Code.' : msg))
      } else resolve(String(stdout).trim())
    })
  })
}

/** Parse owner/repo from a GitHub remote URL (https or ssh). */
function parseGithubRemote(url) {
  const m = /github\.com[:/]+([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(String(url || '').trim())
  return m ? { owner: m[1], repo: m[2], fullName: `${m[1]}/${m[2]}` } : null
}

/** Info about the git repository in `dir` (null if not a GitHub repo). */
async function repoInfo(dir) {
  try {
    const remote = await git(['remote', 'get-url', 'origin'], { cwd: dir, timeout: 5000 })
    const parsed = parseGithubRemote(remote)
    if (!parsed) return null
    const branch = await git(['symbolic-ref', '--short', 'HEAD'], { cwd: dir, timeout: 5000 }).catch(() => null) // null when detached
    const dirty = await git(['status', '--porcelain'], { cwd: dir, timeout: 5000 }).then((s) => (s ? s.split('\n').length : 0)).catch(() => 0)
    return { ...parsed, branch, dirty, url: `https://github.com/${parsed.fullName}` }
  } catch {
    return null
  }
}

function slugify(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'session'
}

class GitHub {
  /** @param {() => string|null} getToken */
  constructor(getToken) {
    this.getToken = getToken
  }

  token() {
    const t = this.getToken()
    if (!t) throw new Error('Connect GitHub first: add a token in Settings → GitHub.')
    return t
  }

  authEnv() {
    return gitAuthEnv(this.getToken())
  }

  async user(token = this.token()) {
    const u = await gh(token, '/user')
    return { login: u.login, name: u.name, url: u.html_url }
  }

  async listRepos() {
    const token = this.token()
    const out = []
    for (let page = 1; page <= 5; page++) {
      const batch = await gh(token, `/user/repos?per_page=100&sort=pushed&page=${page}&affiliation=owner,collaborator,organization_member`)
      out.push(
        ...batch.map((r) => ({
          fullName: r.full_name,
          description: r.description,
          private: r.private,
          defaultBranch: r.default_branch,
          pushedAt: r.pushed_at,
          language: r.language,
          url: r.html_url,
        })),
      )
      if (batch.length < 100) break
    }
    return out
  }

  async branches(fullName) {
    const list = await gh(this.token(), `/repos/${fullName}/branches?per_page=100`)
    return list.map((b) => b.name)
  }

  /**
   * Clone (or reuse an existing clone of) a repo, check out `baseBranch`, optionally create `newBranch`.
   * Returns the local path and repo info.
   */
  async clone({ fullName, cloneRoot, baseBranch, newBranch }) {
    const env = gitAuthEnv(this.token())
    const [owner, repo] = fullName.split('/')
    const dest = path.join(cloneRoot, owner, repo)
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    if (fs.existsSync(path.join(dest, '.git'))) {
      await git(['fetch', '--prune', 'origin'], { cwd: dest, env })
    } else {
      if (fs.existsSync(dest) && fs.readdirSync(dest).length) throw new Error(`${dest} already exists and is not a git repository.`)
      await git(['clone', `https://github.com/${fullName}.git`, dest], { env })
    }
    if (baseBranch) {
      await git(['checkout', baseBranch], { cwd: dest, env })
      await git(['pull', '--ff-only', 'origin', baseBranch], { cwd: dest, env }).catch(() => {})
    }
    if (newBranch) {
      const exists = await git(['rev-parse', '--verify', '--quiet', newBranch], { cwd: dest }).then(() => true, () => false)
      await git(exists ? ['checkout', newBranch] : ['checkout', '-b', newBranch], { cwd: dest, env })
    }
    return { path: dest, info: await repoInfo(dest) }
  }

  /** Create a PR for the current branch of the repo in `dir`. */
  async createPullRequest(dir, { title, body, base, draft }) {
    const token = this.token()
    const info = await repoInfo(dir)
    if (!info) throw new Error('This folder is not a GitHub repository.')
    if (!info.branch || info.branch === 'HEAD') throw new Error('Not on a branch. Create and push a branch first.')
    const repo = await gh(token, `/repos/${info.fullName}`)
    const baseBranch = base || repo.default_branch
    if (info.branch === baseBranch) throw new Error(`You're on ${baseBranch}. Create a feature branch, commit, and push it first.`)
    const pr = await gh(token, `/repos/${info.fullName}/pulls`, {
      method: 'POST',
      body: JSON.stringify({ title, body: body || '', head: info.branch, base: baseBranch, draft: !!draft }),
    })
    return `Opened pull request #${pr.number}: ${pr.html_url}`
  }
}

module.exports = { GitHub, gitAuthEnv, parseGithubRemote, repoInfo, slugify, git }
