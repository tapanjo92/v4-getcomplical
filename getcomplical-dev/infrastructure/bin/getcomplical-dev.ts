#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { AuthStack } from '../lib/auth-stack';
import { StorageStack } from '../lib/storage-stack';
import { ApiComputeStack } from '../lib/api-compute-stack';
import { ApiComputeStackV2 } from '../lib/api-compute-stack-v2';
import { CdnStack } from '../lib/cdn-stack';
import { MonitoringStack } from '../lib/monitoring-stack';
import { WafStack } from '../lib/waf-stack';
import { SecretsStack } from '../lib/secrets-stack';
import { BackupStack } from '../lib/backup-stack';
import { BillingStack } from '../lib/billing-stack';
import { StreamingStack } from '../lib/streaming-stack';
import { AnalyticsStack } from '../lib/analytics-stack';

const app = new cdk.App();

const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: 'ap-south-1',
};

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

// Create streaming infrastructure for high-performance tracking
const streamingStack = new StreamingStack(app, 'GetComplicalStreamingStackV2', {
  env,
  description: 'Valkey cache and Kinesis Firehose for real-time usage tracking',
});

// Create billing stack first to get the Lambda functions
const billingStack = new BillingStack(app, 'GetComplicalBillingStack', {
  env,
  apiKeysTable: storageStack.apiKeysTable,
  usageMetricsTable: storageStack.usageMetricsTable,
  stripeWebhookSecret: secretsStack.stripeWebhookSecret,
  paddleWebhookSecret: secretsStack.paddleWebhookSecret,
  description: 'Billing, usage monitoring, and payment webhook handling',
});

// Use V2 API stack with Redis and Kinesis
const apiComputeStack = new ApiComputeStackV2(app, 'GetComplicalApiComputeStack', {
  env,
  userPool: authStack.userPool,
  apiKeysTable: storageStack.apiKeysTable,
  taxDataTable: storageStack.taxDataTable,
  rateLimitTable: storageStack.rateLimitTable,
  usageMetricsTable: storageStack.usageMetricsTable,
  vpc: streamingStack.vpc,
  redisEndpoint: cdk.Fn.importValue('GetComplicalStreamingStackV2:RedisEndpoint'),
  firehoseStreamName: streamingStack.firehoseStream.ref,
  billingWebhookFunction: billingStack.billingWebhookFunction,
  usageAggregatorFunction: billingStack.usageAggregatorFunction,
  usageMonitorFunction: billingStack.usageMonitorFunction,
  description: 'API Gateway v2 with Redis caching and Kinesis streaming',
});

// Add dependency on streaming stack
apiComputeStack.addDependency(streamingStack);

// Create WAF stack for CloudFront (must be in us-east-1)
const wafStack = new WafStack(app, 'GetComplicalWafStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: 'us-east-1', // WAF for CloudFront must be in us-east-1
  },
  description: 'WAF protection for GetComplical API',
  crossRegionReferences: true, // Enable cross-region references
});

const cdnStack = new CdnStack(app, 'GetComplicalCdnStack', {
  env,
  apiGateway: apiComputeStack.api,
  webAclArn: wafStack.webAclArn, // Pass WAF Web ACL ARN to CDN stack
  description: 'CloudFront distribution for global caching',
  crossRegionReferences: true, // Enable cross-region references for WAF
});

// Add dependency to ensure WAF is created before CDN
cdnStack.addDependency(wafStack);

const monitoringStack = new MonitoringStack(app, 'GetComplicalMonitoringStack', {
  env,
  apiName: 'GetComplical Tax API',
  lambdaFunctions: [
    apiComputeStack.authorizerFunction,
    apiComputeStack.apiHandlerFunction,
    apiComputeStack.dashboardFunction,
  ],
  description: 'CloudWatch dashboards and X-Ray configuration',
});

const backupStack = new BackupStack(app, 'GetComplicalBackupStack', {
  env,
  apiKeysTable: storageStack.apiKeysTable,
  taxDataTable: storageStack.taxDataTable,
  userPool: authStack.userPool,
  description: 'Automated backup and restore for DynamoDB tables',
});

// Create analytics stack for aggregation and monitoring
const analyticsStack = new AnalyticsStack(app, 'GetComplicalAnalyticsStack', {
  env,
  analyticsBucket: streamingStack.analyticsBucket,
  firehoseStreamName: streamingStack.firehoseStream.ref,
  description: 'Real-time analytics and usage aggregation',
});

// Add dependencies
analyticsStack.addDependency(streamingStack);

app.synth();