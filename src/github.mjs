export class GitHubError extends Error {
  constructor(message, { status, retryAt } = {}) {
    super(message);
    this.name = 'GitHubError';
    this.status = status;
    this.retryAt = retryAt;
  }
}

function retryTime(response, now) {
  const after = response.headers.get('retry-after');
  const reset = response.headers.get('x-ratelimit-reset');
  if (after !== null) {
    const time = /^\d+$/.test(after) ? now + Number(after) * 1000 : Date.parse(after);
    if (Number.isFinite(new Date(time).getTime())) return new Date(time).toISOString();
  }
  if (reset && /^\d+$/.test(reset)) {
    const time = Number(reset) * 1000;
    if (Number.isFinite(new Date(time).getTime())) return new Date(time).toISOString();
  }
}

export function summarize(checks, statuses) {
  const outcomes = [
    ...checks.map(check => {
      if (check.status !== 'completed') return 'pending';
      if (['success', 'neutral', 'skipped'].includes(check.conclusion)) return 'success';
      if (['failure', 'cancelled', 'timed_out', 'action_required', 'startup_failure', 'stale'].includes(check.conclusion)) return 'failure';
      return 'pending';
    }),
    ...statuses.map(status => ['failure', 'error'].includes(status.state)
      ? 'failure' : status.state === 'success' ? 'success' : 'pending'),
  ];
  if (!outcomes.length) return 'no-checks';
  if (outcomes.includes('failure')) return 'failure';
  return outcomes.every(value => value === 'success') ? 'success' : 'pending';
}

export async function inspectRepository(repository, {
  ref, token, timeout = 10000, fetchImpl = fetch, now = Date.now,
} = {}) {
  if (!/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_.-]+$/.test(repository) ||
      ['.', '..'].includes(repository.split('/')[1])) throw new TypeError('Use owner/repository.');
  if (ref !== undefined && (typeof ref !== 'string' || !ref.trim() || ref.length > 256))
    throw new TypeError('Ref must be a non-empty branch, tag or commit SHA.');
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 300000)
    throw new TypeError('Timeout must be 1–300000 milliseconds.');
  const headers = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'joshwebtimestwo-repo-checks/0.1.0',
    ...(token ? { Authorization: 'Bearer ' + token } : {}),
  };
  const prefix = '/repos/' + repository;
  async function request(path) {
    let response;
    try {
      response = await fetchImpl('https://api.github.com' + path, {
        headers, redirect: 'error', signal: AbortSignal.timeout(timeout),
      });
    } catch (error) {
      throw new GitHubError(error?.name === 'TimeoutError' || error?.name === 'AbortError'
        ? 'GitHub request timed out.' : 'GitHub network request failed.');
    }
    if (!response.ok) {
      let apiMessage = '';
      try {
        const errorBody = await response.json();
        if (typeof errorBody?.message === 'string') apiMessage = errorBody.message;
      } catch { /* Keep error responses out of logs, including non-JSON bodies. */ }
      const limited = response.status === 429 || (response.status === 403 &&
        (response.headers.get('x-ratelimit-remaining') === '0' || response.headers.has('retry-after') ||
          /rate limit|abuse detection/i.test(apiMessage)));
      if (limited) {
        const retryAt = retryTime(response, now());
        throw new GitHubError('GitHub rate limit reached.' + (retryAt ? ' Retry after ' + retryAt + '.' : ' Wait before retrying.'), {status: response.status, retryAt});
      }
      const reason = response.status === 401 ? 'Check your token.' :
        response.status === 403 ? 'Access denied; check repository read permissions.' :
        response.status === 404 ? 'Repository/ref unavailable or token cannot access it.' : 'GitHub API request failed.';
      throw new GitHubError(reason + ' HTTP ' + response.status + '.', {status: response.status});
    }
    try { return await response.json(); }
    catch { throw new GitHubError('GitHub returned invalid JSON.'); }
  }
  async function collect(path, field) {
    const all = [];
    for (let page = 1; page <= 20; page++) {
      const data = await request(path + (path.includes('?') ? '&' : '?') + 'per_page=100&page=' + page);
      const rows = data[field];
      if (!Array.isArray(rows) || !Number.isInteger(data.total_count) || data.total_count < 0)
        throw new GitHubError('Unexpected GitHub list response.');
      all.push(...rows);
      if (all.length >= data.total_count) return all;
      if (!rows.length) throw new GitHubError('GitHub returned an incomplete list.');
    }
    throw new GitHubError('Pagination limit reached; refusing to report a partial result.');
  }
  const repo = await request(prefix);
  const selectedRef = ref ?? repo.default_branch;
  if (typeof selectedRef !== 'string' || !selectedRef) throw new GitHubError('Repository has no default branch; use --ref if appropriate.');
  const commit = await request(prefix + '/commits/' + encodeURIComponent(selectedRef));
  if (!/^[a-f0-9]{40,64}$/.test(commit.sha)) throw new GitHubError('GitHub returned an invalid commit SHA.');
  const sha = commit.sha;
  const checks = await collect(prefix + '/commits/' + sha + '/check-runs?filter=latest', 'check_runs');
  const statuses = await collect(prefix + '/commits/' + sha + '/status', 'statuses');
  return {
    repository: repo.full_name, url: repo.html_url, defaultBranch: repo.default_branch,
    ref: selectedRef, sha, outcome: summarize(checks, statuses),
    checks: checks.map(c => ({name:c.name, status:c.status, conclusion:c.conclusion, url:c.html_url})),
    statuses: statuses.map(s => ({context:s.context, state:s.state, url:s.target_url})),
  };
}

