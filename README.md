# repo-checks

A small, dependency-free Node.js CLI for a read-only GitHub CI summary.

Resolve a branch or tag to one commit SHA, then inspect its latest check runs
and commit statuses. This keeps both APIs on the same commit even if the branch
moves while the command runs.

## Run from source

Requires Node.js 22 or newer. There is no npm registry release.

```sh
git clone https://github.com/joshwebtimestwo/repo-checks.git
cd repo-checks
node bin/repo-checks.mjs joshwebtimestwo/route-contract
node bin/repo-checks.mjs joshwebtimestwo/route-contract --ref main --json
```

You can also use `npm link`, then `repo-checks owner/repository`.
No dependency installation is needed to run or test this project.

The first command performs real requests to GitHub, including when checking a
public repository. It does not shell out to `gh`.

A public API run on 26 October 2026 resolved route-contract/main to
`fe9c4a24286d982b2db38630d077df1cd32a8bef` and reported four successful checks.
This is a dated example, not a promise that the branch will always pass.

## What the report means

The report includes repository URL, default branch, selected ref, resolved SHA,
check names and conclusions, status contexts and states, and links to GitHub.

- `success`: all returned checks/statuses succeeded. Neutral and skipped checks
  are treated as successful.
- `failure`: at least one check/status failed, errored, timed out, was cancelled,
  became stale or needs action.
- `pending`: some result is unfinished or unrecognized, with no known failure.
- `no-checks`: neither API returned checks or statuses. This does **not** pass.

Exit codes: `0` for success, `1` for all other report outcomes, `2` for invalid
arguments or API/network errors. Errors go to stderr; `--json` prints a report
only after all requests succeed.

This summarizes the results GitHub returns, including optional checks. It does
not evaluate branch protection, required-check policies, mergeability, deployment
health or code quality. Check results can change after the report. GitHub's own
API retention and visibility limits still apply.

## Authentication and permissions

Public repositories can be checked without a token. For private repositories or
a higher API rate limit, set `GH_TOKEN` or `GITHUB_TOKEN` in your environment.
`GH_TOKEN` takes precedence. Do not put a token in an argument, URL or contract.

For a fine-grained token, select only the repositories you need, with read
permissions for **Metadata, Contents, Checks and Commit statuses**. The tool
does not create tokens, register an OAuth application or change permissions.
Use the existing credentials available to your CI where appropriate.

All requests go to `https://api.github.com`, use GitHub's JSON media type and
API version `2022-11-28`, and reject redirects so an Authorization header cannot
be forwarded to a redirect destination. Tokens and API error bodies are not
included in reports. Reports can contain private repository/check metadata:
review them before publishing.

## Limits and failures

`--timeout 10000` controls the per-request timeout in milliseconds
(1–300000). Requests run sequentially. The tool stops on a 401, 403, 404, 429,
server error, timeout or malformed response.

Primary and secondary rate-limit errors give Retry-After/reset guidance when
GitHub supplies it. The CLI does not retry automatically or sleep until reset.
Wait until the reported time before trying again.

Both result collections are paginated, up to 20 pages of 100 items each.
An incomplete response or a page-limit overflow is an error, not a partial green
report. An empty repository without a default branch produces an error.

## JavaScript API

```js
import { inspectRepository } from './src/github.mjs';

const report = await inspectRepository('joshwebtimestwo/route-contract', {
  ref: 'main',
  token: process.env.GH_TOKEN,
  timeout: 10000,
});
console.log(report.sha, report.outcome);
```

## Development

```sh
npm test
npm run check
```

Tests inject synthetic GitHub responses; they make no live API calls.
They cover SHA pinning, ref encoding, authentication, pagination, failures on
later pages, rate limits, timeouts, malformed data, and CLI input handling.
GitHub Actions runs them on Linux/Windows with Node.js 22 and 24.

For a separate live smoke check, run the public example above.

## Support and contributions

Use [GitHub Issues](https://github.com/joshwebtimestwo/repo-checks/issues) for
bugs and questions. Include a synthetic reproduction, Node version and sanitized
error output. Remove tokens and private repository/check information.

Contributions should include a focused test and pass the two development
commands. Initial implementation was AI-assisted and locally verified.

## GitHub API references

- [Repository metadata](https://docs.github.com/en/rest/repos/repos#get-a-repository)
- [Resolve a commit](https://docs.github.com/en/rest/commits/commits#get-a-commit)
- [Check runs](https://docs.github.com/en/rest/checks/runs#list-check-runs-for-a-git-reference)
- [Combined commit status](https://docs.github.com/en/rest/commits/statuses#get-the-combined-status-for-a-specific-reference)
- [Rate limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api)

MIT licensed. Maintained by [mezy](https://mezy.gg). This is an independent
project and does not imply GitHub endorsement.

