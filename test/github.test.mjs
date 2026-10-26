import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { inspectRepository, summarize, GitHubError } from '../src/github.mjs';

const sha = 'a'.repeat(40);
const done = conclusion => ({name:'test',status:'completed',conclusion,html_url:'https://github.com/example/project/actions/runs/1'});
const json = (data, status=200, headers={}) => new Response(JSON.stringify(data), {status,headers});
function fixture({checks=[done('success')], statuses=[], handler}={}) {
  const calls=[];
  const fetchImpl=async (url,options) => {
    calls.push({url,options});
    if (handler) { const response = handler(url,options); if (response) return response; }
    if (url.endsWith('/repos/example/project')) return json({full_name:'example/project',html_url:'https://github.com/example/project',default_branch:'main'});
    if (url.includes('/commits/') && !url.includes(sha)) return json({sha});
    if (url.includes('/check-runs?')) return json({total_count:checks.length,check_runs:checks});
    if (url.includes('/status?')) return json({total_count:statuses.length,statuses});
    throw new Error('Unexpected URL: '+url);
  };
  return {calls,fetchImpl};
}

test('pins both CI APIs to the resolved SHA and uses read-only authenticated requests',async()=>{
  const f=fixture();
  const report=await inspectRepository('example/project',{ref:'feature/a b',token:'synthetic-test-token',fetchImpl:f.fetchImpl});
  assert.equal(report.sha,sha);
  assert.equal(report.outcome,'success');
  assert.equal(f.calls.length,4);
  assert.ok(f.calls[1].url.endsWith('/commits/feature%2Fa%20b'));
  assert.ok(f.calls[2].url.includes('/commits/'+sha+'/check-runs?filter=latest'));
  assert.ok(f.calls[3].url.includes('/commits/'+sha+'/status?'));
  for (const call of f.calls) {
    assert.ok(call.url.startsWith('https://api.github.com/repos/example/project'));
    assert.equal(call.options.headers.Authorization,'Bearer synthetic-test-token');
    assert.equal(call.options.redirect,'error');
    assert.equal(call.options.method,undefined);
  }
  assert.ok(!JSON.stringify(report).includes('synthetic-test-token'));
});

test('uses the default branch without authentication when no token is provided',async()=>{
  const f=fixture();
  await inspectRepository('example/project',{fetchImpl:f.fetchImpl});
  assert.ok(f.calls[1].url.endsWith('/commits/main'));
  assert.equal(f.calls[0].options.headers.Authorization,undefined);
});

test('failure takes priority over pending; empty or unknown results never pass',()=>{
  assert.equal(summarize([],[]),'no-checks');
  assert.equal(summarize([done('unknown')],[]),'pending');
  assert.equal(summarize([{status:'in_progress'}],[]),'pending');
  assert.equal(summarize([done('failure'),{status:'queued'}],[]),'failure');
  assert.equal(summarize([done('success')],[{state:'error'}]),'failure');
  assert.equal(summarize([],[{state:'pending'}]),'pending');
  assert.equal(summarize([],[{state:'success'}]),'success');
  for(const conclusion of ['success','neutral','skipped']) assert.equal(summarize([done(conclusion)],[]),'success');
  for(const conclusion of ['failure','cancelled','timed_out','action_required','startup_failure','stale']) assert.equal(summarize([done(conclusion)],[]),'failure');
});

test('does not miss a failed check on the second page',async()=>{
  const f=fixture({handler:url=>url.includes('/check-runs?') ? json({
    total_count:101, check_runs:url.includes('page=2')?[done('failure')]:Array.from({length:100},()=>done('success')),
  }):undefined});
  const report=await inspectRepository('example/project',{fetchImpl:f.fetchImpl});
  assert.equal(report.checks.length,101);
  assert.equal(report.outcome,'failure');
});

test('fetches all status pages too',async()=>{
  const f=fixture({checks:[],handler:url=>url.includes('/status?') ? json({
    total_count:101,statuses:url.includes('page=2')?[{context:'late',state:'failure'}]:Array.from({length:100},(_,i)=>({context:String(i),state:'success'})),
  }):undefined});
  const report=await inspectRepository('example/project',{fetchImpl:f.fetchImpl});
  assert.equal(report.statuses.length,101);
  assert.equal(report.outcome,'failure');
});

