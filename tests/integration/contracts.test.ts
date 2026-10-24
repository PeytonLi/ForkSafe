import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { convexTest } from 'convex-test';
import { register as registerWorkflow } from '@convex-dev/workflow/test';
import { register as registerWorkpool } from '@convex-dev/workpool/test';
import schema from '../../convex/schema';
import { api } from '../../convex/_generated/api';
import { EnvConfig, Finding, IntegrationReadiness, Investigation, Job, VendorRef } from '../../packages/contracts/src/index';
import { decodeFinding } from '../../packages/spacetimedb/client/decoders';
import { ElasticIndexer, toDocuments } from '../../packages/integrations/elastic/src/indexer';
import { createElasticClient, elasticReadiness } from '../../packages/integrations/elastic/src/config';
import { createAtlassianClients } from '../../packages/integrations/atlassian/src/config';
import { investigationLabel, syncInvestigationToJira } from '../../packages/integrations/atlassian/src/sync';

const modules = import.meta.glob('../../convex/**/*.ts');
const id = '11111111-1111-4111-8111-111111111111';
const environmentId = '22222222-2222-4222-8222-222222222222';
const token = 'hermetic-integration-test-token';
const investigation = Investigation.parse({
  id, title:'Divider contact', state:'searching',
  baselineCase:{caseId:'baseline',suite:'original',seed:0},
  baselineExperimentId:environmentId, requestedEnvironments:1, createdAtMs:1, updatedAtMs:2,
});
const findingRow = { id, investigationId:id, environmentId, kind:'behavioral_note', summary:'Divider collision', createdAtMs:10n };
const evidence = { id:1n, findingId:id, ordinal:0, kind:'log_excerpt', artifactId:environmentId, excerpt:'contact at frame 3', locatorJson:'{"frame":3}' };
const finding = decodeFinding(findingRow,[evidence]);

describe('contracts ↔ Convex lifecycle', () => {
  beforeEach(() => {
    vi.stubEnv('DAYTONA_MODE','local');
    vi.stubEnv('INTEGRATION_SHARED_SECRET',token);
    vi.stubEnv('FORKSAFE_DEV_ANONYMOUS_UI','false');
  });
  afterEach(() => vi.unstubAllEnvs());
  function backend() {
    const t = convexTest(schema,modules);
    registerWorkflow(t); registerWorkpool(t,'daytonaPool'); registerWorkpool(t,'outboxPool');
    return t;
  }
  it('creates and starts once; persisted investigation/job parse as contracts', async () => {
    const t = backend();
    const args = {title:'Integration lifecycle',requestedEnvironments:1,idempotencyKey:'integration-create-once',serviceToken:token};
    const created = await t.mutation(api.investigations.create,args);
    expect(await t.mutation(api.investigations.create,args)).toMatchObject({investigationId:created.investigationId,duplicate:true});
    const startArgs = {investigationId:created.investigationId,expectedVersion:1,serviceToken:token};
    await t.mutation(api.investigations.start,startArgs);
    expect(await t.mutation(api.investigations.start,startArgs)).toMatchObject({duplicate:true});
    const saved = await t.query(api.investigations.get,{investigationId:created.investigationId,serviceToken:token});
    expect(Investigation.parse({...saved,id:saved!.appId})).toMatchObject({state:'searching',requestedEnvironments:1});
    const jobs = await t.run(ctx => ctx.db.query('jobs').collect());
    expect(jobs).toHaveLength(1);
    expect(Job.parse({...jobs[0],id:jobs[0].appId})).toMatchObject({state:'reserved',investigationId:created.investigationId});
  });
  it('rejects invalid input and absent auth without writing anything', async () => {
    const t = backend();
    await expect(t.mutation(api.investigations.create,{title:'',idempotencyKey:'invalid-title-key',serviceToken:token})).rejects.toThrow('title_required');
    vi.stubEnv('INTEGRATION_SHARED_SECRET','');
    await expect(t.mutation(api.investigations.create,{title:'No auth',idempotencyKey:'no-auth-key'})).rejects.toThrow('unauthorized');
    expect(await t.run(ctx => ctx.db.query('investigations').collect())).toHaveLength(0);
  });
});

