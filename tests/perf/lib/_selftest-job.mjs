// 临时自测：Job 会计闭环（不落证据，只验证 koffi 通路）
import { spawn } from 'node:child_process';
import { jobApi } from './jobobj.mjs';

const api = jobApi();
const name = `PERFCPU_SELFTEST_${process.pid}`;
const job = api.createJob(name);
console.log('job created', name, 'sizeof accounting =', 48);

const self = api.assignSelf(job);
console.log('assignSelf', self.ok, self.error?.message ?? '');

const acct0 = api.queryAccounting(job);
console.log('acct0', JSON.stringify(acct0));

// 子进程：烧 ~600ms CPU 后退出，验证 job 会计是否累计已退出子进程
const child = spawn(process.execPath, ['-e', 'const t=Date.now(); while(Date.now()-t<600){};'], { stdio: 'ignore' });
const childPid = child.pid;
await new Promise((resolve) => child.on('exit', resolve));

const acct1 = api.queryAccounting(job);
console.log('acct1', JSON.stringify(acct1));
console.log('child in job (before exit check not possible now):', 'pid', childPid);
console.log('delta totalSec', (acct1.totalSec - acct0.totalSec).toFixed(3), 'terminatedDelta', acct1.totalTerminated - acct0.totalTerminated);

// 再验证 IsProcessInJob 对活着的子进程
const child2 = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 3000);'], { stdio: 'ignore' });
await new Promise((resolve) => setTimeout(resolve, 300));
const inJob = api.isPidInJob(child2.pid);
console.log('child2 pid', child2.pid, 'inJob =', inJob);
const acct2 = api.queryAccounting(job);
console.log('acct2 activeProcesses', acct2.activeProcesses, 'totalProcesses', acct2.totalProcesses);
console.log('pidList', JSON.stringify(api.queryProcessIdList(job)));

const kill = api.terminatePid(child2.pid);
console.log('terminatePid', JSON.stringify(kill));
await new Promise((resolve) => setTimeout(resolve, 200));
const acct3 = api.queryAccounting(job);
console.log('acct3 activeProcesses', acct3.activeProcesses, 'terminated', acct3.totalTerminated);
api.closeHandle(job.handle);
console.log('ok');
