#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { AuthStack } from '../lib/auth-stack';
import { StorageStack } from '../lib/storage-stack';
import { ApiComputeStack } from '../lib/api-compute-stack';
import { CdnStack } from '../lib/cdn-stack';
import { MonitoringStack } from '../lib/monitoring-stack';

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

const cdnStack = new CdnStack(app, 'GetComplicalCdnStack', {
  env,
  apiGateway: apiComputeStack.api,
  description: 'CloudFront distribution for global caching',
});

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