#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { inspectRepository } from '../src/github.mjs';

try {
  const {values, positionals} = parseArgs({
    allowPositionals:true,
    options:{ref:{type:'string'}, json:{type:'boolean'}, timeout:{type:'string'}, help:{type:'boolean', short:'h'}},
  });
  if (values.help) {
    console.log('Usage: repo-checks owner/repository [--ref branch|tag|SHA] [--json] [--timeout 10000]\nReads GitHub REST API only. Optional auth: GH_TOKEN or GITHUB_TOKEN.');
  } else {
    if (positionals.length !== 1) throw new Error('Specify one owner/repository. Use --help.');
    const report = await inspectRepository(positionals[0], {
      ref:values.ref, timeout:values.timeout === undefined ? 10000 : Number(values.timeout),
      token:process.env.GH_TOKEN || process.env.GITHUB_TOKEN,
    });
    if (values.json) console.log(JSON.stringify(report,null,2));
    else {
      console.log(report.repository + ' @ ' + report.sha + ': ' + report.outcome);
      for (const c of report.checks) console.log('check: ' + c.name + ' = ' + (c.conclusion ?? c.status));
      for (const s of report.statuses) console.log('status: ' + s.context + ' = ' + s.state);
    }
    process.exitCode = report.outcome === 'success' ? 0 : 1;
  }
} catch (error) {
  console.error('repo-checks: ' + error.message);
  process.exitCode = 2;
}

