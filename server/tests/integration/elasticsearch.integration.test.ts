import 'dotenv/config';
import { describe, it, before } from 'node:test';
import assert from 'node:assert';
import {
  initElasticsearch,
  indexEmail,
  searchEmails,
  esClient,
  EMAILS_INDEX,
} from '../../src/services/elasticsearch.service.js';

describe('Elasticsearch Indexing & Search - Real Cluster Integration Tests', () => {
  before(async () => {
    const initialized = await initElasticsearch();
    assert.strictEqual(initialized, true, 'Elasticsearch cluster must be connected and index created');
  });

  it('indexes emails across all lifecycle statuses and executes fuzzy multi-match queries', async () => {
    const testBatchTag = `batch_${Date.now()}`;
    const email1 = {
      id: `es_test_1_${Date.now()}`,
      recipient: `sarah.investor_${testBatchTag}@venture.cap`,
      subject: `Quarterly Outreach ${testBatchTag}`,
      body: 'Reviewing current portfolio pipeline and scheduling sync',
      status: 'SCHEDULED',
      senderEmail: 'oliver@reachinbox.test',
      scheduledAt: new Date(),
      createdAt: new Date(),
    };

    const email2 = {
      id: `es_test_2_${Date.now()}`,
      recipient: `john.partner_${testBatchTag}@enterprise.org`,
      subject: `Partnership Demo ${testBatchTag}`,
      body: 'Follow up on cold email outreach capabilities and live demo',
      status: 'SENT',
      senderEmail: 'sales@reachinbox.test',
      scheduledAt: new Date(Date.now() - 3600000),
      sentAt: new Date(),
      createdAt: new Date(Date.now() - 3600000),
    };

    // Index both emails in real Elasticsearch
    await indexEmail(email1);
    await indexEmail(email2);

    // Refresh index so newly indexed docs are searchable immediately
    await esClient.indices.refresh({ index: EMAILS_INDEX });

    // 1. Search in Scheduled tab
    const scheduledSearch = await searchEmails({
      query: testBatchTag,
      tab: 'scheduled',
      page: 1,
      limit: 10,
    });

    assert.strictEqual(scheduledSearch.source, 'elasticsearch', 'Must use real Elasticsearch cluster');
    assert.ok(scheduledSearch.data.length >= 1, 'Should find at least 1 scheduled email');
    assert.strictEqual((scheduledSearch.data[0] as any).id, email1.id);
    assert.strictEqual((scheduledSearch.data[0] as any).status, 'SCHEDULED');

    // 2. Search in Sent tab
    const sentSearch = await searchEmails({
      query: testBatchTag,
      tab: 'sent',
      page: 1,
      limit: 10,
    });

    assert.strictEqual(sentSearch.source, 'elasticsearch');
    assert.ok(sentSearch.data.length >= 1, 'Should find at least 1 sent email');
    assert.strictEqual((sentSearch.data[0] as any).id, email2.id);
    assert.strictEqual((sentSearch.data[0] as any).status, 'SENT');
  });
});
