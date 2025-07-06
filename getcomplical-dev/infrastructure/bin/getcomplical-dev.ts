#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { AuthStack } from '../lib/auth-stack';
import { StorageStack } from '../lib/storage-stack';
import { ApiComputeStack } from '../lib/api-compute-stack';
import { CdnStack } from '../lib/cdn-stack';
import { MonitoringStack } from '../lib/monitoring-stack';
import { WafStack } from '../lib/waf-stack-simple';

const app = new cdk.App();

const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: 'ap-south-1',
};

const authStack = new AuthStack(app, 'GetComplicalAuthStack', {
  env,
  description: 'Authentication infrastructure for GetComplical Tax API',
});

const storageStack = new StorageStack(app, 'GetComplicalStorageStack', {
  env,
  description: 'DynamoDB tables for tax data and API key management',
});

const apiComputeStack = new ApiComputeStack(app, 'GetComplicalApiComputeStack', {
  env,
  userPool: authStack.userPool,
  apiKeysTable: storageStack.apiKeysTable,
  taxDataTable: storageStack.taxDataTable,
  rateLimitTable: storageStack.rateLimitTable,
  description: 'API Gateway and Lambda functions for GetComplical',
});

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

app.synth();