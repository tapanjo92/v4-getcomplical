#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { AuthStack } from '../lib/auth-stack';
import { StorageStack } from '../lib/storage-stack';
import { ApiComputeStackV3 } from '../lib/api-compute-stack-v3';
import { MonitoringStackV2 } from '../lib/monitoring-stack-v2';
import { SecretsStack } from '../lib/secrets-stack';
import { BillingStack } from '../lib/billing-stack';
import { StreamingStack } from '../lib/streaming-stack';
import { WafStack } from '../lib/waf-stack';
import { CdnStackV2 } from '../lib/cdn-stack-v2';
import { AnalyticsStackV2 } from '../lib/analytics-stack-v2';

const app = new cdk.App();

const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: 'ap-south-1',
};

// Independent stacks - can be deployed in any order
const secretsStack = new SecretsStack(app, 'GetComplicalSecretsStack', {
  env,
  description: 'Secrets management for GetComplical Tax API',
});

const authStack = new AuthStack(app, 'GetComplicalAuthStack', {
  env,
  description: 'Authentication infrastructure for GetComplical Tax API',
});

const storageStack = new StorageStack(app, 'GetComplicalStorageStack', {
  env,
  description: 'DynamoDB tables for tax data and API key management',
});

const streamingStack = new StreamingStack(app, 'GetComplicalStreamingStackV2', {
  env,
  description: 'Valkey cache and Kinesis Firehose for real-time usage tracking',
});

// Billing stack - needs table references but we'll update this to use SSM lookups too
const billingStack = new BillingStack(app, 'GetComplicalBillingStack', {
  env,
  apiKeysTable: storageStack.apiKeysTable,
  usageMetricsTable: storageStack.usageMetricsTable,
  stripeWebhookSecret: secretsStack.stripeWebhookSecret,
  paddleWebhookSecret: secretsStack.paddleWebhookSecret,
  description: 'Billing, usage monitoring, and payment webhook handling',
});

// Independent API stack V3 - uses SSM lookups
const apiComputeStack = new ApiComputeStackV3(app, 'GetComplicalApiComputeStackV3', {
  env,
  description: 'API Gateway v3 - Independent stack with SSM lookups',
});

// Independent Monitoring stack V2 - uses SSM lookups
const monitoringStack = new MonitoringStackV2(app, 'GetComplicalMonitoringStackV2', {
  env,
  description: 'CloudWatch monitoring with SSM lookups',
});

// WAF stack for CloudFront (must be in us-east-1)
const wafStack = new WafStack(app, 'GetComplicalWafStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: 'us-east-1',
  },
  description: 'WAF protection for GetComplical API',
  crossRegionReferences: true,
});

// Independent CDN stack V2 - uses SSM lookups
const cdnStack = new CdnStackV2(app, 'GetComplicalCdnStackV2', {
  env,
  description: 'CloudFront distribution - Independent with SSM lookups',
});

// Independent Analytics stack V2 - uses SSM lookups
const analyticsStack = new AnalyticsStackV2(app, 'GetComplicalAnalyticsStackV2', {
  env,
  description: 'Analytics and usage aggregation - Independent with SSM lookups',
});

app.synth();