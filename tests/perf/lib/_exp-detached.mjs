// 临时实验：detached spawn 是否 breakaway 出 job；child.pid 是否等于真实 pid
import { spawn } from 'node:child_process';
import { jobApi } from './jobobj.mjs';

const api = jobApi();
const job = api.createJob(`PERFCPU_EXP_${process.pid}`);
console.log('launcher pid', process.pid, 'assignSelf', JSON.stringify(api.assignSelf(job)));

const mk = (detached) => {
  const child = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 6000);'], {
    detached,
    windowsHide: true,
    stdio: 'ignore',
  });
  child.unref();
  return child;
};

const d = mk(true);
const n = mk(false);
console.log('spawned detached pid', d.pid, ' normal pid', n.pid);
await new Promise((r) => setTimeout(r, 800));
const list = api.queryProcessIdList(job);
const acct = api.queryAccounting(job);
console.log('job pids', JSON.stringify(list.pids), 'active', acct.activeProcesses, 'total', acct.totalProcesses);
console.log('isPidInJob detached', api.isPidInJob(d.pid), 'normal', api.isPidInJob(n.pid), 'self', api.isPidInJob(process.pid));
for (const pid of [d.pid, n.pid]) {
  const alive = (() => { try { process.kill(pid, 0); return true; } catch { return false; } })();
  console.log('pid', pid, 'alive', alive);
}
api.terminateJob(job, 0);
await new Promise((r) => setTimeout(r, 300));
console.log('after terminateJob: detached alive', (() => { try { process.kill(d.pid, 0); return true; } catch { return false; } })(), 'normal alive', (() => { try { process.kill(n.pid, 0); return true; } catch { return false; } })());
api.closeHandle(job.handle);