describe('contracts ↔ SpacetimeDB client', () => {
  it('decodes bigint timestamps and evidence into the real Finding contract', () => {
    expect(Finding.parse(finding)).toMatchObject({createdAtMs:10,evidence:[{locator:{frame:3}}]});
    expect(decodeFinding(findingRow,[]).evidence).toEqual([]);
  });
  it('rejects malformed JSON, invalid locators, and invalid contract fields', () => {
    expect(() => decodeFinding(findingRow,[{...evidence,locatorJson:'broken'}])).toThrow();
    expect(() => decodeFinding(findingRow,[{...evidence,locatorJson:'[]'}])).toThrow('JSON object');
    expect(() => decodeFinding({...findingRow,id:'invalid'},[])).toThrow();
  });
});

describe('contracts ↔ Elastic fixture', () => {
  it('indexes validated canonical documents honestly and redelivery is a noop', async () => {
    const cfg = EnvConfig.parse({ELASTIC_MODE:'fixture'});
    const ready = IntegrationReadiness.parse(elasticReadiness(cfg,1));
    expect(ready.mode).toBe('fixture');
    const indexer = new ElasticIndexer(ready.mode);
    expect(indexer.store.size).toBe(0);
    expect((await indexer.index(finding)).every(result => result.result === 'created')).toBe(true);
    expect((await indexer.index(Finding.parse(finding))).every(result => result.result === 'noop')).toBe(true);
    expect(indexer.store.size).toBe(2);
    for (const projection of indexer.store.values()) {
      expect(projection.body.sourceId).toBe(Finding.parse(finding).id);
      expect(projection.body.investigationId).toBe(finding.investigationId);
      expect(VendorRef.parse({provider:'elastic',id:projection.id}).provider).toBe('elastic');
      if (projection.body.docType === 'finding') {
        expect(Finding.parse({
          id:projection.body.sourceId,
          investigationId:projection.body.investigationId,
          environmentId:projection.body.environmentId,
          kind:projection.body.kind,
          summary:projection.body.text,
          evidence:[],
          createdAtMs:projection.body.createdAt,
        })).toMatchObject({id:finding.id,summary:finding.summary});
      }
    }
  });
  it('rejects invalid payloads and missing credentials fail closed', async () => {
    expect(() => toDocuments({})).toThrow();
    const cfg = EnvConfig.parse({ELASTIC_MODE:'cloud'});
    expect(createElasticClient(cfg)).toBeUndefined();
    await expect(new ElasticIndexer(elasticReadiness(cfg,1).mode).index(finding)).rejects.toThrow('unavailable');
  });
});

describe('contracts ↔ Atlassian fixture', () => {
  it('syncs contract investigations to one issue and preserves fixture readiness', async () => {
    const clients = createAtlassianClients({ATLASSIAN_MODE:'fixture'});
    expect(clients.mode).toBe('fixture');
    for (const row of clients.readiness) expect(IntegrationReadiness.parse(row).mode).toBe('fixture');
    expect(await clients.jira.searchJql('project = "FS"',[])).toHaveLength(0);
    const input = {operationId:environmentId,projectKey:'FS',investigation,summary:{activeEnvironments:1,findingsCount:1,candidatesCount:0}};
    const first = await syncInvestigationToJira(clients.jira,input);
    const retry = await syncInvestigationToJira(clients.jira,input);
    expect(first.created).toBe(true); expect(retry.created).toBe(false);
    expect(retry.issueKey).toBe(first.issueKey);
    expect(retry.commentAdded).toBe(false);
    expect(VendorRef.parse({provider:'jira',id:first.issueKey}).provider).toBe('jira');
    expect(Investigation.parse({...investigation,jiraIssueKey:first.issueKey}).jiraIssueKey).toBe(first.issueKey);
    expect(await clients.jira.searchJql('project = "FS" AND labels = "' + investigationLabel(id) + '"',[])).toHaveLength(1);
  });
  it('rejects invalid sync payloads and cloud calls without auth fail closed', async () => {
    const clients = createAtlassianClients({ATLASSIAN_MODE:'fixture'});
    await expect(syncInvestigationToJira(clients.jira,{} as never)).rejects.toThrow();
    const blocked = createAtlassianClients({ATLASSIAN_MODE:'cloud'});
    expect(blocked.mode).toBe('blocked');
    await expect(blocked.jira.probe()).rejects.toThrow('missing: ATLASSIAN_SITE_URL');
  });
});
