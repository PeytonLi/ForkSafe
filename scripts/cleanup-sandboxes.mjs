import { env, log, main } from './lib/runtime.mjs';
import { daytonaClient, isForksafeSandbox } from './lib/sandboxes.mjs';
export { isForksafeSandbox } from './lib/sandboxes.mjs';
main(async () => {
 const client = await daytonaClient(env);
 let count = 0;
 for await (const sandbox of client.list({ labels: { 'forksafe.project': 'forksafe' } })) {
  if (!isForksafeSandbox(sandbox)) continue;
  count++;
  log((process.argv.includes('--yes') ? 'Deleting' : 'Would delete') + ' sandbox ' + sandbox.id);
  if (process.argv.includes('--yes')) {
   const fresh = await client.get(sandbox.id);
   if (!isForksafeSandbox(fresh)) throw new Error('Ownership changed; refusing deletion.');
   await client.delete(fresh, 30, true);
  }
 }
 log(count + ' ForkSafe sandbox(es). ' + (process.argv.includes('--yes') ? 'Cleanup complete.' : 'Dry-run only; use --yes to delete.'));
});