for(const status of [401,403,404,500]) test('reports HTTP '+status+' without leaking response bodies',async()=>{
  let calls=0;
  await assert.rejects(()=>inspectRepository('example/project',{fetchImpl:async()=>{calls++;return json({message:'sensitive response body'},status);}}),
    e=>e instanceof GitHubError && e.status===status && !e.message.includes('sensitive'));
  assert.equal(calls,1);
});

for(const status of [403,429]) test('stops on rate limit '+status+' and reports retry time',async()=>{
  let calls=0;
  await assert.rejects(()=>inspectRepository('example/project',{now:()=>0,fetchImpl:async()=>{
    calls++;return json({},status,{'retry-after':'30','x-ratelimit-remaining':'0'});
  }}),e=>e.retryAt==='1970-01-01T00:00:30.000Z');
  assert.equal(calls,1);
});

test('honors primary rate-limit reset when Retry-After is absent',async()=>{
  await assert.rejects(()=>inspectRepository('example/project',{fetchImpl:async()=>json({},403,{
    'x-ratelimit-remaining':'0','x-ratelimit-reset':'100',
  })}),e=>e.retryAt==='1970-01-01T00:01:40.000Z');
});

test('recognizes a secondary rate limit even without retry headers',async()=>{
  await assert.rejects(()=>inspectRepository('example/project',{
    fetchImpl:async()=>json({message:'You have exceeded a secondary rate limit.'},403),
  }),/rate limit reached/);
});

test('handles HTTP-date and malformed retry hints without crashing',async()=>{
  for(const [hint,expected] of [
    ['Mon, 26 Oct 2026 12:00:00 GMT','2026-10-26T12:00:00.000Z'],
    ['99999999999999999999999999',undefined],
    ['invalid',undefined],
  ]) {
    await assert.rejects(()=>inspectRepository('example/project',{
      fetchImpl:async()=>json({},429,{'retry-after':hint,'x-ratelimit-reset':'invalid'}),
    }),e=>e instanceof GitHubError && e.retryAt===expected);
  }
});

test('handles network and timeout errors without leaking underlying error text',async()=>{
  for(const error of [new Error('private-token'),new DOMException('private-token','TimeoutError')]) {
    await assert.rejects(()=>inspectRepository('example/project',{fetchImpl:async()=>{throw error;}}),
      e=>e instanceof GitHubError && !e.message.includes('private-token'));
  }
});

test('rejects malformed JSON, incomplete pagination and invalid SHAs',async()=>{
  await assert.rejects(()=>inspectRepository('example/project',{fetchImpl:async()=>new Response('{')}),/invalid JSON/);
  for(const bad of [{total_count:1,check_runs:[]},{total_count:1,check_runs:null}]) {
    const f=fixture({handler:url=>url.includes('/check-runs?')?json(bad):undefined});
    await assert.rejects(()=>inspectRepository('example/project',{fetchImpl:f.fetchImpl}),/list/);
  }
  const f=fixture({handler:url=>url.endsWith('/commits/main')?json({sha:'bad'}):undefined});
  await assert.rejects(()=>inspectRepository('example/project',{fetchImpl:f.fetchImpl}),/SHA/);
});

test('bounded pagination refuses partial green results',async()=>{
  const f=fixture({handler:url=>url.includes('/check-runs?')?json({total_count:9999,check_runs:[done('success')]}):undefined});
  await assert.rejects(()=>inspectRepository('example/project',{fetchImpl:f.fetchImpl}),/Pagination limit/);
  assert.equal(f.calls.filter(c=>c.url.includes('/check-runs?')).length,20);
});

test('rejects invalid inputs before any network request',async()=>{
  for(const repo of ['../project','example/project/extra','https://github.com/example/project','example/..']) {
    await assert.rejects(()=>inspectRepository(repo,{fetchImpl:()=>{throw Error('network should not run');}}),/owner/);
  }
  for(const options of [{timeout:0},{timeout:NaN},{ref:''}]) {
    await assert.rejects(()=>inspectRepository('example/project',{...options,fetchImpl:()=>{throw Error('network should not run');}}),TypeError);
  }
});

test('CLI help and invalid inputs do not contact GitHub',()=>{
  const cli=new URL('../bin/repo-checks.mjs',import.meta.url);
  const run=(...args)=>spawnSync(process.execPath,[fileURLToPath(cli),...args],{encoding:'utf8'});
  assert.equal(run('--help').status,0);
  assert.equal(run().status,2);
  assert.equal(run('--unknown').status,2);
  assert.equal(run('invalid').status,2);
});

